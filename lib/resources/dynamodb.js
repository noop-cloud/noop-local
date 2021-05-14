const ResourceContainer = require('../resourceContainer')
const Container = require('../container')
const mkdirp = require('mkdirp')
const fs = require('fs')

class DynamodbContainer extends ResourceContainer {
  constructor (resource, devServer) {
    super(resource, devServer)
    this.cmd = ['-jar', 'DynamoDBLocal.jar', '-dbPath', '/db']
  }

  getImage () {
    return 'amazon/dynamodb-local:latest'
  }

  getEnv () {
    return {}
  }

  getVolumes (done) {
    const dataDir = `${this.persistenceDir}data/`
    mkdirp(dataDir)
      .then(() => done(null, {
        '/db': dataDir
      }))
      .catch(err => done(err))
  }

  setupRelationship (componentContainer, done) {
    console.log(`Creating relation from '${componentContainer.component.name}' to '${this.resource.name}'`)
    const params = {
      endpoint: `http://${this.name}:8000`,
      tableName: this.friendlyName
    }
    componentContainer.dynamicParams.resources[this.friendlyName] = params
    done(null)
  }

  start (done) {
    super.start((err) => {
      if (err) return done(err)
      fs.readdir(`${this.persistenceDir}data/`, (err, files) => {
        if (err) {
          done(err)
        } else if (!files.length) {
          const setupContainer = new Container(this.devServer, 'DynamoSetup', 'job')
          setupContainer.outputLogs = false
          setupContainer.daemon = false
          setupContainer.getImage = () => { return 'amazon/aws-cli:latest' }
          setupContainer.getEnv = () => {
            return {
              AWS_ACCESS_KEY_ID: 'ABCDEF',
              AWS_SECRET_ACCESS_KEY: '1234567890'
            }
          }
          const attributeDefinitions = [`AttributeName=${this.resource.settings.hashKeyName},AttributeType=${this.resource.settings.hashKeyType}`]
          const keySchema = [`AttributeName=${this.resource.settings.hashKeyName},KeyType=HASH`]
          if (this.resource.settings.rangeKeyName) {
            attributeDefinitions.push(`AttributeName=${this.resource.settings.rangeKeyName},AttributeType=${this.resource.settings.rangeKeyType}`)
            keySchema.push(`AttributeName=${this.resource.settings.rangeKeyName},KeyType=RANGE`)
          }
          setupContainer.cmd = ['dynamodb', 'create-table', '--endpoint-url', `http://${this.name}:8000`, '--region', 'local', '--table-name', this.friendlyName, '--attribute-definitions', ...attributeDefinitions, '--key-schema', ...keySchema, '--provisioned-throughput', 'ReadCapacityUnits=5,WriteCapacityUnits=5']
          setupContainer.start(done)
        } else {
          done()
        }
      })
    })
  }
}

module.exports = DynamodbContainer
