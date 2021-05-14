const ResourceContainer = require('../resourceContainer')
const mkdirp = require('mkdirp')

const username = 'root'
const password = 'secret'

class MysqlContainer extends ResourceContainer {
  getImage () {
    if (this.resource.settings.version) {
      return `noopcloud/mysql:${this.resource.settings.version}`
    } else {
      return 'noopcloud/mysql:latest'
    }
  }

  getEnv () {
    return {
      MYSQL_ROOT_PASSWORD: password,
      MYSQL_DATABASE: this.friendlyName
    }
  }

  getVolumes (done) {
    const dataDir = `${this.persistenceDir}data/`
    mkdirp(dataDir)
      .then(() => done(null, {
        '/var/lib/mysql': dataDir
      }))
      .catch(err => done(err))
  }

  setupRelationship (componentContainer, done) {
    console.log(`Creating relation from '${componentContainer.component.name}' to '${this.resource.name}'`)
    const params = {
      host: this.name,
      username,
      password,
      database: this.friendlyName,
      url: `mysql://${username}:${password}@${this.name}/${this.friendlyName}`
    }
    componentContainer.dynamicParams.resources[this.friendlyName] = params
    done(null)
  }
}

module.exports = MysqlContainer
