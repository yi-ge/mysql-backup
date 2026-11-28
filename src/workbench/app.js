import Fastify, { LogController } from 'fastify'
import FastifyStatic from '@fastify/static'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZodError } from 'zod'
import { connection, AppError } from './contract.js'
import { createApi, describeContract } from './api.js'
import { openStore } from './store.js'
import { startWorker } from './worker.js'
import { downloadArchive } from './storage.js'
import { registerMcp } from './mcp.js'

function trustedUrl (value, allowLocal) {
  if (!value) return null
  const result = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(result.hostname)
  if ((result.protocol !== 'https:' && !(allowLocal && loopback && result.protocol === 'http:')) ||
    result.username || result.password || result.search || result.hash || result.pathname !== '/') throw new Error('Invalid configured service origin')
  return result.origin
}

const identityFields = {
  proof: 'DESIRECORE_APP_RUNTIME_PROOF',
  releaseDigest: 'DESIRECORE_APP_RELEASE_DIGEST',
  scopeId: 'DESIRECORE_APP_SCOPE_ID',
  runtimeGeneration: 'DESIRECORE_APP_RUNTIME_GENERATION'
}

export async function createApplication (options = {}) {
  const env = options.env ?? process.env
  const work = resolve(options.root ?? env.APP_DATA_DIR ?? env.APP_DATA_ROOT ?? env.WORKPATH ?? 'db')
  const mountedOptions = join(work, 'console.json')
  const presentedIdentity = Object.values(identityFields).filter(key => env[key]).length
  const managed = presentedIdentity === Object.keys(identityFields).length
  if (presentedIdentity && !managed) throw new Error('Incomplete DesireCore runtime identity')
  const upstream = trustedUrl(options.upstream ?? env.MYSQL_BACKUP_UPSTREAM ??
    (existsSync(mountedOptions) ? JSON.parse(readFileSync(mountedOptions, 'utf8')).upstream : null), true)
  const publicUrl = trustedUrl(options.publicUrl ?? env.MYSQL_BACKUP_PUBLIC_URL, true)
  const app = Fastify({
    logger: options.logger ?? { level: 'warn' },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024
  })

  app.setErrorHandler((err, request, reply) => {
    const status = err instanceof AppError ? err.status : err instanceof ZodError ? 400
      : err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500
    if (status === 500) app.log.error({ requestId: request.id }, 'Unhandled workbench request')
    const code = err instanceof AppError ? err.code : status === 500 ? 'operation_failed' : 'invalid_input'
    return reply.code(status).send({ ok: false, code })
  })
  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer')
    if (request.url.startsWith('/console/') || request.url.startsWith('/download/') || request.url === '/.app-identity') {
      reply.header('cache-control', 'no-store')
    }
    done(null, payload)
  })
  const consoleMode = managed || Boolean(upstream)
  app.get('/health', async () => ({ status: 'ok', role: consoleMode ? 'console' : 'worker', ...(consoleMode && { configured: Boolean(upstream) }) }))
  app.get('/.app-identity', async () => {
    if (!managed) throw new AppError('not_found', 404)
    return Object.fromEntries(Object.entries(identityFields).map(([field, key]) => [field, env[key]]))
  })
  app.get('/api/workbench/schema', async () => describeContract())

  if (consoleMode) {
    app.post('/console/v1', async (request, reply) => {
      if (!upstream) throw new AppError('worker_unconfigured', 503)
      let result
      try {
        result = await fetch(upstream + '/console/v1', {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(request.body), redirect: 'error', signal: AbortSignal.timeout(15000)
        })
      } catch {
        throw new AppError('worker_unavailable', 502)
      }
      const content = await result.json()
      if (content.ok && request.body?.op === 'archive.download' && !/^https?:\/\//.test(content.data?.url ?? '')) {
        throw new AppError('download_url_unconfigured', 409)
      }
      return reply.code(result.status).send(content)
    })
  } else {
    const recoveryTarget = options.recoveryTarget ?? (env.MYSQL_BACKUP_RECOVERY ? connection.parse(JSON.parse(env.MYSQL_BACKUP_RECOVERY)) : null)
    const store = openStore(work)
    const api = createApi(store, { recoveryTarget, publicUrl, remote: managed })
    const stop = startWorker(store, work, {
      recoveryTarget, mysqlClient: options.mysqlClient ?? env.MYSQL_BACKUP_MYSQL_CLIENT ?? 'mysql', log: app.log
    })
    app.addHook('onClose', async () => { await stop(); store.close() })
    app.post('/console/v1', async request => ({ ok: true, data: await api.dispatch(request.body, request.ip) }))
    app.get('/download/:token', async (request, reply) => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(request.params.token)) throw new AppError('download_expired', 404)
      const ticket = store.consumeTicket(request.params.token)
      const user = ticket && store.getUser(ticket.actor)
      if (!user || user.role === 'viewer') throw new AppError('download_expired', 404)
      const archive = store.getArchive(user, ticket.archive)
      const stream = await downloadArchive(store.getStorage(), archive)
      return reply.header('content-disposition', 'attachment; filename="' + archive.id.replace(/[^A-Za-z0-9_-]/g, '_') + (archive.encrypted ? '.zip' : '.sql') + '"')
        .type('application/octet-stream').send(stream.outputStream)
    })
    registerMcp(app, store, api)
  }

  const web = options.web ?? fileURLToPath(new URL('../../dist/', import.meta.url))
  if (existsSync(join(web, 'index.html'))) {
    await app.register(FastifyStatic, { root: web })
  } else {
    app.get('/', async (request, reply) => reply.code(503).type('text/plain').send('Run npm run build to serve the backup workbench.'))
  }
  return app
}

export async function start () {
  const app = await createApplication()
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 80) })
  app.log.warn('Server listening on ' + app.listeningOrigin)
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1 }) })
  }
  return app
}
