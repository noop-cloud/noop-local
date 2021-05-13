const Container = require('./container')
const Docker = require('dockerode')
const tarstream = require('tar-stream')
const tarfs = require('tar-fs')
const chalk = require('chalk')
const async = require('async')
const jsonpath = require('jsonpath')
const os = require('os')
const fs = require('fs')
const StaticBuilder = require('./staticBuilder')

const docker = new Docker({
  socketPath: '/var/run/docker.sock'
})

class ContainerBuildError extends Error {
  constructor (...args) {
    super(...args)
    this.name = 'ContainerBuildError'
  }
}

class ComponentContainer extends Container {
  constructor (component, devServer) {
    super(devServer, component.name, 'component')
    this.inspectorEnvOverrides = {}
    this.component = component
    this.buildOutput = []
    this.buildStart = null
    this.buildEnd = null
    this.dynamicParams = { resources: {} }
    if (component.type === 'task') {
      this.daemon = false
      this.autoRebuild = false
    }
    if (component.type === 'static') {
      this.contentDirectory = os.homedir() + `/.noop/apps/${devServer.app.id}/components/${component.name}/content`
      this.staticBuilder = new StaticBuilder(component, this.contentDirectory, devServer)
    }
    this.reloading = false
    this.reloadNeeded = false
    this.ig = null
    this.stats = null
  }

  getImage () {
    if (this.component.type === 'static') return 'noop/static'
    return `noop/${this.component.app.id}/component/${this.component.name}`.toLowerCase()
  }

  getEnv () {
    const env = {
      AWS_ACCESS_KEY_ID: 'ABCDEF',
      AWS_SECRET_ACCESS_KEY: '1234567890',
      AWS_REGION: 'local'
    }
    Object.keys(this.component.variables).forEach((key) => {
      env[key] = this.component.variables[key].default
    })
    Object.keys(this.devServer.envOverrides._all).forEach((key) => {
      env[key] = this.devServer.envOverrides._all[key]
    })
    if (this.devServer.envOverrides[this.component.name]) {
      Object.keys(this.devServer.envOverrides[this.component.name]).forEach((key) => {
        env[key] = this.devServer.envOverrides[this.component.name][key]
      })
    }
    Object.keys(this.inspectorEnvOverrides).forEach((key) => {
      env[key] = this.inspectorEnvOverrides[key]
    })
    Object.keys(env).filter((key) => {
      return /^\$\..+$/.test(env[key])
    }).forEach((key) => {
      let dynamicValue
      try {
        dynamicValue = jsonpath.query(this.dynamicParams, env[key])
      } catch (err) {
        console.log(chalk.yellow(`Unable to resolve dynamic value '${env[key]}'`), err)
      }
      if (dynamicValue) env[key] = dynamicValue
    })
    return env
  }

  getEnvInheritance () {
    const resolve = (source, original) => {
      if (!/^\$\..+$/.test(original)) {
        return {
          source, value: original
        }
      }
      let dynamicValue
      try {
        dynamicValue = jsonpath.query(this.dynamicParams, original)[0]
      } catch (err) {
        console.log(err)
        dynamicValue = null
      }
      return { source, value: dynamicValue, original }
    }
    // system
    const variables = {
      AWS_ACCESS_KEY_ID: [{ source: 'system', value: 'ABCDEF' }],
      AWS_SECRET_ACCESS_KEY: [{ source: 'system', value: '1234567890' }],
      AWS_REGION: [{ source: 'system', value: 'local' }]
    }
    // noopfile
    Object.keys(this.component.variables).forEach((key) => {
      if (!variables[key]) variables[key] = []
      variables[key].unshift(resolve('noopfile', this.component.variables[key].default))
    })
    // runtime-wildcard
    Object.keys(this.devServer.envOverrides._all).forEach((key) => {
      if (!variables[key]) variables[key] = []
      variables[key].unshift(resolve('runtime-wildcard', this.devServer.envOverrides._all[key]))
    })
    // runtime
    if (this.devServer.envOverrides[this.component.name]) {
      Object.keys(this.devServer.envOverrides[this.component.name]).forEach((key) => {
        if (!variables[key]) variables[key] = []
        variables[key].unshift(resolve('runtime', this.devServer.envOverrides[this.component.name][key]))
      })
    }
    // inspector
    Object.keys(this.inspectorEnvOverrides).forEach((key) => {
      if (!variables[key]) variables[key] = []
      variables[key].unshift(resolve('inspector', this.inspectorEnvOverrides[key]))
    })
    return variables
  }

  build (done) {
    if (this.component.type === 'static') {
      return this.staticBuilder.build(done)
    }
    this.buildOutput = []
    this.buildStart = new Date()
    console.log(`Building '${this.component.name}' component container...`)
    const pack = tarstream.pack()
    async.auto({
      addDockerfile: (done) => {
        pack.entry({ name: 'Dockerfile' }, this.component.dockerfile, done)
      },
      buildImage: ['addDockerfile', (results, done) => {
        tarfs.pack(this.component.rootPath, {
          ignore: (name) => this.buildIgnore(name),
          pack: pack
        })
        const buildOpts = { t: this.getImage() }
        docker.buildImage(pack, buildOpts, done)
      }],
      watch: ['buildImage', (results, done) => {
        docker.modem.followProgress(results.buildImage, done, (event) => {
          if (event.stream && /\w/.test(event.stream)) {
            let line = event.stream.trim()
            this.buildOutput.push(line)
            if (/^Step \d+\/\d+ :/.test(line)) line = chalk.cyan(line)
            console.log('   ', line.replace(/(\r\n|\r|\n)/g, '\n    '))
          }
        })
      }]
    }, (err) => {
      if (err) {
        console.log(chalk.red(`Build failed for '${this.component.name}' component container`))
        console.log('   ', err)
        done(new ContainerBuildError(err))
      } else {
        this.buildEnd = new Date()
        const duration = (this.buildEnd.getTime() - this.buildStart.getTime()) / 1000
        console.log(`Build completed for '${this.component.name}' in ${duration}s`)
        done()
      }
    })
  }

  reload (done) {
    async.doWhilst(
      (done) => {
        this.reloadNeeded = false
        if (this.component.type === 'static') {
          this.staticBuilder.build(done)
        } else {
          async.auto({
            build: async (done) => {
              async.doWhilst(
                (done) => {
                  this.reloadNeeded = false
                  this.build(done)
                },
                (...args) => {
                  args.pop()(null, this.reloadNeeded)
                },
                done
              )
            },
            stop: ['build', (results, done) => this.stop(done)],
            start: ['stop', (results, done) => this.start(done)]
          }, done)
        }
      },
      (...args) => {
        args.pop()(null, this.reloadNeeded)
      },
      done
    )
  }

  buildIgnore (file) {
    const ignoreStatus = this.devServer.watcher.checkIgnoreStatus(file)
    if (typeof ignoreStatus === 'boolean') return ignoreStatus
    const stat = fs.statSync(file)
    if (stat.isDirectory()) {
      return false
    } else {
      const watchStatus = this.devServer.watcher.checkWatchStatus(file, this.component.name)
      if (typeof watchStatus === 'boolean') return watchStatus
      return true
    }
  }

  getVolumes (done) {
    if (this.component.type !== 'static') return done(null, {})
    done(null, {
      '/content': this.contentDirectory
    })
  }
}

module.exports = ComponentContainer
