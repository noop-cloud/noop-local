const express = require('express')
const app = express()
const morgan = require('morgan')

app.use(morgan('tiny'))

const servedStatic = express.static('/content', {
  index: process.env.NOOP_STATIC_INDEX_FILE
})
app.use('/', servedStatic)
if (JSON.parse(process.env.NOOP_STATIC_SINGLE_PAGE_MODE)) app.use('*', servedStatic)

app.listen(80)
