import {
  fileURLToPath
} from 'url'
import fs from 'fs'
import path from 'path'
import Fastify from 'fastify'
import FastifyStatic from 'fastify-static'
import FastifySwagger from 'fastify-swagger'
import FastifyJWT from 'fastify-jwt'
import FastifyCORS from 'fastify-cors'
import uuid from 'uuid'
import dayjs from 'dayjs'
import db from './lib/db.js'
import auth from './lib/auth.js'
import services from './services.js'
import bootstrap from './bootstrap.js'
import restoreObject from './lib/object-storage/restore.js'
import downloadObject from './lib/object-storage/download.js'

const isDev = process.env.NODE_ENV ? process.env.NODE_ENV === 'development' : false

if (typeof (__filename) === 'undefined') {
  try {
    // eslint-disable-next-line
    global.__filename = fileURLToPath(
      import.meta.url)
  } catch (err) {
    console.error(err)
  }
}

if (typeof (__dirname) === 'undefined') {
  global.__dirname = path.dirname(__filename)
}

const initConfig = (config) => {
  if (config.sessionKeyCreateTime && new Date().getTime() - config.sessionKeyCreateTime > 28 * 24 * 3600 * 1000) {
    config.sessionKey = null
    config.sessionKeyCreateTime = null
  }

  if (!config.sessionKey) config.sessionKey = uuid.v4().split('-').join('')
  if (!config.sessionKeyCreateTime) config.sessionKeyCreateTime = new Date().getTime()
  if (!config.setting) {
    let template = fs.readFileSync(path.join(__dirname, 'template', 'setting.json'), 'utf-8')
    config.setting = JSON.parse(template)
  }

  return config
}

let config = db.get('config').value()

config = initConfig(config)

db.set('config', config).write()

// 系统配置
export const SYSTEM = {
  sessionKey: process.env.JWT_SECRET || config.sessionKey,
  scheme: [process.env.SCHEME || (isDev ? 'http' : 'https')]
}

export const SERVER = {
  port: process.env.PORT || (isDev ? '65534' : '80'), // API服务器监听的端口号
  host: process.env.HOST || (isDev ? 'localhost' : '0.0.0.0')
}

const fastify = Fastify({
  logger: {
    level: isDev ? 'debug' : 'warn',
    prettyPrint: true
  }
})

Object.assign(fastify, {
  log: fastify.log,
  $db: db,
  $auth: auth,
  $uuid: uuid,
  $moment: dayjs,
  $restoreObject: restoreObject,
  $downloadObject: downloadObject,
  /**
   * send success data
   */
  success (data, status = 1, msg) {
    return {
      status,
      msg,
      result: data
    }
  },
  /**
   * send fail data
   */
  fail (data, status = 10000, msg) {
    return {
      status,
      msg,
      result: data
    }
  }
})

fastify.register(FastifyStatic, {
  root: path.join(__dirname, 'ui')
})

fastify.register(FastifySwagger, {
  exposeRoute: true,
  routePrefix: '/documentation',
  swagger: {
    info: {
      title: 'API Documentation',
      version: '1.0.0',
      description: 'Swagger api documentation.'
    },
    externalDocs: {
      url: 'https://swagger.io',
      description: 'Find more info here'
    },
    host: SYSTEM.HOST,
    schemes: SYSTEM.SCHEME,
    consumes: ['application/json'],
    produces: ['application/json'],
    tags: [
      {
        name: 'common',
        description: '公共接口'
      },
      {
        name: 'system',
        description: '后台管理系统相关接口'
      }
    ],
    securityDefinitions: {
      JWT: {
        type: 'apiKey',
        name: 'Authorization',
        in: 'header'
      }
    }
  }
})

fastify.register(FastifyJWT, {
  secret: SYSTEM.sessionKey,
  sign: {
    algorithm: 'HS256'
  }
})

fastify.register(FastifyCORS, {
  // put your options here
})

services.map(item => fastify.route(item))

fastify.ready(err => {
  if (err) throw err
  fastify.swagger()
})

fastify.listen(SERVER.port, SERVER.host, (err, address) => {
  if (err) throw err
  fastify.log.warn(`Server listening on ${address}`)
  fastify.log.debug(`Run in DEV mode.`)
})

bootstrap(db, fastify.log)
