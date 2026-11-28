import { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError, planInput, publicPlan, schedulePreview, storageKeys } from './contract.js'
import { digest, openVault, token } from './security.js'

const initialStorage = Object.fromEntries(Object.values(storageKeys).flatMap(key => [[key, {}], ['use' + key, false]]))
const legacyDefault = createHash('sha512').update('admin888').digest('hex')
const executionStates = ['queued', 'running', 'completed', 'partial', 'failed', 'unknown']

export function openStore (root) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const vault = openVault(root)
  const path = join(root, 'workbench.sqlite')
  const db = new DatabaseSync(path)
  chmodSync(path, 0o600)
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON')
  db.exec(
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, hash TEXT NOT NULL, role TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL REFERENCES users(name), label TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, scope TEXT NOT NULL, created INTEGER NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL, secret TEXT NOT NULL, next INTEGER);' +
    'CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, plan TEXT NOT NULL REFERENCES plans(id), actor TEXT NOT NULL, kind TEXT NOT NULL, request TEXT, fingerprint TEXT, state TEXT NOT NULL, stage TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, detail TEXT NOT NULL, snapshot TEXT, UNIQUE(actor,request));' +
    'CREATE INDEX IF NOT EXISTS runs_queue ON runs(state,created); CREATE INDEX IF NOT EXISTS runs_plan ON runs(plan,created);' +
    'CREATE TABLE IF NOT EXISTS archives (id TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id), provider TEXT NOT NULL, object TEXT NOT NULL, digest TEXT, bytes INTEGER, encrypted INTEGER NOT NULL, availability TEXT NOT NULL, location TEXT, UNIQUE(run,provider));' +
    'CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY, archive TEXT NOT NULL REFERENCES archives(id), actor TEXT NOT NULL, expires INTEGER NOT NULL);'
  )
  const query = sql => db.prepare(sql)
  const transaction = callback => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      db.exec('COMMIT')
      return result
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  const metadata = key => query('SELECT value FROM meta WHERE key=?').get(key)?.value
  const setMetadata = (key, value) => query('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  const getStorage = () => {
    const sealed = metadata('storage')
    return sealed ? vault.open(sealed, 'storage') : structuredClone(initialStorage)
  }
  const setStorage = value => setMetadata('storage', vault.seal(value, 'storage'))
  const getNotifications = () => {
    const sealed = metadata('notifications')
    return sealed ? vault.open(sealed, 'notifications') : { enable: false }
  }
  const saveNotifications = value => setMetadata('notifications', vault.seal(value, 'notifications'))

  function unpackPlan (row) {
    if (!row) throw new AppError('not_found', 404)
    const { connection, ...data } = JSON.parse(row.data)
    const { password, ssl, archivePassword } = vault.open(row.secret, 'plan:' + row.id)
    return { ...data, id: row.id, owner: row.owner, nextAt: row.next, connection: { ...connection, password, ssl }, archivePassword }
  }
  const getPlan = planId => unpackPlan(query('SELECT * FROM plans WHERE id=?').get(planId))
  function writePlan (value) {
    const { id, owner, connection, archivePassword, nextAt, ...data } = value
    const { password, ssl, ...source } = connection
    query('INSERT INTO plans VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,secret=excluded.secret,next=excluded.next').run(
      id, owner, JSON.stringify({ ...data, connection: source }), vault.seal({ password, ssl, archivePassword }, 'plan:' + id), nextAt
    )
  }

  function migrateLegacy () {
    if (metadata('legacy-migration')) return
    let raw
    try { raw = readFileSync(join(root, 'mysql-backup-db.json'), 'utf8') } catch (err) {
      if (err.code === 'ENOENT') return
      throw new Error('Unable to read legacy mysql-backup-db.json', { cause: err })
    }
    let input
    try { input = JSON.parse(raw) } catch { throw new Error('Invalid legacy mysql-backup-db.json') }
    if (!input || !Array.isArray(input.databases) || !Array.isArray(input.users)) throw new Error('Invalid legacy mysql-backup-db.json')
    transaction(() => {
      if (metadata('legacy-migration')) return
      let skippedPlans = 0
      let skippedRuns = 0
      const now = Date.now()
      const settings = input.config?.setting
      if (settings?.ObjectStorage) setStorage(settings.ObjectStorage)
      if (settings?.SMS) saveNotifications(settings.SMS)
      const users = query('INSERT OR IGNORE INTO users VALUES(?,?,?)')
      for (const user of input.users) {
        if (typeof user?.username !== 'string' || !/^[a-f0-9]{128}$/i.test(user.password)) continue
        if (user.username === 'admin' && user.password.toLowerCase() === legacyDefault) continue
        users.run(user.username, user.password, user.isAdministrator ? 'admin' : 'operator')
      }
      const rows = new Map((input.codes ?? []).map(item => [item.uuid, item]))
      for (const legacy of input.databases) {
        const row = rows.get(legacy.uuid)
        if (typeof legacy.uuid !== 'string' || !legacy.uuid || query('SELECT id FROM plans WHERE id=?').get(legacy.uuid)) {
          skippedPlans++
          continue
        }
        const providers = [...new Set([legacy.objectStorage].flat().filter(item => Object.hasOwn(storageKeys, item)))]
        const { host, port, database, user, password, charset, ssl } = legacy.connection ?? {}
        const plan = planInput.safeParse({
          name: legacy.name || row?.name || legacy.uuid,
          serviceProvider: legacy.serviceProvider ?? row?.serviceProvider ?? undefined,
          notes: legacy.remarks ?? row?.remarks ?? undefined,
          connection: { host, port, database, user, password, charset, ssl },
          cron: legacy.cron, timezone: 'Asia/Shanghai', enabled: !row?.deletedTime, providers,
          tables: legacy.dumpOptions?.tables, excludeTables: legacy.dumpOptions?.excludeTables,
          archivePassword: legacy.encryptZipFile ? legacy.zipPassword : ''
        })
        if (!plan.success || (legacy.encryptZipFile && !plan.data.archivePassword)) {
          skippedPlans++
          continue
        }
        writePlan({
          ...plan.data, id: legacy.uuid, owner: row?.username ?? 'admin', revision: 1, updatedAt: now,
          nextAt: plan.data.enabled ? schedulePreview(plan.data.cron, plan.data.timezone, now)[0] : null
        })
      }
      for (const run of input.exec ?? []) {
        if (typeof run.execUUID !== 'string' || !query('SELECT id FROM plans WHERE id=?').get(run.uuid)) {
          skippedRuns++
          continue
        }
        const plan = getPlan(run.uuid)
        const state = run.success ? 'completed' : 'failed'
        const created = Number(run.createdTime) || now
        const snapshot = vault.seal(plan, 'run:' + run.execUUID)
        query('INSERT OR IGNORE INTO runs VALUES(?,?,?,?,NULL,NULL,?,?,?,?,?,?)').run(
          run.execUUID, run.uuid, plan.owner, 'backup', state, 'migrated', created, created,
          JSON.stringify({ imported: true, tables: Number(run.tables) || null }), snapshot
        )
        if (run.success && typeof run.objectName === 'string' && Object.hasOwn(storageKeys, run.objectStorageType)) {
          query('INSERT OR IGNORE INTO archives VALUES(?,?,?,?,NULL,?,?,?,NULL)').run(
            run.execUUID, run.execUUID, run.objectStorageType, run.objectName, Number(run.fileSize) || null,
            Number(run.objectName.endsWith('.zip')), 'archived'
          )
        }
      }
      setMetadata('legacy-migration', JSON.stringify({ importedAt: now, skippedPlans, skippedRuns }))
    })
  }

  try { migrateLegacy() } catch (err) { db.close(); throw err }
  const needsSetup = () => !query("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()
  const setupFile = join(root, 'setup-code')
  if (needsSetup()) {
    if (!metadata('setup-code')) {
      let setup
      try {
        setup = token()
        writeFileSync(setupFile, setup + '\n', { mode: 0o600, flag: 'wx' })
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        setup = readFileSync(setupFile, 'utf8').trim()
      }
      setMetadata('setup-code', digest(setup))
    }
  }
  const getUser = name => query('SELECT * FROM users WHERE name=?').get(name)
  function createAdmin (name, hash, code) {
    const user = transaction(() => {
      if (!needsSetup() || metadata('setup-code') !== digest(code)) throw new AppError('invalid_setup', 403)
      query("INSERT INTO users VALUES(?,?,'admin') ON CONFLICT(name) DO UPDATE SET hash=excluded.hash,role='admin'").run(name, hash)
      query("DELETE FROM meta WHERE key='setup-code'").run()
      return getUser(name)
    })
    try { unlinkSync(setupFile) } catch { /* The committed admin makes the code unusable. */ }
    return user
  }
  function assertPlan (actor, planId) {
    const plan = getPlan(planId)
    if (actor.role !== 'admin' && plan.owner !== actor.name) throw new AppError('not_found', 404)
    return plan
  }

  function savePlan (actor, { planId, revision, ...input }) {
    return transaction(() => {
      const previous = planId ? assertPlan(actor, planId) : null
      if (previous && revision !== previous.revision) throw new AppError('revision_conflict', 409)
      const now = Date.now()
      const plan = {
        ...input, id: previous?.id ?? randomUUID(), owner: previous?.owner ?? actor.name,
        connection: { ...input.connection, password: input.connection.password ?? previous?.connection.password ?? '',
          ssl: input.connection.ssl === undefined ? previous?.connection.ssl : input.connection.ssl },
        archivePassword: input.archivePassword ?? previous?.archivePassword ?? '',
        revision: (previous?.revision ?? 0) + 1, updatedAt: now,
        nextAt: input.enabled ? schedulePreview(input.cron, input.timezone, now)[0] : null
      }
      writePlan(plan)
      return { ...publicPlan(plan), nextAt: plan.nextAt }
    })
  }

  const archiveView = row => ({
    id: row.id, provider: row.provider, bytes: row.bytes, sha256: row.digest, encrypted: Boolean(row.encrypted), availability: row.availability
  })
  function runView (row) {
    if (!row) throw new AppError('not_found', 404)
    return {
      id: row.id, planId: row.plan, kind: row.kind, actor: row.actor, state: row.state, stage: row.stage,
      createdAt: row.created, updatedAt: row.updated, ...JSON.parse(row.detail),
      archives: query('SELECT * FROM archives WHERE run=? ORDER BY provider').all(row.id).map(archiveView)
    }
  }
  const rawRun = runId => query('SELECT * FROM runs WHERE id=?').get(runId)
  function getRun (actor, runId) {
    const row = rawRun(runId)
    if (!row) throw new AppError('not_found', 404)
    assertPlan(actor, row.plan)
    return runView(row)
  }
  function getArchive (actor, archiveId) {
    const row = query('SELECT * FROM archives WHERE id=?').get(archiveId)
    if (!row) throw new AppError('not_found', 404)
    getRun(actor, row.run)
    return row
  }

  function enqueue (actor, plan, kind, request, detail = {}) {
    const fingerprint = digest(JSON.stringify([plan.id, kind, detail.archiveId ?? null]))
    const previous = query('SELECT * FROM runs WHERE actor=? AND request=?').get(actor.name, request)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new AppError('request_mismatch', 409)
      return runView(previous)
    }
    const id = randomUUID()
    const now = Date.now()
    query('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id, plan.id, actor.name, kind, request, fingerprint, 'queued', 'queued', now, now,
      JSON.stringify(detail), vault.seal(plan, 'run:' + id)
    )
    return runView(rawRun(id))
  }

  function tick (now) {
    return transaction(() => {
      for (const row of query('SELECT * FROM plans WHERE next<=? ORDER BY next LIMIT 100').all(now)) {
        const plan = unpackPlan(row)
        if (plan.enabled) enqueue({ name: '$schedule' }, plan, 'backup', plan.id + ':' + row.next)
        // Coalesce outages into one owed execution. Subsequent ticks use the next future occurrence.
        query('UPDATE plans SET next=? WHERE id=?').run(plan.enabled ? schedulePreview(plan.cron, plan.timezone, now)[0] : null, plan.id)
      }
      query("UPDATE runs SET state='unknown',stage='interrupted' WHERE state='running' AND updated<?").run(now - 120000)
      const row = query("SELECT * FROM runs WHERE state='queued' AND plan NOT IN (SELECT plan FROM runs WHERE state='running') ORDER BY created LIMIT 1").get()
      if (!row) return null
      query("UPDATE runs SET state='running',stage='starting',updated=? WHERE id=? AND state='queued'").run(now, row.id)
      return { ...runView(rawRun(row.id)), plan: vault.open(row.snapshot, 'run:' + row.id) }
    })
  }

  return {
    close: () => db.close(), getStorage, setStorage, getNotifications, saveNotifications, needsSetup, getUser, createAdmin,
    migration: () => JSON.parse(metadata('legacy-migration') ?? 'null'),
    upgradeHash: (name, old, hash) => Boolean(query('UPDATE users SET hash=? WHERE name=? AND hash=?').run(hash, name, old).changes),
    listMembers: () => query('SELECT name,role FROM users ORDER BY name').all(),
    saveMember: (name, hash, role) => {
      if (getUser(name)?.role === 'admin' && role !== 'admin') throw new AppError('cannot_demote_admin', 409)
      query('INSERT INTO users VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET hash=excluded.hash,role=excluded.role').run(name, hash, role)
    },
    savePlan, assertPlan, getRun, getArchive,
    listPlans: actor => query('SELECT * FROM plans ORDER BY rowid DESC').all().map(unpackPlan)
      .filter(plan => actor.role === 'admin' || plan.owner === actor.name)
      .map(plan => {
        const last = query("SELECT created,state FROM runs WHERE plan=? AND kind='backup' AND state IN ('completed','partial') ORDER BY created DESC LIMIT 1").get(plan.id)
        const verified = query("SELECT updated FROM runs WHERE plan=? AND kind='restore' AND state='completed' ORDER BY updated DESC LIMIT 1").get(plan.id)
        return { ...publicPlan(plan), nextAt: plan.nextAt, lastSuccessAt: last?.created ?? null, lastVerifiedAt: verified?.updated ?? null }
      }),
    listRuns (actor, { planId, limit, before = Number.MAX_SAFE_INTEGER, beforeId, archivesOnly = false }) {
      if (planId) assertPlan(actor, planId)
      return query(
        `SELECT r.* FROM runs r JOIN plans p ON p.id=r.plan
         WHERE (?='admin' OR p.owner=?) AND (? IS NULL OR r.plan=?)
         AND (?=0 OR EXISTS (SELECT 1 FROM archives a WHERE a.run=r.id))
         AND (r.created<? OR (r.created=? AND r.id>?))
         ORDER BY r.created DESC,r.id LIMIT ?`
      ).all(actor.role, actor.name, planId ?? null, planId ?? null, Number(archivesOnly), before, before, beforeId ?? null, limit).map(runView)
    },
    enqueue: (actor, plan, kind, request, detail) => transaction(() => enqueue(actor, plan, kind, request, detail)),
    tick,
    updateRun (id, stage, detail, state = 'running') {
      if (!executionStates.includes(state)) throw new Error('Invalid run state')
      query("UPDATE runs SET stage=?,state=?,detail=?,updated=? WHERE id=? AND state='running'").run(stage, state, JSON.stringify(detail), Date.now(), id)
    },
    heartbeat: id => query("UPDATE runs SET updated=? WHERE id=? AND state='running'").run(Date.now(), id),
    recordArchive (id, run, provider, object, hash, bytes, encrypted, location) {
      query('INSERT INTO archives VALUES(?,?,?,?,?,?,?,?,?)').run(id, run, provider, object, hash, bytes, Number(encrypted), 'archived', location)
    },
    archiveSnapshot: row => vault.open(rawRun(row.run).snapshot, 'run:' + row.run),
    archiveView,
    updateAvailability: (id, state) => query('UPDATE archives SET availability=? WHERE id=?').run(state, id),
    insertTicket (actor, archive, value, expires) {
      query('DELETE FROM tickets WHERE expires<=?').run(Date.now())
      query('INSERT INTO tickets VALUES(?,?,?,?)').run(digest(value), archive, actor.name, expires)
    },
    consumeTicket: value => query('DELETE FROM tickets WHERE hash=? AND expires>? RETURNING archive,actor').get(digest(value), Date.now()),
    apiToken (name, id, label, value, scope) { query('INSERT INTO tokens VALUES(?,?,?,?,?,?)').run(id, name, label, digest(value), scope, Date.now()) },
    getToken: value => query('SELECT u.name,u.role,t.scope FROM tokens t JOIN users u ON t.name=u.name WHERE t.hash=?').get(digest(value)),
    listTokens: name => query('SELECT id,label,scope,created FROM tokens WHERE name=? ORDER BY created DESC').all(name),
    revokeToken: (name, id) => Boolean(query('DELETE FROM tokens WHERE name=? AND id=?').run(name, id).changes)
  }
}
