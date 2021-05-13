const ResourceContainer = require('../resourceContainer')
const mkdirp = require('mkdirp')

const username = 'postgres'
const password = 'secret'

class PostgresqlContainer extends ResourceContainer {
  getImage () {
    if (this.resource.settings.version) {
      return `noopcloud/postgres:${this.resource.settings.version}`
    } else {
      return 'noopcloud/postgres:latest'
    }
  }

  getEnv () {
    return {
      POSTGRES_USER: username,
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: this.friendlyName
    }
  }

  getVolumes (done) {
    const dataDir = `${this.persistenceDir}data/`
    mkdirp(dataDir)
      .then(() => done(null, {
        '/var/lib/postgresql/data': dataDir
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
      url: `postgresql://${username}:${password}@${this.name}/${this.friendlyName}`
    }
    componentContainer.dynamicParams.resources[this.friendlyName] = params
    done(null)
  }
}

module.exports = PostgresqlContainer
