import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'
import mysql from 'mysql2/promise.js'

const host = '127.0.0.1'

async function listen (server) {
  server.listen(0, host)
  await once(server, 'listening')
  return 'http://' + host + ':' + server.address().port
}

function objectStore () {
  const objects = new Map()
  const server = createServer(async (req, res) => {
    const url = new URL('http://localhost' + req.url)
    const key = decodeURIComponent(url.pathname).replace(/^\/+/, '/')
    if (req.method === 'PUT') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      objects.set(key, { data: Buffer.concat(chunks), restored: false })
      res.writeHead(200, { etag: '"test-etag"' }).end()
      return
    }

    const object = objects.get(key)
    if (!object) {
      res.writeHead(404).end()
    } else if (req.method === 'HEAD') {
      const headers = { 'x-oss-storage-class': 'Archive' }
      if (object.restored) {
        headers['x-oss-restore'] = 'ongoing-request="false", expiry-date="Fri, 31 Dec 2038 12:00:00 GMT"'
      }
      res.writeHead(200, headers).end()
    } else if (req.method === 'POST' && url.searchParams.has('restore')) {
      object.restored = true
      res.writeHead(202).end()
    } else if (req.method === 'GET' && object.restored) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': object.data.length })
      res.end(object.data)
    } else {
      res.writeHead(403).end()
    }
  })
  return { server, objects }
}

