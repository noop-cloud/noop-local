const discovery = require('noop-discovery')
const async = require('async')
const fs = require('fs')
const chalk = require('chalk')
const rimraf = require('rimraf')
const os = require('os')
const findRoot = require('./util/findRoot')

module.exports = (argv) => {
  const selectedResources = [argv.resource, ...argv._.slice(1)]
  if (!selectedResources.length) return console.log(chalk.red('Missing operand \'resource\''))
  const rootArgv = argv.rootPath
  async.auto({
    rootDir: (done) => {
      findRoot(done, rootArgv)
    },
    app: ['rootDir', (results, done) => {
      console.log(`Application root found at '${results.rootDir}'`)
      discovery(results.rootDir, done)
    }],
    clear: ['app', (results, done) => {
      if (!results.app.manifests.length) return done(new Error(`Didn't find any Noopfiles in '${results.rootDir}'`))
      selectedResources.forEach(resourceName => {
        const homeDir = os.homedir()
        const dir = `${homeDir}/.noop/apps/${results.app.id}/resources/${resourceName}`
        fs.readdir(dir, (err, files) => {
          if (err) {
            console.log(chalk.red(`Resource '${resourceName}' was not found`))
          } else if (files.length) {
            rimraf(`${dir}/*`, (err) => {
              if (err) return done(err)
            })
            console.log(`Resource state reset for '${resourceName}'`)
          } else {
            console.log(`Resource '${resourceName}' was already empty`)
          }
        })
      })
    }]
  }, (err) => {
    if (err) return console.log(chalk.red(err.message))
  })
}
