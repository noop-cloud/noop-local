const express = require('express')
const app = express()
const compression = require('compression')
const morgan = require('morgan')
const expressStaticGzip = require('express-static-gzip')

app.use(compression())
app.use(morgan('tiny'))

const servedStatic = expressStaticGzip('/content', { index: process.env.NOOP_STATIC_INDEX_FILE })
app.use('/', servedStatic)
if (JSON.parse(process.env.NOOP_STATIC_SINGLE_PAGE_MODE)) app.use('*', servedStatic)

app.listen(80)