async function waitFor (read, timeout = 90000) {
  const deadline = Date.now() + timeout
  do {
    const value = await read()
    if (value) return value
    await delay(200)
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for the application')
}

test('scheduled backups restore data, views and triggers from SQL and encrypted ZIP', { timeout: 115000 }, async t => {
  const port = Number(process.env.MYSQL_TEST_PORT)
  assert.ok(Number.isInteger(port) && port > 0, 'Set MYSQL_TEST_PORT to an isolated MySQL instance')
  const user = process.env.MYSQL_TEST_USER || 'root'
  const password = process.env.MYSQL_TEST_PASSWORD || ''
  const server = { host, port, user, password, charset: 'UTF8MB4_GENERAL_CI' }
  const admin = await mysql.createConnection({ ...server, multipleStatements: true })
  const suffix = randomBytes(6).toString('hex')
  const source = 'mb_source_' + suffix
  const targets = ['mb_full_', 'mb_zip_', 'mb_exclude_'].map(prefix => prefix + suffix)
  const backupUser = 'mb_backup_' + suffix
  const backupPassword = randomBytes(12).toString('hex')
  t.after(async () => {
    try {
      for (const database of [source, ...targets]) {
        await admin.query('DROP DATABASE IF EXISTS ??', [database])
      }
      await admin.query("DROP USER IF EXISTS ?@'%'", [backupUser])
    } finally {
      await admin.end()
    }
  })
  const [versions] = await admin.query('SELECT VERSION() AS version')
  t.diagnostic('MySQL ' + versions[0].version)
  for (const database of [source, ...targets]) {
    await admin.query('CREATE DATABASE ?? CHARACTER SET utf8mb4', [database])
  }
  await admin.query("CREATE USER ?@'%' IDENTIFIED BY ?", [backupUser, backupPassword])
  const [plugins] = await admin.query('SELECT plugin FROM mysql.user WHERE User = ?', [backupUser])
  t.diagnostic('Backup account authentication: ' + plugins[0].plugin)
  await admin.query("GRANT SELECT, SHOW VIEW, TRIGGER ON ??.* TO ?@'%'", [source, backupUser])
  await admin.query(
    'USE ??; ' +
    'CREATE TABLE items (id INT PRIMARY KEY, name VARCHAR(80), payload VARBINARY(20)) ENGINE=InnoDB; ' +
    'CREATE TABLE audit (id INT PRIMARY KEY) ENGINE=InnoDB; ' +
    'CREATE TABLE ignored (id INT PRIMARY KEY) ENGINE=InnoDB; ' +
    'INSERT INTO items VALUES (1, ?, UNHEX(?)); ' +
    'INSERT INTO ignored VALUES (5); ' +
    'CREATE VIEW item_names AS SELECT name FROM items; ' +
    'CREATE TRIGGER items_audit AFTER INSERT ON items FOR EACH ROW INSERT INTO audit VALUES (NEW.id);',
    [source, '恢复😀', '00FF27']
  )

  const scratch = await mkdtemp(join(tmpdir(), 'mysql-backup-test-'))
  const workPath = join(scratch, 'new-workpath')
  const storage = objectStore()
  const endpoint = await listen(storage.server)
  const app = spawn(process.execPath, ['src/main.js'], {
    env: { ...process.env, NODE_ENV: 'test', MYSQL_BACKUP_LEGACY: '1', HOST: host, PORT: '0', WORKPATH: workPath, SCHEME: 'http' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const exited = once(app, 'exit')
  t.after(async () => {
    app.kill()
    await exited
    await new Promise(resolve => storage.server.close(resolve))
    await rm(scratch, { recursive: true, force: true })
  })
  let appLogs = ''
  for (const stream of [app.stdout, app.stderr]) {
    stream.setEncoding('utf8').on('data', chunk => { appLogs += chunk })
  }

  try {
    const address = await waitFor(() => {
      assert.equal(app.exitCode, null, 'Application exited during startup')
      return appLogs.match(/Server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
    }, 10000)
    let jwt
    const api = async (path, method = 'GET', body, status = 1) => {
      const headers = { ...(jwt && { authorization: 'Bearer ' + jwt }) }
      if (body) headers['content-type'] = 'application/json'
      const response = await fetch(address + path, { method, headers, body: body && JSON.stringify(body) })
      assert.equal(response.status, 200, path)
      const json = await response.json()
      assert.equal(json.status, status, path + ': ' + JSON.stringify(json))
      return json.result
    }
    assert.equal((await fetch(address)).status, 200)
    assert.equal((await fetch(address + '/documentation/')).status, 200)
    const spec = await fetch(address + '/documentation/json')
    assert.equal(spec.status, 200)
    assert.ok((await spec.json()).paths['/api/database/download'])
    jwt = (await api('/api/manage/user/login', 'POST', { username: 'admin', password: 'admin888' })).token
    assert.ok(jwt)
    const settings = JSON.parse(await api('/api/setting'))
    settings.ObjectStorage.useOSS = true
    settings.ObjectStorage.OSS = {
      endpoint,
      cname: true,
      bucket: 'backup-fixture',
      accessKeyId: 'test-key',
      accessKeySecret: 'test-secret'
    }
    await api('/api/setting', 'POST', { setting: JSON.stringify(settings) })

    const connection = { ...server, user: backupUser, password: backupPassword, database: source, charset: 'UTF8_GENERAL_CI', ssl: null }
    const zipPassword = randomBytes(12).toString('hex')
    const encode = config => ({ code: 'function main () { return ' + JSON.stringify(config) + ' }' })
    const probe = conn => encode({ connection: conn })
    const [firstProbe, secondProbe] = [
      await api('/api/database/test', 'POST', probe(connection)),
      await api('/api/database/test', 'POST', probe(connection))
    ]
    assert.equal(firstProbe.length, 4)
    assert.deepEqual(secondProbe, firstProbe)
    const [[{ connections }]] = await admin.query(
      'SELECT COUNT(*) AS connections FROM information_schema.PROCESSLIST WHERE USER = ?', [backupUser]
    )
    assert.equal(connections, 0, 'Connection tests must close their MySQL sessions')
    const badConnection = { ...connection, password: backupPassword + '-wrong' }
    await api('/api/database/test', 'POST', probe(badConnection), -13)

    const config = (uuid, second, overrides = {}) => encode({
      uuid,
      name: uuid,
      cron: second + ' * * * * *',
      connection,
      dumpOptions: { tables: [], excludeTables: false },
      objectStorage: 'oss',
      ...overrides
    })
    await api('/api/database/create', 'POST', config('deleted', 1))
    await api('/api/database/delete', 'DELETE', { uuid: 'deleted' })
    await api('/api/database/create', 'POST', config('full', 2))
    await api('/api/database/create', 'POST', config('encrypted', 3, {
      dumpOptions: { tables: ['audit', 'items'], excludeTables: false },
      objectStorage: ['oss'],
      encryptZipFile: true,
      zipPassword
    }))
    await api('/api/database/create', 'POST', config('exclude', 4, {
      dumpOptions: { tables: ['ignored'], excludeTables: true }
    }))
    await api('/api/database/create', 'POST', config('bad-password', 5, { connection: badConnection }))
    await api('/api/database/create', 'POST', config('no-zip-password', 6, { encryptZipFile: true }))
    await api('/api/database/create', 'POST', config('no-storage', 7, { objectStorage: [] }))
    await api('/api/database/create', 'POST', config('disabled-provider', 8, { objectStorage: 'cos' }))

    const successIds = ['full', 'encrypted', 'exclude']
    const failures = [
      ['bad-password', 'create-mysqldump'],
      ['no-zip-password', 'zip-encrypted'],
      ['no-storage', 'upload-backup'],
      ['disabled-provider', 'upload-backup']
    ]
    const statePath = join(workPath, 'mysql-backup-db.json')
    const state = await waitFor(async () => {
      assert.equal(app.exitCode, null, 'Application exited during a scheduled backup')
      const current = JSON.parse(await readFile(statePath, 'utf8'))
      return [...successIds, ...failures.map(([uuid]) => uuid)].every(uuid => current.exec.some(run => run.uuid === uuid)) && current
    })
    assert.ok(!state.exec.some(run => run.uuid === 'deleted'))
    for (const [uuid, action] of failures) {
      const runs = state.exec.filter(run => run.uuid === uuid)
      assert.ok(runs.every(run => run.success === false && !run.objectName), uuid)
      await waitFor(async () => {
        const current = JSON.parse(await readFile(statePath, 'utf8'))
        return current.logs.some(log => log.execUUID === runs[0].execUUID && log.action === action && log.success === false)
      }, 5000)
    }
    const successful = state.exec.filter(run => successIds.includes(run.uuid))
    assert.ok(successful.every(run => run.success && run.objectName), JSON.stringify(successful))
    assert.deepEqual([...storage.objects.keys()].sort(), successful.map(run => run.objectName).sort())
    await waitFor(async () => (await readdir(workPath)).every(file => !/\.(?:sql|zip)$/.test(file)), 15000)

    const download = async run => {
      const query = '?' + new URLSearchParams({ uuid: run.uuid, execUUID: run.execUUID })
      assert.equal((await api('/api/database/restore' + query)).status, 1)
      const restored = await api('/api/database/restore' + query)
      assert.equal(restored.status, 3)
      const response = await fetch(address + '/api/database/download?key=' + restored.key)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-disposition'), /attachment/)
      return Buffer.from(await response.arrayBuffer())
    }
    const restore = async (uuid, index, expectedTables) => {
      const run = successful.find(entry => entry.uuid === uuid)
      let sql = await download(run)
      if (uuid === 'encrypted') {
        assert.match(run.objectName, /\.zip$/)
        const zip = new ZipReader(new Uint8ArrayReader(sql))
        try {
          const [entry, ...rest] = await zip.getEntries()
          assert.equal(rest.length, 0)
          assert.match(entry.filename, /\.sql$/)
          assert.equal(entry.encrypted, true)
          await assert.rejects(entry.getData(new Uint8ArrayWriter(), { password: 'wrong' }))
          sql = await entry.getData(new Uint8ArrayWriter(), { password: zipPassword })
        } finally {
          await zip.close()
        }
      } else {
        assert.match(run.objectName, /\.sql$/)
      }

      const target = targets[index]
      execFileSync(process.env.MYSQL_TEST_CLIENT || 'mysql', [
        '--no-defaults', '--protocol=TCP', '--host=' + host, '--port=' + port,
        '--user=' + user, '--default-character-set=utf8mb4', target
      ], { input: sql, env: { ...process.env, MYSQL_PWD: password } })
      const [tables] = await admin.query('SHOW TABLES FROM ??', [target])
      assert.deepEqual(tables.map(row => Object.values(row)[0]), expectedTables)
      const [[record]] = await admin.query('SELECT HEX(name) AS name, HEX(payload) AS payload FROM ??.items', [target])
      assert.deepEqual(record, { name: 'E681A2E5A48DF09F9880', payload: '00FF27' })
      if (expectedTables.includes('item_names')) {
        const [[{ name }]] = await admin.query('SELECT name FROM ??.item_names', [target])
        assert.equal(name, '恢复😀')
      }
      await admin.query('INSERT INTO ??.items VALUES (2, ?, NULL)', [target, 'after restore'])
      const [audit] = await admin.query('SELECT id FROM ??.audit', [target])
      assert.deepEqual(audit, [{ id: 2 }])
    }

    await restore('full', 0, ['audit', 'ignored', 'item_names', 'items'])
    await restore('encrypted', 1, ['audit', 'items'])
    await restore('exclude', 2, ['audit', 'item_names', 'items'])
  } catch (err) {
    t.diagnostic(appLogs)
    throw err
  }
})
