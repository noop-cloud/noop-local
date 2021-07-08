const https = require('https')
const express = require('express')
const Events = require('events')
const http = require('http')
const zlib = require('zlib')

let requestCount = 0

class Proxy extends Events.EventEmitter {
  constructor (name, routes, internal) {
    super()
    this.name = name
    this.app = express()
    this.routes = routes
    this.internal = internal
    this.init()
  }

  init () {
    this.app.use(express.json())
    this.routes.filter((route) => {
      if (this.internal) return true
      if (route.internal) return false
      return true
    }).forEach((route) => {
      this.app[route.method.toLowerCase()](route.pattern, (clientRequest, clientResponse) => {
        const startTime = new Date().getTime()
        requestCount++
        clientRequest.requestCount = requestCount
        clientRequest.id = requestCount
        clientResponse.header('X-Request-ID', clientRequest.id)
        console.log(
          `REQ #${clientRequest.requestCount}`,
          clientRequest.method,
          clientRequest.path,
          '->',
          route.componentName
        )
        if (clientRequest.secure) {
          clientRequest.headers['X-forwarded-proto'] = 'https'
        }
        this.emit('request', {
          id: clientRequest.requestCount,
          method: clientRequest.method,
          path: clientRequest.originalUrl,
          requestHeaders: clientRequest.headers,
          component: route.componentName,
          requestTime: new Date(),
          requestSize: 0,
          responseSize: 0,
          source: this.name
        })
        const options = {
          hostname: route.hostname,
          port: route.port,
          method: clientRequest.method,
          path: clientRequest.originalUrl,
          timeout: 5000,
          headers: clientRequest.headers
        }
        clientResponse.size = 0
        clientRequest.size = 0
        clientRequest.body = ''
        clientResponse.body = ''
        const serverRequest = http.request(options, (serverResponse) => {
          clientResponse.writeHead(serverResponse.statusCode, serverResponse.headers)
          this.emit('request', {
            id: clientRequest.requestCount,
            responseHeaders: serverResponse.headers,
            statusCode: serverResponse.statusCode,
            statusMessage: serverResponse.statusMessage
          })
          const gunzip = zlib.createGunzip()
          if (serverResponse.headers['content-encoding'] === 'gzip') {
            gunzip.on('data', (chunk) => {
              clientResponse.body += chunk
              this.emit('request', { id: clientRequest.requestCount, responseSize: clientResponse.size })
            })
          }
          gunzip.on('end', (chunk) => {
            logResponse()
            clientResponse.end()
            this.emit('request', {
              id: clientRequest.requestCount,
              responseBody: clientResponse.body,
              responseTime: new Date()
            })
          })
          serverResponse.on('data', (chunk) => {
            clientResponse.size += chunk.length
            clientResponse.write(chunk)
            if (serverResponse.headers['content-encoding'] === 'gzip') {
              gunzip.write(chunk)
            } else {
              clientResponse.body += chunk
              this.emit('request', { id: clientRequest.requestCount, responseSize: clientResponse.size })
            }
          })
          serverResponse.on('end', () => {
            if (serverResponse.headers['content-encoding'] === 'gzip') {
              gunzip.end()
            } else {
              logResponse()
              clientResponse.end()
              this.emit('request', {
                id: clientRequest.requestCount,
                responseBody: clientResponse.body,
                responseTime: new Date()
              })
            }
          })
        })
        serverRequest.on('error', (err) => {
          clientResponse.statusCode = 500
          clientResponse.statusMessage = 'NoopRouterError'
          clientResponse.write(`Noop router error: ${err.code}`)
          logResponse()
          clientResponse.end()
        })
        clientRequest.on('data', (chunk) => {
          clientRequest.size += chunk.length
          clientRequest.body += chunk
          serverRequest.write(chunk)
          this.emit('request', { id: clientRequest.requestCount, requestSize: clientRequest.size })
        })
        clientRequest.on('end', () => {
          serverRequest.end()
          this.emit('request', { id: clientRequest.requestCount, requestBody: clientRequest.body })
        })
        function logResponse () {
          const duration = (new Date().getTime() - startTime) + 'ms'
          clientResponse.end()
          console.log(
            `RES #${clientRequest.requestCount}`,
            duration,
            `${clientResponse.size}b`,
            clientResponse.statusCode,
            clientResponse.statusMessage
          )
        }
      })
    })
  }

  listenHttp (port) {
    this.app.listen(port)
  }

  listenHttps (port) {
    https.createServer({
      cert: process.env.CERTIFICATE_CHAIN,
      key: process.env.CERTIFICATE_KEY
    }, this.app).listen(port)
  }
}

module.exports = Proxy
