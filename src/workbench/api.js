import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError, connection, id, planInput, provider, providerSettings, publicPlan, publicStorage, requireInput, schedulePreview, secretFields, storageKeys } from './contract.js'
import { digest, hashPassword, token, verifyPassword } from './security.js'
import { inspectArchive } from './storage.js'
import { testConnection } from './worker.js'

const noArgs = z.strictObject({})
const credentials = z.strictObject({
  name: z.string().min(1).max(120), password: z.string().min(1).max(512)
})
const planRef = z.strictObject({ planId: id })
const runRef = z.strictObject({ runId: id })
const archiveRef = z.strictObject({ archiveId: id })
const submit = z.strictObject({ planId: id, requestId: id })
const recovery = z.strictObject({ archiveId: id, requestId: id, target: z.string().max(120) })
const listing = z.strictObject({
  planId: id.optional(), limit: z.number().int().min(1).max(100).default(30),
  before: z.number().int().positive().optional(), beforeId: id.optional(), archivesOnly: z.boolean().default(false)
})
const withRevision = z.strictObject({ planId: id.optional(), revision: z.number().int().positive().optional(), plan: planInput })
const setup = credentials.extend({ code: z.string().min(32).max(128) })
const member = credentials.extend({ role: z.enum(['admin', 'operator', 'viewer']) })
const tokenInput = z.strictObject({ label: z.string().min(1).max(100), scope: z.enum(['read', 'operate']) })
const notificationInput = z.strictObject({
  enable: z.enum(['off', 'tencent', 'submail']), appid: z.string().max(100).optional(),
  appkey: z.string().max(4096).optional(), smsSign: z.string().max(120).optional(),
  phoneNumbers: z.array(z.string().min(1).max(30)).max(100).optional(),
  action: z.array(z.enum(['success', 'failed', 'downloadReady'])).max(3).optional(),
  templateIDs: z.record(z.string().max(30), z.string().max(200)).optional()
})

