Noop Local
========
Interactive command line interface for local development of noop apps.

## Requirements
- node
- git
- docker

## Package Install
`npm install -g noop-local`

## Local Install
```
git clone git@github.com:rearc/noop-local.git
cd noop-local
npm install
npm link
```

## Commands
#### Run the app in local development mode which auto reloads
`noop run [port] [-e componentname.ENV_KEY=Value] [--envFile .devEnv] [-e ENV_KEY=Value]`

If a `.noopEnv` file exists in the root of the application, it will automatically be read.

#### Analyze current project directory and display summary information
`noop inspect`

#### Reset state of a resource
Resources run through the Noop Dev Server persist state between runs. To clear this state run:
`noop reset <resourceName>` Example if your db resource state is corrupted because a bad version of the database was installed initially).

#### Initialize a new project
`noop init` (not implemented)

Auto-detect what we can from the repo and then interact with user to provide additional detail.

#### Create new a component
`noop add component --type service --template nodejs --name ProductSite` (not implemented)

Parameters
- name? (do components have names?)
- type (service, function, persistent?, static)
- template

#### Create a new resource for the current component
`noop add resource --type mysql --name products` (not implemented)

Parameters
- name
- type (mysql, dynamodb, s3)
