const expressWs = require('express-ws')
const express = require('express')
const fetch = require('node-fetch')

class DiagnosticsInterface {
  constructor (proxies) {
    this.proxies = proxies
    this.app = express()
    this.init()
  }

  init () {
    this.app.use(express.json())
    expressWs(this.app)
    this.app.ws('/_noop', (ws, req) => {
      const requestHandler = (request) => ws.send(JSON.stringify(request))
      this.proxies.forEach((proxy) => {
        proxy.addListener('request', requestHandler)
      })
      ws.on('close', () => {
        this.proxies.forEach((proxy) => {
          proxy.removeListener('request', requestHandler)
        })
      })
    })

    this.app.post('/_noop/events/localapp', (req, res) => {
      this.sendDiagnosticRequest(83, req, res)
    })

    this.app.post('/_noop/events/public', (req, res) => {
      this.sendDiagnosticRequest(84, req, res)
    })
  }

  listen (port) {
    this.app.listen(port)
  }

  sendDiagnosticRequest (port, req, res) {
    const resHeaders = {}
    let resStatusCode
    let resStatusMessage
    const { headers, method, body } = req.body
    fetch(`http://localhost:${port}${req.body.path}`, {
      headers: headers || {},
      method: method || 'GET',
      body: body ? Buffer.from(JSON.stringify(body), 'base64') : null
    })
      .then(response => {
        response.headers.forEach((value, key) => {
          resHeaders[key] = value
        })
        resStatusCode = response.status
        resStatusMessage = response.statusText
        return response.text()
      })
      .then(body => {
        res.json({
          headers: resHeaders,
          statusCode: resStatusCode,
          statusMessage: resStatusMessage,
          body: typeof body === 'string' ? Buffer.from(body).toString('base64') : body || null
        })
      })
      .catch(err => {
        res.json({
          headers: {},
          statusCode: 500,
          statusMessage: err.message,
          body: null
        })
      })
  }
}

module.exports = DiagnosticsInterface