export function createApi (store, { recoveryTarget, publicUrl, remote = false }) {
  const sessions = new Map()
  const attempts = new Map()
  const sessionKey = value => digest(value)
  function cleanup (state, now) {
    for (const [key, item] of state) if (item.expires < now) state.delete(key)
  }
  function openSession (user) {
    const now = Date.now()
    cleanup(sessions, now)
    if (sessions.size >= 2048) throw new AppError('session_limit', 429)
    const value = token()
    sessions.set(sessionKey(value), { name: user.name, hash: user.hash, expires: now + 3600000 })
    return { session: value, actor: { name: user.name, role: user.role }, recoveryTarget: recoveryTarget?.database ?? null }
  }
  function actorFor (value) {
    if (!value) throw new AppError('auth_required', 401)
    const key = sessionKey(value)
    const session = sessions.get(key)
    const actor = session && store.getUser(session.name)
    if (!actor || actor.hash !== session.hash || session.expires < Date.now()) {
      sessions.delete(key)
      throw new AppError('auth_required', 401)
    }
    return { name: actor.name, role: actor.role }
  }
  function limit (peer, name) {
    const now = Date.now()
    cleanup(attempts, now)
    if (attempts.size > 2048) throw new AppError('rate_limited', 429)
    for (const key of ['ip:' + peer, 'user:' + name.toLowerCase()]) {
      const item = attempts.get(key) ?? { expires: now + 60000, count: 0 }
      if (item.count >= 8) throw new AppError('rate_limited', 429)
      item.count++
      attempts.set(key, item)
    }
  }
  async function availability (actor, args, initiate) {
    const archive = store.getArchive(actor, args.archiveId)
    const result = await inspectArchive(store.getStorage(), archive, initiate)
    store.updateAvailability(archive.id, result)
    return store.archiveView({ ...archive, availability: result })
  }

  const ops = {
    status: ['read', noArgs, () => ({
      migration: store.migration(), recoveryTarget: recoveryTarget?.database ?? null, downloadAvailable: Boolean(publicUrl) || !remote
    })],
    'plans.list': ['read', noArgs, actor => store.listPlans(actor)],
    'plans.get': ['read', planRef, (actor, args) => publicPlan(store.assertPlan(actor, args.planId))],
    'plans.preview': ['operate', z.strictObject({ cron: z.string().max(100), timezone: z.string().max(100) }), (actor, args) => {
      try { return schedulePreview(args.cron, args.timezone) } catch { throw new AppError('invalid_schedule') }
    }],
    'plans.test': ['operate', z.strictObject({ planId: id.optional(), connection }), (actor, args) =>
      testConnection(args.connection, args.planId ? store.assertPlan(actor, args.planId).connection : {})],
    'plans.save': ['operate', withRevision, (actor, args) => store.savePlan(actor, { ...args.plan, planId: args.planId, revision: args.revision })],
    'plans.toggle': ['operate', z.strictObject({ planId: id, revision: z.number().int().positive(), enabled: z.boolean() }), (actor, args) => {
      const plan = store.assertPlan(actor, args.planId)
      return store.savePlan(actor, { ...plan, ...args })
    }],
    'runs.list': ['read', listing, (actor, args) => store.listRuns(actor, args)],
    'runs.get': ['read', runRef, (actor, args) => store.getRun(actor, args.runId)],
    'runs.start': ['operate', submit, (actor, args) => store.enqueue(actor, store.assertPlan(actor, args.planId), 'backup', args.requestId)],
    'archive.status': ['read', archiveRef, (actor, args) => availability(actor, args, false)],
    'archive.thaw': ['operate', archiveRef, (actor, args) => availability(actor, args, true)],
    'archive.download': ['operate', archiveRef, async (actor, args) => {
      if (remote && !publicUrl) throw new AppError('download_url_unconfigured', 409)
      const archive = await availability(actor, args, false)
      if (archive.availability !== 'ready') throw new AppError('archive_unavailable', 409)
      const grant = token()
      const expiresAt = Date.now() + 60000
      store.insertTicket(actor, archive.id, grant, expiresAt)
      return { url: (publicUrl ?? '') + '/download/' + grant, expiresAt }
    }],
    'restore.start': ['admin', recovery, async (actor, args) => {
      if (!recoveryTarget || args.target !== recoveryTarget.database) throw new AppError('recovery_target_unconfigured', 409)
      const row = store.getArchive(actor, args.archiveId)
      const run = store.getRun(actor, row.run)
      return store.enqueue(actor, store.assertPlan(actor, run.planId), 'restore', args.requestId, { archiveId: row.id, target: { database: recoveryTarget.database } })
    }],
    'storage.list': ['admin', noArgs, () => {
      const settings = store.getStorage()
      return Object.keys(storageKeys).map(type => publicStorage(settings, type))
    }],
    'storage.save': ['admin', providerSettings, (actor, args) => {
      const { provider: type, enabled, ...fields } = args
      const key = storageKeys[type]
      const current = store.getStorage()
      for (const secret of secretFields[type]) if (fields[secret] === undefined) fields[secret] = current[key]?.[secret]
      current[key] = fields
      current['use' + key] = enabled
      if (enabled && !secretFields[type].every(field => current[key][field])) throw new AppError('storage_credentials_required', 422)
      store.setStorage(current)
      return publicStorage(current, type)
    }],
    'members.list': ['admin', noArgs, () => store.listMembers()],
    'members.save': ['admin', member, async (actor, args) => {
      if (args.password.length < 12) throw new AppError('weak_password')
      store.saveMember(args.name, await hashPassword(args.password), args.role)
      return { name: args.name, role: args.role }
    }],
    'tokens.list': ['read', noArgs, actor => store.listTokens(actor.name)],
    'tokens.create': ['operate', tokenInput, (actor, args) => {
      const value = token()
      const tokenId = randomUUID()
      store.apiToken(actor.name, tokenId, args.label, value, args.scope)
      return { id: tokenId, token: value }
    }],
    'tokens.revoke': ['read', z.strictObject({ id }), (actor, args) => ({ revoked: store.revokeToken(actor.name, args.id) })],
    'notifications.get': ['admin', noArgs, () => {
      const config = store.getNotifications()
      const { appkey, ...rest } = config[config.enable] ?? {}
      return { enabled: config.enable || 'off', ...rest, hasKey: Boolean(appkey) }
    }],
    'notifications.save': ['admin', notificationInput, (actor, args) => {
      const { enable, appkey, ...fields } = args
      const current = store.getNotifications()
      if (enable === 'off') {
        current.enable = false
      } else {
        const key = appkey ?? current[enable]?.appkey
        if (!key || !fields.appid || !fields.phoneNumbers?.length || !fields.action?.length) throw new AppError('invalid_notification_configuration', 422)
        current.enable = enable
        current[enable] = { ...fields, appkey: key }
      }
      store.saveNotifications(current)
      return { enabled: current.enable || 'off' }
    }]
  }

  function invoke (op, actor, args) {
    const action = Object.hasOwn(ops, op) && ops[op]
    if (!action) throw new AppError('unknown_operation', 404)
    const [scope, schema, handler] = action
    if ((scope === 'admin' && actor.role !== 'admin') ||
      (scope !== 'read' && (actor.role === 'viewer' || actor.scope === 'read'))) throw new AppError('forbidden', 403)
    return handler(actor, requireInput(schema, args))
  }

  return {
    invoke,
    schema: op => ops[op]?.[1],
    async dispatch (input, peer) {
      const { op, args = {}, session } = requireInput(z.strictObject({
        op: z.string().max(80), args: z.unknown().optional(), session: z.string().max(128).optional()
      }), input)
      if (op === 'public.status') return { setupRequired: store.needsSetup() }
      if (op === 'setup') {
        const details = requireInput(setup, args)
        limit(peer, details.name)
        if (details.password.length < 12) throw new AppError('weak_password')
        const user = store.createAdmin(details.name, await hashPassword(details.password), details.code)
        return openSession(user)
      }
      if (op === 'session.login') {
        const { name, password } = requireInput(credentials, args)
        limit(peer, name)
        const original = store.getUser(name)
        if (!original || !await verifyPassword(password, original.hash)) throw new AppError('invalid_credentials', 401)
        let authenticatedHash = original.hash
        if (!original.hash.startsWith('scrypt:')) {
          const replacement = await hashPassword(password)
          if (store.upgradeHash(name, original.hash, replacement)) authenticatedHash = replacement
        }
        const current = store.getUser(name)
        if (!current || current.hash !== authenticatedHash) throw new AppError('invalid_credentials', 401)
        return openSession(current)
      }
      const actor = actorFor(session)
      if (op === 'session.logout') {
        sessions.delete(sessionKey(session))
        return null
      }
      return invoke(op, actor, args)
    }
  }
}

export const describeContract = () => ({
  plan: z.toJSONSchema(planInput, { target: 'draft-7', io: 'input' }),
  storage: z.toJSONSchema(providerSettings, { target: 'draft-7', io: 'input' }),
  provider: z.toJSONSchema(provider, { target: 'draft-7', io: 'input' })
})
