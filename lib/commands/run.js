const discovery = require('noop-discovery')
const DevServer = require('../devServer')
const async = require('async')
const path = require('path')
const chalk = require('chalk')
const fs = require('fs')
const Inspector = require('../inspector')
const exec = require('child_process').exec
const readline = require('readline')
const findRoot = require('./util/findRoot')

module.exports = (argv) => {
  const port = argv.port
  const autoReload = !argv.disableReload
  const verbose = argv.verbose
  let selectedComponents = argv.component
  let selectedResources = argv.resource
  const rootArgv = argv.rootPath
  async.auto({
    rootDir: (done) => {
      findRoot(done, rootArgv)
    },
    app: ['rootDir', (results, done) => {
      console.log(`Application root found at '${results.rootDir}'`)
      discovery(results.rootDir, done)
    }],
    envOverrides: ['rootDir', (results, done) => {
      parseEnvOverrides(argv.env, argv.envFile, results.rootDir, done)
    }],
    devServer: ['app', 'envOverrides', (results, done) => {
      if (!results.app.manifests.length) return done(new Error(`Didn't find any Noopfiles in '${results.rootDir}'`))
      if (selectedComponents === undefined) selectedComponents = Object.keys(results.app.components)
      if (selectedResources === undefined) selectedResources = Object.keys(results.app.resources)
      const opts = {
        verbose,
        selectedComponents,
        selectedResources,
        autoReload
      }
      done(null, new DevServer(results.app, port, results.envOverrides, opts))
    }],
    inspector: ['devServer', (results, done) => {
      const inspector = new Inspector(results.devServer)
      inspector.listen((err) => {
        if (err) return done(err)
        done(null, inspector)
      })
    }],
    start: ['devServer', (results, done) => results.devServer.start(done)],
    wait: ['inspector', 'start', (results, done) => {
      const interval = setInterval(() => {}, 1000)
      console.log(chalk.green(`Your application dev server is running on https://localnoop.app:${results.devServer.port}`))
      if (process.stdin.setRawMode) {
        console.log(chalk.cyan('You can control the dev sever with the following keyboard commands:'))
        console.log(chalk.cyan('    [ i ] -> Open the inspector'))
        console.log(chalk.cyan('    [ o ] -> Open the dev server'))
        console.log(chalk.cyan('    [ r ] -> Reload the dev server'))
        console.log(chalk.cyan('    [ q ] -> Stop the dev server'))
        readline.emitKeypressEvents(process.stdin)
        process.stdin.setRawMode(true)
        process.stdin.on('keypress', (str, key) => {
          if (key.name === 'i') {
            exec(`open http://localhost:${results.inspector.port}`)
          } else if (key.name === 'o') {
            exec(`open https://localnoop.app:${results.devServer.port}`)
          } else if (key.name === 'q') {
            clearInterval(interval)
            done()
          } else if (key.name === 'r') {
            results.devServer.reload()
          }
        })
      }
    }],
    stopDevServer: ['wait', (results, done) => results.devServer.stop(done)]
  }, (err, results) => {
    if (err) return console.log(chalk.red(err.message))
    process.exit()
  })
}

const parseEnvOverrides = (statements = [], files = [], rootDir, done) => {
  const overrides = { _all: {} }
  function parseOverride (line) {
    if (!line.length) return false
    const match = /^([a-zA-Z0-9-]+)\.([a-zA-Z0-9-_]+)=(.+)$/.exec(line)
    const allMatch = /^([a-zA-Z0-9-_]+)=(.+)$/.exec(line)
    if (match) {
      if (!overrides[match[1]]) overrides[match[1]] = {}
      overrides[match[1]][match[2]] = match[3]
    } else if (allMatch) {
      overrides._all[allMatch[1]] = allMatch[2]
    } else {
      return console.log(chalk.yellow(`Invalid env override: '${line}'`))
    }
  }
  statements.forEach(parseOverride)
  async.auto({
    noopEnv: (done) => {
      const defaultFile = path.resolve(rootDir, '.noopEnv')
      fs.stat(defaultFile, (err) => {
        if (err) return done()
        console.log(`Reading default env override file ${defaultFile}`)
        fs.readFile(defaultFile, (err, data) => {
          if (err) return done(err)
          data.toString().split('\n').forEach(parseOverride)
          done()
        })
      })
    },
    files: (done) => {
      async.each(files, (file, done) => {
        const filePath = path.resolve(path.isAbsolute(file) ? rootDir : '', file)
        fs.readFile(filePath, (err, data) => {
          if (err) return done(new Error(`Unable to read override file ${filePath}`))
          data.toString().split('\n').forEach(parseOverride)
          done()
        })
      }, done)
    }
  }, (err) => done(err, overrides))
}
