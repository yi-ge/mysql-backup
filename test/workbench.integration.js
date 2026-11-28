import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import mysql from 'mysql2/promise.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApplication } from '../src/workbench/app.js'
import { createApi } from '../src/workbench/api.js'
import { hashPassword } from '../src/workbench/security.js'

const host = '127.0.0.1'

test('a login cannot inherit a password change made during authentication', async () => {
  const name = 'operator'
  const password = 'original-fixture-password'
  const original = { name, role: 'operator', hash: await hashPassword(password) }
  const updated = { ...original, hash: await hashPassword('new-fixture-password') }
  let calls = 0
  const api = createApi({ getUser: () => calls++ === 0 ? original : updated }, {})
  await assert.rejects(api.dispatch({ op: 'session.login', args: { name, password } }, host), { code: 'invalid_credentials' })
  assert.equal(calls, 2)
})
async function listen (server) {
  server.listen(0, host)
  await once(server, 'listening')
  return 'http://' + host + ':' + server.address().port
}

async function waitFor (fn) {
  const until = Date.now() + 30000
  do {
    const result = await fn()
    if (result) return result
    await delay(100)
  } while (Date.now() < until)
  assert.fail('Timed out waiting for a durable workbench result')
}

function archiveServer () {
  const objects = new Map()
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://example.test')
    const key = url.pathname
    if (request.method === 'PUT') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      objects.set(key, { bytes: Buffer.concat(chunks), thawed: false })
      return response.writeHead(200, { etag: '"fixture"' }).end()
    }
    const item = objects.get(key)
    if (!item) return response.writeHead(404).end()
    if (request.method === 'HEAD') return response.writeHead(200, {
      'x-oss-storage-class': 'Archive', ...(item.thawed && { 'x-oss-restore': 'ongoing-request="false", expiry-date="Fri, 01 Jan 2038 00:00:00 GMT"' })
    }).end()
    if (request.method === 'POST' && url.searchParams.has('restore')) {
      item.thawed = true
      return response.writeHead(202).end()
    }
    if (request.method === 'GET' && item.thawed) return response.writeHead(200, { 'content-length': item.bytes.length }).end(item.bytes)
    return response.writeHead(409).end()
  })
}

