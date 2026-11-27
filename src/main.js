import fs from 'fs'
import path from 'path'
import { randomUUID as uuid } from 'node:crypto'
import Fastify from 'fastify'
import FastifyStatic from '@fastify/static'
import FastifySwagger from '@fastify/swagger'
import FastifySwaggerUI from '@fastify/swagger-ui'
import FastifyJWT from '@fastify/jwt'
import FastifyCORS from '@fastify/cors'
import dayjs from 'dayjs'
import db from './lib/db.js'
import auth from './lib/auth.js'
import services from './services.js'
import bootstrap from './bootstrap.js'
import restoreObject from './lib/object-storage/restore.js'
import downloadObject from './lib/object-storage/download.js'
import { deepClone } from './lib/tool.js'

const isDev = process.env.NODE_ENV ? process.env.NODE_ENV === 'development' : false

const initConfig = (config) => {
  if (config.sessionKeyCreateTime && new Date().getTime() - config.sessionKeyCreateTime > 28 * 24 * 3600 * 1000) {
    config.sessionKey = null
    config.sessionKeyCreateTime = null
  }

  if (!config.sessionKey) config.sessionKey = uuid().split('-').join('')
  if (!config.sessionKeyCreateTime) config.sessionKeyCreateTime = new Date().getTime()
  if (!config.setting) {
    const template = fs.readFileSync(path.join(import.meta.dirname, 'template', 'setting.json'), 'utf-8')
    config.setting = JSON.parse(template)
  }

  return config
}

const config = initConfig(db.data.config)
db.data.config = config
await db.write()

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
    transport: { target: 'pino-pretty' }
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
  $deepClone: deepClone,
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

await fastify.register(FastifySwagger, {
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

fastify.register(FastifyStatic, {
  root: path.join(import.meta.dirname, 'ui')
})

fastify.register(FastifySwaggerUI, { routePrefix: '/documentation' })

fastify.register(FastifyJWT, {
  secret: SYSTEM.sessionKey,
  sign: {
    algorithm: 'HS256'
  }
})

fastify.register(FastifyCORS)

for (const route of services) fastify.route(route)

const address = await fastify.listen({ port: Number(SERVER.port), host: SERVER.host })
fastify.log.warn(`Server listening on ${address}`)
if (isDev) fastify.log.debug('Run in DEV mode.')
bootstrap(db, fastify.log)
