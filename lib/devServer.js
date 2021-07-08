const async = require('async')
const Network = require('./network')
const RouterContainer = require('./routerContainer')
const RouterInterface = require('./routerInterface')
const ComponentContainer = require('./componentContainer')
const Watcher = require('./watcher')
const chalk = require('chalk')
const { schedule, validate } = require('node-cron')
const tarfs = require('tar-fs')
const path = require('path')
const Docker = require('dockerode')
const fs = require('fs')
const moment = require('moment')
const os = require('os')
const mkdirp = require('mkdirp')
const fetch = require('node-fetch')

const docker = new Docker({
  socketPath: '/var/run/docker.sock'
})
const reloadQueue = []
const taskCounter = {}

class DevServer {
  constructor (app, port, envOverrides, opts) {
    this.app = app
    this.ns = app.id
    this.port = port
    this.envOverrides = envOverrides
    this.network = new Network(`noop/app/${this.ns}`)
    this.reloading = false
    this.verbose = opts.verbose
    this.selectedComponents = opts.selectedComponents
    this.selectedResources = opts.selectedResources
    this.autoReload = opts.autoReload
    this.certificateChain = null
    this.certificateKey = null
    this.crons = []
    this.loadApp()
  }

  loadApp () {
    this.reloading = true
    this.watcher = new Watcher(this)
    this.router = new RouterContainer(this)
    this.routerInterface = new RouterInterface(this)
    this.componentContainers = Object.keys(this.app.components)
      .filter((componentName) => {
        return this.selectedComponents.includes(componentName) || !this.selectedComponents.length
      })
      .map((componentName) => {
        return new ComponentContainer(this.app.components[componentName], this)
      })
    this.resourceContainers = Object.keys(this.app.resources)
      .filter((resourceName) => this.selectedResources.includes(resourceName))
      .map((resourceName) => {
        const resource = this.app.resources[resourceName]
        let ResourceConstructor
        try {
          ResourceConstructor = require(`./resources/${resource.type}`)
        } catch (err) {
          console.log(chalk.red(`Unsupported resource type '${resource.type}'`))
          return null
        }
        return new ResourceConstructor(resource, this)
      }).filter((resource) => { return (resource) })
  }

