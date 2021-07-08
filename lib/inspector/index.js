const express = require('express')
const expressWs = require('express-ws')
const cors = require('cors')
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const fetch = require('node-fetch')

class Inspector {
  constructor (devServer) {
    this.server = devServer
    this.app = express()
    this.port = this.server.inspectorPort || this.server.port + 1
    this.init()
  }

  listen (done) {
    this.app.listen(this.port, '127.0.0.1', done)
  }

  init () {
    expressWs(this.app)
    this.app.use(express.json())
    this.app.use(cors())

    this.app.get('/api/app', (req, res) => {
      res.json({
        id: this.server.app.id,
        root: this.server.app.rootPath,
        docker: {
          network: this.server.network.id
        }
      })
    })

    this.app.get('/api/components', (req, res) => {
      const components = this.server.componentContainers.map((container) => {
        return {
          id: container.component.name,
          type: container.component.type,
          root: container.component.rootPath
        }
      })
      res.json(components)
    })

    this.app.get('/api/components/:component', (req, res) => {
      const container = this.server.componentContainers.find((container) => {
        return container.component.name === req.params.component
      })
      const output = (container.staticBuilder) ? container.staticBuilder.buildOutput : container.buildOutput
      const start = (container.staticBuilder) ? container.staticBuilder.buildStart : container.buildStart
      const end = (container.staticBuilder) ? container.staticBuilder.buildEnd : container.buildEnd
      res.json({
        id: container.component.name,
        type: container.component.type,
        root: container.component.rootPath,
        routes: container.component.routes.map((route) => {
          return {
            pattern: route.pattern,
            method: route.method,
            internal: route.internal,
            directive: route.directive
          }
        }),
        resources: container.component.resources.map((resource) => {
          return resource.name
        }),
        port: container.component.port,
        lifecycles: container.component.lifecycles,
        build: {
          output,
          start,
          end
        },
        container: {
          image: container.getImage(),
          name: container.name,
          dockerfile: container.component.dockerfile
        }
      })
    })

    this.app.get('/api/components/:component/build', (req, res) => {
      const container = this.server.componentContainers.find((container) => {
        return container.component.name === req.params.component
      })
      if (!container) return res.sendStatus(404)
      const output = (container.staticBuilder) ? container.staticBuilder.buildOutput : container.buildOutput
      const start = (container.staticBuilder) ? container.staticBuilder.buildStart : container.buildStart
      const end = (container.staticBuilder) ? container.staticBuilder.buildEnd : container.buildEnd
      res.json({
        start,
        end,
        output
      })
    })

    this.app.get('/api/components/:component/logs', (req, res) => {
      const container = this.server.componentContainers.find((container) => {
        return container.component.name === req.params.component
      })
      if (!container) return res.sendStatus(404)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write(`data: ${JSON.stringify(container.logs)}\n\n`)
      container.on('log', (log) => res.write(`data: ${JSON.stringify(log)}\n\n`))
      res.on('error', () => {})
      res.on('close', () => res.end())
    })

    this.app.get('/api/components/:component/performance', (req, res) => {
      const container = this.server.componentContainers.find((container) => {
        return container.component.name === req.params.component
      })
      if (!container) return res.sendStatus(404)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      if (container.stats) res.write(`data: ${container.stats.toString()}\n\n`)
      container.on('stats', (stats) => res.write(`data: ${stats.toString()}\n\n`))
      res.on('error', () => {})
      res.on('close', () => res.end())
    })

    this.app.get('/api/components/:component/variables', (req, res) => {
      const container = this.server.componentContainers.find((container) => {
        return container.component.name === req.params.component
      })
      if (!container) return res.sendStatus(404)
      res.json(container.getEnvInheritance())
    })

    this.app.put('/api/components/:component/variables/:key', (req, res) => {
      const key = req.params.key
      const value = req.body.value
      if (!value) return res.send(400)
      const container = this.server.componentContainers.find((container) => {
        return container.component.name === req.params.component
      })
      if (!container) return res.sendStatus(404)
      container.inspectorEnvOverrides[key] = value
      container.stop((err) => {
        if (err) console.log('Error restarting container', err)
        container.start()
      })
      res.sendStatus(200)
    })

    this.app.delete('/api/components/:component/variables/:key', (req, res) => {
      const container = this.server.componentContainers.find((container) => {
        return container.component.name === req.params.component
      })
      if (!container) return res.sendStatus(404)
      delete container.inspectorEnvOverrides[req.params.key]
      container.stop((err) => {
        if (err) console.log('Error restarting container', err)
        container.start()
      })
      res.sendStatus(200)
    })

    this.app.ws('/api/components/:component/terminal', (ws, req) => {
      const component = this.server.componentContainers.find((container) => {
        return container.component.name === req.params.component
      })
      if (!component) return ws.close(404)
      const execOpts = {
        Cmd: ['/bin/sh'],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Detach: false
      }
      component.container.exec(execOpts, (err, exec) => {
        if (err) return ws.close(4002)
        exec.start({ stdin: true }, (err, dockerStream) => {
          if (err) return ws.close(4001)
          const fauxStdout = {
            write (payload) {
              ws.send(JSON.stringify({ s: 'stdout', d: payload.toString('base64') }), () => {}, (err) => {})
            }
          }
          const fauxStderr = {
            write (payload) {
              ws.send(JSON.stringify({ s: 'stderr', d: payload.toString('base64') }), () => {})
            }
          }
          component.container.modem.demuxStream(dockerStream, fauxStdout, fauxStderr)
          dockerStream.on('end', () => {
            ws.send(JSON.stringify({ s: 'system', d: Buffer.from('\u001b[31;1mConnection to container lost!\u001b[0m').toString('base64') }), () => {})
            ws.close()
          })
          ws.on('message', (msg) => {
            let payload
            try {
              payload = JSON.parse(msg)
            } catch (err) {
              ws.close(4003, 'malformed message')
            }
            if (payload.d) {
              dockerStream.req.write(Buffer.from(payload.d, 'base64').toString('utf8'))
            } else if (payload.w && payload.h) {
              const opts = { h: payload.h, w: payload.w }
              exec.resize(opts, (err) => {
                if (err) console.log('Error resizing terminal', err)
              })
            } else {
              ws.close(4003, 'malformed message')
            }
          })
        })
      })
    })

    this.app.post('/api/components/:component/restart', (req, res) => {
      const container = this.server.componentContainers.find((container) => {
        return container.component.name === req.params.component
      })
      if (!container) return res.sendStatus(404)
      container.reload((err) => {
        if (err) return res.sendStatus(500).end()
        res.sendStatus(201)
      })
    })

    this.app.post('/api/components/:component/run', (req, res) => {
      const container = this.server.componentContainers.find((container) => {
        return container.component.name === req.params.component
      })
      if (!container) return res.sendStatus(404)
      this.server.manualTaskRun(container)
      res.sendStatus(201)
    })

    this.app.get('/api/resources', (req, res) => {
      const resources = this.server.resourceContainers.map((container) => {
        return {
          id: container.resource.name,
          type: container.resource.type,
          settings: container.resource.settings,
          container: {
            image: container.getImage(),
            name: container.name
          }
        }
      })
      res.json(resources)
    })

    this.app.get('/api/resources/:resource', (req, res) => {
      const container = this.server.resourceContainers.find((container) => {
        return container.resource.name === req.params.resource
      })
      if (!container) return res.sendStatus(404).end()
      const components = []
      this.server.componentContainers.forEach((componentContainer) => {
        componentContainer.component.resources.forEach((resourceContainer) => {
          if (resourceContainer.name === container.resource.name) components.push(componentContainer.component.name)
        })
      })
      res.json({
        id: container.resource.name,
        type: container.resource.type,
        settings: container.resource.settings,
        components,
        container: {
          image: container.getImage(),
          name: container.name
        }
      })
    })

    this.app.post('/api/resources/:resource/restart', (req, res) => {
      const container = this.server.resourceContainers.find((container) => {
        return container.resource.name === req.params.resource
      })
      if (!container) return res.sendStatus(404).end()
      container.reload((err) => {
        if (err) return res.sendStatus(500).end()
        res.sendStatus(201).end()
      })
    })

    this.app.ws('/api/changes', (ws, req) => {

    })

    this.app.get('/api/traffic', (req, res) => {
      const stateArray = Object.keys(this.server.routerInterface.state).map((id) => {
        return this.server.routerInterface.state[id]
      })
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write(`data: ${JSON.stringify(stateArray)}\n\n`)
      const handler = (message) => {
        res.write(`data: ${JSON.stringify(message)}\n\n`)
      }
      this.server.routerInterface.on('change', handler)
      res.on('close', () => this.server.routerInterface.removeListener('change', handler))
    })

    this.app.post('/api/events/public', (req, res) => {
      fetch(`http://localhost:${this.server.routerInterface.port}/_noop/events/public`, {
        method: 'post',
        body: JSON.stringify(req.body),
        headers: { 'Content-Type': 'application/json' }
      })
        .then(response => response.json())
        .then(json => res.json(json))
        .catch(err => {
          console.log(err)
          res.send(err)
        })
    })

    this.app.post('/api/server/stop', (req, res) => {
      console.log('Dev Server stopped via API...')
      this.server.stop((err) => {
        if (err) return res.send(500, err.message)
        res.sendStatus(201)
        process.exit(0)
      })
    })

    this.app.post('/api/server/restart', (req, res) => {
      console.log('Dev Server restarted via API...')
      this.server.reload((err) => {
        if (err) return res.send(500, err.message)
        res.sendStatus(201).end()
      })
    })

    this.app.post('/api/server/reset', (req, res) => {
      console.log('Dev Server reset via API...')
      const homeDir = os.homedir()
      const dir = `${homeDir}/.noop/apps/${this.server.app.id}/resources/*`
      rimraf(dir, (err) => {
        if (err) return res.send(500, err.message)
        res.sendStatus(201)
      })
    })

    this.app.use(express.static(path.join(__dirname, 'console', 'dist')))

    this.app.get('*', function (request, response) {
      response.sendFile(path.resolve(__dirname, 'console/dist/index.html'))
    })
  }
}

module.exports = Inspector
