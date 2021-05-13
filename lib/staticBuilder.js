const Container = require('./container')
const tarstream = require('tar-stream')
const tarfs = require('tar-fs')
const Docker = require('dockerode')
const async = require('async')
const chalk = require('chalk')
const rimraf = require('rimraf')
const mkdirp = require('mkdirp')
const path = require('path')

const docker = new Docker({
  socketPath: '/var/run/docker.sock'
})

class StaticBuildError extends Error {
  constructor (...args) {
    super(...args)
    this.name = 'StaticBuildError'
  }
}

class StaticBuilder extends Container {
  constructor (component, contentDirectory, devServer) {
    super(devServer, `${component.name}-builder`, 'component')
    this.component = component
    this.contentDirectory = contentDirectory
    this.cmd = ['/bin/sh', '-c', `cp -R ${component.settings.assetsDirectory.replace(/^\/|\/$/g, '')}/* /_content`]
    this.buildOutput = []
    this.buildStart = null
    this.buildEnd = null
    this.daemon = false
  }

  getVolumes (done) {
    done(null, {
      '/_content': this.contentDirectory
    })
  }

  getImage () {
    return 'noop/static'
  }

  build (done) {
    this.buildOutput = []
    this.buildStart = new Date()
    console.log(`Building '${this.component.name}' static component...`)
    const pack = tarstream.pack()
    async.auto({
      addDockerfile: (done) => {
        pack.entry({ name: 'Dockerfile' }, this.component.dockerfile, done)
      },
      buildImage: ['addDockerfile', (results, done) => {
        tarfs.pack(this.component.rootPath, {
          ignore: (name) => path.parse(name).base === 'Dockerfile',
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
      }],
      ensureContentDirectory: (done) => {
        mkdirp(this.contentDirectory)
          .then(() => done())
          .catch(err => done(err))
      },
      clearContentDirectory: ['watch', 'ensureContentDirectory', (results, done) => {
        rimraf(`${this.contentDirectory}/*`, done)
      }],
      extractStatic: ['clearContentDirectory', (results, done) => {
        this.start(done)
      }]
    }, (err) => {
      this.buildEnd = new Date()
      if (err) {
        console.log(chalk.red(`Build failed for '${this.component.name}' static component`))
        console.log('   ', err)
        done(new StaticBuildError(err))
      } else {
        const duration = (this.buildEnd.getTime() - this.buildStart.getTime()) / 1000
        console.log(`Static content build completed for '${this.component.name}' in ${duration}s`)
        done()
      }
    })
  }
}

module.exports = StaticBuilder