  start (done) {
    async.auto({
      watch: (done) => this.watcher.setup(done),
      build: ['watch', (results, done) => {
        async.eachLimit(this.componentContainers, 1, (container, done) => {
          container.build(done)
        }, (err) => {
          if (err && !this.reloading) {
            this.exit()
          } else {
            done(err)
          }
        })
      }],
      network: ['watch', (results, done) => this.network.ensure(done)],
      certificate: ['watch', (results, done) => this.refreshCertificates(done)],
      buildRouter: ['build', (results, done) => this.router.build(done)],
      routerInterface: ['startRouter', 'beforeStartingServicesTasks', (results, done) => {
        this.routerInterface.start(done)
      }],
      startRouter: ['network', 'buildRouter', (results, done) => {
        this.router.start(done)
      }],
      buildStatic: ['buildRouter', (results, done) => {
        const pack = tarfs.pack(path.join(__dirname, '/static'))
        docker.buildImage(pack, { t: 'noop/static' }, (err, output) => {
          if (err) return done(err)
          docker.modem.followProgress(output, done)
        })
      }],
      startResources: ['startRouter', (results, done) => {
        async.each(this.resourceContainers, (container, done) => container.start(done), done)
      }],
      setupRelationships: ['startResources', (results, done) => {
        async.each(this.componentContainers, (container, done) => {
          async.each(container.component.resources, (resource, done) => {
            const resourceContainer = this.resourceContainers.find((resourceContainer) => {
              return (resourceContainer.resource.name === resource.name)
            })
            if (resourceContainer) {
              resourceContainer.setupRelationship(container, done)
            } else {
              done()
            }
          }, done)
        }, done)
      }],
      beforeStartingServicesTasks: ['setupRelationships', (results, done) => {
        const containers = this.componentContainers.filter((container) => {
          return (container.component.type === 'task' && container.component.settings && container.component.settings.lifecycles && container.component.settings.lifecycles.includes('beforeStartingServices'))
        })
        async.eachSeries(containers, (container, done) => {
          console.log(`Preparing beforeStartingServices task '${container.friendlyName}'`)
          if (container.name in taskCounter) {
            taskCounter[container.name]++
          } else {
            taskCounter[container.name] = 1
          }
          let counter = taskCounter[container.name]
          const countHandler = (statusCode) => {
            counter--
            if (counter <= 0) {
              container.removeListener('end', countHandler)
              taskCounter[container.name]--
              if (statusCode) {
                done(new Error(`Error running beforeStartingServices task '${container.friendlyName}'`))
              } else {
                console.log(`beforeStartingServices task '${container.friendlyName}' completed successfully`)
                done()
              }
            }
          }
          container.on('end', countHandler)
          container.start()
        }, done)
      }],
      startComponents: ['beforeStartingServicesTasks', 'buildStatic', (results, done) => {
        const containers = this.componentContainers.filter((container) => {
          return !(container.component.type === 'task')
        })
        async.each(containers, (container, done) => container.start(done), done)
      }],
      beforeTrafficDelay: ['startComponents', (results, done) => {
        setTimeout(() => done(), 1000)
      }],
      beforeTrafficTasks: ['beforeTrafficDelay', (results, done) => {
        const containers = this.componentContainers.filter((container) => {
          return (container.component.type === 'task' && container.component.settings && container.component.settings.lifecycles && container.component.settings.lifecycles.includes('beforeTraffic'))
        })
        async.eachSeries(containers, (container, done) => {
          console.log(`Preparing beforeTraffic task '${container.friendlyName}'`)
          if (container.name in taskCounter) {
            taskCounter[container.name]++
          } else {
            taskCounter[container.name] = 1
          }
          let counter = taskCounter[container.name]
          const countHandler = (statusCode) => {
            counter--
            if (counter <= 0) {
              container.removeListener('end', countHandler)
              taskCounter[container.name]--
              if (statusCode) {
                done(new Error(`Error running beforeTraffic task '${container.friendlyName}'`))
              } else {
                console.log(`beforeTraffic task '${container.friendlyName}' completed successfully`)
                done()
              }
            }
          }
          container.on('end', countHandler)
          container.start()
        }, done)
      }],
      startCronTasks: ['beforeTrafficTasks', (results, done) => {
        const containers = this.componentContainers.filter((container) => {
          return (container.component.type === 'task' && container.component.settings && container.component.settings.cron)
        })
        containers.forEach((container) => {
          console.log(`Setting cron schedule for task '${container.friendlyName}'`)
          const settings = container.component.settings.cron
          const pattern = `${settings.minute} ${settings.hour} ${settings.day} ${settings.month} ${settings.weekday}`
          if (!validate(pattern)) return done(new Error(`Invalid cron pattern for task '${container.friendlyName}'`))
          const cron = schedule(pattern, this.handleCron.bind(this, container))
          cron.container = container
          this.crons.push(cron)
        })
        this.reloading = false
        done()
      }]
    }, done)
  }

  stop (done) {
    console.log('Stopping local dev server')
    async.auto({
      stopRouter: (done) => this.router.stop(done),
      stopComponents: (done) => {
        async.each(this.componentContainers, (container, done) => container.stop(done), done)
      },
      stopResources: (done) => {
        async.each(this.resourceContainers, (container, done) => container.stop(done), done)
      },
      stopCrons: (done) => {
        async.each(this.crons, (cron, done) => this.stopCron(cron, done), done)
      }
    }, done)
  }

  exit () {
    async.auto({
      stop: (done) => this.stop(done),
      exit: ['stop', (results, done) => process.exit()]
    })
  }

  handleCron (container) {
    const time = moment().format('LTS')
    console.log(`Running task '${container.friendlyName}' on cron schedule - start: ${time}`)
    if (container.name in taskCounter) {
      taskCounter[container.name]++
    } else {
      taskCounter[container.name] = 1
    }
    let counter = taskCounter[container.name]
    const countHandler = (statusCode) => {
      counter--
      if (counter <= 0) {
        container.removeListener('end', countHandler)
        taskCounter[container.name]--
        if (statusCode) {
          console.log(chalk.red(`Error running cron task '${container.friendlyName}' - start: ${time}, end: ${moment().format('LTS')}`))
        } else {
          console.log(`Cron task '${container.friendlyName}' completed successfully - start: ${time}, end: ${moment().format('LTS')}`)
        }
      }
    }
    container.on('end', countHandler)
    container.start()
  }

