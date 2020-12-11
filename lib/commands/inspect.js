const discovery = require('noop-discovery')
const async = require('async')
const chalk = require('chalk')
const findRoot = require('./util/findRoot')

module.exports = (argv) => {
  const inspectTypes = argv.type
  const rootArgv = argv.rootPath
  async.auto({
    rootDir: (done) => {
      findRoot(done, rootArgv)
    },
    app: ['rootDir', (results, done) => {
      console.log(`Application root found at '${results.rootDir}'`)
      discovery(results.rootDir, done)
    }]
  }, (err, results) => {
    if (err) return console.log(chalk.red(err.message))
    if (!results.app.manifests.length) {
      console.log(chalk.red(`Didn't find any Noopfiles in '${results.rootDir}'`))
    } else {
      const json = formatOutput(JSON.stringify(results.app, null, 2), inspectTypes)
      if (json) console.log(json)
    }
  })
}

const formatOutput = (app, inspectTypes) => {
  if (!inspectTypes.length) return app
  const filtered = JSON.parse(app)
  for (const key in filtered) {
    if (!inspectTypes.includes(key)) delete filtered[key]
  }
  if (Object.keys(filtered).length) return JSON.stringify(filtered, null, 2)
}