test('migrated workbench runs a scheduled AES backup and a scoped recovery drill', { timeout: 90000 }, async t => {
  const port = Number(process.env.MYSQL_TEST_PORT)
  assert.ok(Number.isInteger(port) && port > 0, 'MYSQL_TEST_PORT is required for the isolated test')
  const db = await mysql.createConnection({
    host, port, user: process.env.MYSQL_TEST_USER || 'root', password: process.env.MYSQL_TEST_PASSWORD || '', multipleStatements: true
  })
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const origin = 'wb_source_' + suffix
  const target = 'wb_restore_' + suffix
  const sourceUser = 'wb_s_' + suffix
  const targetUser = 'wb_r_' + suffix
  const sourcePassword = 'source-secret-' + suffix
  const targetPassword = 'target-secret-' + suffix
  const [[logging]] = await db.query('SELECT @@GLOBAL.log_bin AS enabled, @@GLOBAL.log_bin_trust_function_creators AS trusted')
  await db.query('CREATE DATABASE ?? CHARACTER SET utf8mb4; CREATE DATABASE ?? CHARACTER SET utf8mb4', [origin, target])
  await db.query("CREATE USER ?@'%' IDENTIFIED BY ?; CREATE USER ?@'%' IDENTIFIED BY ?", [sourceUser, sourcePassword, targetUser, targetPassword])
  await db.query("GRANT SELECT, SHOW VIEW, TRIGGER ON ??.* TO ?@'%'; GRANT ALL PRIVILEGES ON ??.* TO ?@'%'", [origin, sourceUser, target, targetUser])
  await db.query(
    'USE ??; CREATE TABLE ledger(id INT PRIMARY KEY, label VARCHAR(40), bytes BLOB); CREATE TABLE journal(id INT PRIMARY KEY); ' +
    "INSERT INTO ledger VALUES(1,'订单😀',0x0027ff); CREATE VIEW ledger_view AS SELECT label FROM ledger; " +
    'CREATE TRIGGER ledger_trigger AFTER INSERT ON ledger FOR EACH ROW INSERT INTO journal VALUES(NEW.id);', [origin]
  )
  t.after(async () => {
    try {
      if (logging.enabled && !logging.trusted) await db.query('SET GLOBAL log_bin_trust_function_creators=0')
      await db.query("DROP DATABASE IF EXISTS ??; DROP DATABASE IF EXISTS ??; DROP USER IF EXISTS ?@'%'; DROP USER IF EXISTS ?@'%'", [origin, target, sourceUser, targetUser])
    } finally { await db.end() }
  })

  const oss = archiveServer()
  const endpoint = await listen(oss)
  t.after(() => new Promise(resolve => { oss.close(resolve); oss.closeAllConnections() }))
  const root = await mkdtemp(join(tmpdir(), 'workbench-check-'))
  const username = 'legacy-admin'
  const password = 'legacy-admin-password-' + suffix
  const archivePassword = 'zip-password-' + suffix
  const planId = randomUUID()
  const legacy = JSON.stringify({
    config: { setting: { ObjectStorage: {
      useOSS: true, OSS: { endpoint, cname: true, bucket: 'known-archive', accessKeyId: 'test-id', accessKeySecret: 'test-key' }
    } } },
    users: [{ username, password: createHash('sha512').update(password).digest('hex'), isAdministrator: true }],
    databases: [{
      uuid: planId, name: '订单备份', cron: '*/1 * * * * *', encryptZipFile: true, zipPassword: archivePassword, objectStorage: 'oss',
      connection: { host, port, user: sourceUser, database: origin, password: sourcePassword, charset: 'UTF8_GENERAL_CI' },
      dumpOptions: { tables: [], excludeTables: false }
    }],
    codes: [{ uuid: planId, username, serviceProvider: 'fixture host', remarks: 'legacy operator notes', code: "throw new Error('must not execute')" }], exec: []
  })
  const legacyPath = join(root, 'mysql-backup-db.json')
  await writeFile(legacyPath, legacy, { mode: 0o600 })
  const options = {
    root, logger: false, mysqlClient: process.env.MYSQL_TEST_CLIENT ?? 'mysql',
    recoveryTarget: { host, port, database: target, user: targetUser, password: targetPassword }
  }
  let app = await createApplication(options)
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  let address = await app.listen({ host, port: 0 })
  let session
  async function api (op, args = {}, expected = 200) {
    const response = await fetch(address + '/console/v1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, args, session })
    })
    const json = await response.json()
    assert.equal(response.status, expected, JSON.stringify(json))
    return json.data ?? json
  }

  assert.equal((await fetch(address)).status, 200)
  assert.equal((await api('public.status')).setupRequired, false)
  session = (await api('session.login', { name: username, password })).session
  const status = await api('status')
  assert.equal(status.migration.skippedPlans, 0)
  assert.equal(status.recoveryTarget, target)
  const [plan] = await api('plans.list')
  assert.equal(plan.id, planId)
  assert.equal(plan.encrypted, true)
  assert.equal(plan.hasPassword, true)
  assert.equal(plan.serviceProvider, 'fixture host')
  assert.equal(plan.notes, 'legacy operator notes')
  assert.ok(!JSON.stringify(plan).includes(sourcePassword))
  assert.ok(!JSON.stringify(plan).includes(archivePassword))
  assert.equal(await readFile(legacyPath, 'utf8'), legacy)

  const scheduled = await waitFor(async () => (await api('runs.list')).find(run => run.actor === '$schedule' && run.state === 'completed'))
  assert.equal(scheduled.archives.length, 1)
  assert.equal(scheduled.archives[0].encrypted, true)
  const archiveId = scheduled.archives[0].id
  await api('plans.toggle', { planId, revision: plan.revision, enabled: false })
  assert.equal((await api('archive.status', { archiveId })).availability, 'archived')
  await api('archive.thaw', { archiveId })
  assert.equal((await api('archive.status', { archiveId })).availability, 'ready')

  const link = await api('archive.download', { archiveId })
  assert.equal((await fetch(address + link.url)).status, 200)
  assert.equal((await fetch(address + link.url)).status, 404)

  async function awaitTerminal (runId) {
    return waitFor(async () => {
      const run = await api('runs.get', { runId })
      return ['completed', 'failed'].includes(run.state) && run
    })
  }

  if (logging.enabled && !logging.trusted) {
    const restricted = await api('restore.start', { archiveId, target, requestId: randomUUID() })
    const failed = await awaitTerminal(restricted.id)
    assert.equal(failed.reason, 'recovery_binlog_policy')
    assert.equal(failed.targetMayContainData, true)
    // Only the isolated fixture changes global policy. The app always uses the scoped account.
    await db.query('DROP DATABASE ??; CREATE DATABASE ?? CHARACTER SET utf8mb4; SET GLOBAL log_bin_trust_function_creators=1', [target, target])
  }
  const restore = { archiveId, target, requestId: randomUUID() }
  const recovery = await api('restore.start', restore)
  assert.equal((await api('restore.start', restore)).id, recovery.id)
  const finished = await awaitTerminal(recovery.id)
  assert.equal(finished.state, 'completed', JSON.stringify(finished))
  assert.equal(finished.matchedOriginalChecksum, true)
  const [[entry]] = await db.query('SELECT label, HEX(bytes) AS bytes FROM ??.ledger WHERE id=1', [target])
  assert.equal(entry.label, '订单😀')
  assert.equal(entry.bytes, '0027FF')
  await db.query("INSERT INTO ??.ledger VALUES (2,'触发器',0x01)", [target])
  const [[trigger]] = await db.query('SELECT id FROM ??.journal WHERE id=2', [target])
  assert.equal(trigger.id, 2)
  const [[view]] = await db.query('SELECT label FROM ??.ledger_view', [target])
  assert.equal(view.label, '订单😀')
  const retry = await api('restore.start', { ...restore, requestId: randomUUID() })
  const refused = await awaitTerminal(retry.id)
  assert.equal(refused.reason, 'recovery_target_not_empty')
  assert.equal(refused.state, 'failed')
  const [[unchanged]] = await db.query('SELECT COUNT(*) AS count FROM ??.ledger', [target])
  assert.equal(unchanged.count, 2)

  const generated = await api('tokens.create', { label: '测试只读 Agent', scope: 'read' })
  const mcp = new Client({ name: 'test-backup-agent', version: '1.0.0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(address + '/mcp'), {
    requestInit: { headers: { authorization: 'Bearer ' + generated.token } }
  }))
  const offered = await mcp.listTools()
  assert.ok(offered.tools.some(tool => tool.name === 'get_backup_run'))
  assert.ok(!offered.tools.some(tool => tool.name === 'start_backup'))
  const read = await mcp.callTool({ name: 'get_backup_run', arguments: { runId: recovery.id } })
  assert.equal(read.isError, undefined)
  assert.equal(read.structuredContent.result.id, recovery.id)
  await mcp.close()
  await api('tokens.revoke', { id: generated.id })
  assert.equal((await fetch(address + '/mcp', { headers: { authorization: 'Bearer ' + generated.token } })).status, 401)

  await app.close()
  app = await createApplication(options)
  address = await app.listen({ host, port: 0 })
  session = (await api('session.login', { name: username, password })).session
  assert.equal((await api('runs.get', { runId: recovery.id })).state, 'completed')
  assert.equal((await api('plans.list'))[0].enabled, false)
  assert.equal((await api('status')).migration.importedAt, status.migration.importedAt)
})