  stopCron (cron, done) {
    cron.stop()
    console.log(`Removed cron schedule for '${cron.container.friendlyName}' container`)
    done()
  }

  manualTaskRun (container) {
    const time = moment().format('LTS')
    console.log(`Manually executing task '${container.friendlyName}' - start: ${time}`)
    if (container.name in taskCounter) {
      taskCounter[container.name]++
    } else {
      taskCounter[container.name] = 1
    }
    let counter = taskCounter[container.name]
    const countHandler = (statusCode) => {
      counter--
      if (counter <= 0) {
        container.removeListener('end', countHandler)
        taskCounter[container.name]--
        if (statusCode) {
          console.log(chalk.red(`Error running task '${container.friendlyName}' - start: ${time}, end: ${moment().format('LTS')}`))
        } else {
          console.log(`Task '${container.friendlyName}' completed successfully - start: ${time}, end: ${moment().format('LTS')}`)
        }
      }
    }
    container.on('end', countHandler)
    container.start()
  }

  reload (file) {
    if (!this.reloading) {
      this.reloading = true
      if (file) console.log(`Change detected in '${file}'`)
      console.log('Reloading local dev server...')
      async.auto({
        stop: (done) => this.stop(done),
        rediscover: ['stop', (results, done) => {
          this.app.reload(done)
        }],
        reloadApp: ['rediscover', (results, done) => {
          this.loadApp()
          done()
        }],
        rewatch: ['reloadApp', (results, done) => {
          this.watcher.refresh(done)
        }],
        start: ['reloadApp', (results, done) => {
          this.crons = []
          this.start(done)
        }],
        finish: ['start', (results, done) => {
          this.reloading = false
          console.log('Reload completed for local dev server')
          done()
        }]
      }, (err) => {
        if (err || this.reloading) {
          this.reloading = false
          if (err) {
            this.exit()
          }
        }
      })
    }
  }

  reloadComponent (componentName) {
    if (!this.reloading && this.autoReload) {
      const container = this.componentContainers.find((container) => {
        return (container.component.name === componentName)
      })
      if (!container || !container.autoRebuild) return false
      if (!reloadQueue.includes(componentName)) {
        reloadQueue.push(componentName)
      }
      container.reloadNeeded = true
      if (reloadQueue[0] === componentName && !container.reloading) {
        container.reloading = true
        console.log(`Change detected to '${componentName}' component. Reloading...`)
        container.reload((err) => {
          if (err) {
            console.log(chalk.red(`Error reloading component '${componentName}' container.`, err.message))
          } else {
            console.log(`Reload completed for '${componentName}' container`)
          }
          container.reloading = false
          if (!container.reloadNeeded) {
            reloadQueue.shift()
          }
          this.reloadComponent(reloadQueue[0])
        })
      } else {
        console.log(`Change detected to '${componentName}' component. Reload enqueued.`)
      }
    }
  }

  refreshCertificates (done) {
    const cacheDir = path.resolve(os.homedir(), '.noop', 'cache')
    const cacheFile = path.resolve(cacheDir, 'certificate.json')
    fs.access(cacheDir, (err) => {
      if (err) {
        try {
          mkdirp.sync(cacheDir)
        } catch (err) {
          return done(err)
        }
      }
      fetch('https://noop-local.s3.amazonaws.com/certificates/localnoop.app/latest.json')
        .then(res => {
          if (res.status > 200) return new Error(`Invalid response retrieving certificate [${res.status}]`)
          return res.json()
        })
        .then(json => {
          this.certificateChain = Buffer.from(json.chain, 'base64').toString()
          this.certificateKey = Buffer.from(json.key, 'base64').toString()
          console.log(`Caching certificate to '${cacheFile}'`)
          fs.writeFile(cacheFile, JSON.stringify(json), done)
        })
        .catch(err => {
          console.log(`Unable to refresh local certificates, using cache. ${err.message}`)
          fs.readFile(cacheFile, (err, data) => {
            if (err) return done(new Error('Error preparing local server certificates.'))
            try {
              const json = JSON.parse(data)
              this.certificateChain = Buffer.from(json.chain, 'base64').toString()
              this.certificateKey = Buffer.from(json.key, 'base64').toString()
              done()
            } catch (err) {
              done(err)
            }
          })
        })
    })
  }
}

module.exports = DevServer
