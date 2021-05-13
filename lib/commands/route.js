const discovery = require('noop-discovery')
const async = require('async')
const chalk = require('chalk')
const { pathToRegexp } = require('path-to-regexp')
const findRoot = require('./util/findRoot')

module.exports = (argv) => {
  if (!argv.method) return console.log(chalk.red('Missing operands \'method\' and \'path\''))
  if (!argv.path) return console.log(chalk.red('Missing operand \'path\''))
  const method = argv.method.toUpperCase()
  const pathArg = (argv.path[0] === '/' ? '' : '/') + argv.path
  const validMethods = new Set(['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'])
  if (!validMethods.has(method)) return console.log(chalk.red(`Invalid method '${method}'`))
  const rootArgv = argv.rootPath
  async.auto({
    rootDir: (done) => {
      findRoot(done, rootArgv)
    },
    app: ['rootDir', (results, done) => {
      console.log(`Application root found at '${results.rootDir}'`)
      discovery(results.rootDir, done)
    }],
    route: ['app', (results, done) => {
      if (!results.app.manifests.length) return done(new Error(`Didn't find any Noopfiles in '${results.rootDir}'`))
      const routes = results.app.routes.map((route) => {
        return {
          component: route.component.name,
          method: route.method.toUpperCase(),
          pattern: pathToRegexp(route.pattern.replace('*', '(.*)'))
        }
      })

      const matchingRoute = routes.find((route) => {
        if (route.method === method || route.method === 'ALL') {
          return route.pattern.test(pathArg)
        }
        return false
      })

      done(null, matchingRoute)
    }]
  }, (err, results) => {
    if (err) return console.log(chalk.red(err.message))
    if (results.route) {
      console.log('Plan for ' + chalk.cyan(`${method} ${pathArg}`) + ' routes to ' + chalk.cyan(results.route.component))
    } else {
      console.log('No route match for ' + chalk.cyan(`${method} ${pathArg}`))
    }
  })
}
