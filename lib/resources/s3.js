const ResourceContainer = require('../resourceContainer')
const mkdirp = require('mkdirp')

class S3Container extends ResourceContainer {
  constructor (resource, devServer) {
    super(resource, devServer)
    this.cmd = ['server', '/data']
  }

  getImage () {
    return 'minio/minio:latest'
  }

  getEnv () {
    return {
      MINIO_ACCESS_KEY: 'ABCDEF',
      MINIO_SECRET_KEY: '1234567890',
      MINIO_REGION_NAME: 'local',
      MINIO_BROWSER: 'off',
      MINIO_DOMAIN: this.name.toLowerCase()
    }
  }

  getVolumes (done) {
    const dataDir = `${this.persistenceDir}data/`
    mkdirp(`${dataDir}/${this.friendlyName}/`)
      .then(() => done(null, {
        '/data': dataDir
      }))
      .catch(err => done(err))
  }

  setupRelationship (componentContainer, done) {
    console.log(`Creating relation from '${componentContainer.component.name}' to '${this.resource.name}'`)
    const params = {
      endpoint: `http://${this.name}:9000`,
      bucket: this.friendlyName.toLowerCase()
    }
    componentContainer.dynamicParams.resources[this.friendlyName] = params
    done(null)
  }
}

module.exports = S3Container
