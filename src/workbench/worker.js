import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { BlobReader, ZipReader, ZipWriterStream } from '@zip.js/zip.js'
import mysql from 'mysql2/promise.js'
import mysqldump from 'mysqldump'
import { backupConnection, backupTriggerOptions } from '../lib/mysql.js'
import { sendSMS as sendTencent } from '../lib/sms/tencent.js'
import { sendSMS as sendSubmail } from '../lib/sms/submail.js'
import { AppError } from './contract.js'
import { downloadArchive, inspectArchive, storageLocation, uploadArchive } from './storage.js'

async function fileHash (file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const codeOf = err => err instanceof AppError ? err.code : 'operation_failed'
const executeCommand = promisify(execFile)

export async function testConnection (config, existing = {}) {
  const { ssl = existing.ssl, password = existing.password ?? '', ...rest } = config
  let client
  try {
    client = await mysql.createConnection(backupConnection({ ...rest, password, ssl, connectTimeout: 8000 }))
    const [rows] = await client.query('SHOW FULL TABLES')
    return rows.map(row => ({ name: Object.values(row)[0], type: row.Table_type })).slice(0, 2000)
  } catch {
    throw new AppError('database_connection_failed', 422)
  } finally {
    if (client) await client.end().catch(() => client.destroy())
  }
}

async function importSQL (file, target, command, scratch) {
  const tls = []
  if (target.ssl) {
    const { stdout } = await executeCommand(command, ['--no-defaults', '--version'], { timeout: 10000 })
    tls.push(...(/mariadb/i.test(stdout) ? ['--ssl', '--ssl-verify-server-cert'] : ['--ssl-mode=VERIFY_IDENTITY']))
    for (const field of ['ca', 'cert', 'key']) {
      if (!target.ssl[field]) continue
      const path = join(scratch, 'recovery-' + field + '.pem')
      await writeFile(path, target.ssl[field], { mode: 0o600, flag: 'wx' })
      tls.push('--ssl-' + field + '=' + path)
    }
  }
  const child = spawn(command, [
    '--no-defaults', '--protocol=TCP', '--binary-mode=1', '--local-infile=0',
    '--host=' + target.host, '--port=' + target.port, '--user=' + target.user,
    '--default-character-set=utf8mb4', '--database=' + target.database, ...tls
  ], {
    stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, MYSQL_PWD: target.password ?? '' }
  })
  let diagnostic = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2048) })
  const completion = once(child, 'close').then(([code]) => {
    if (code !== 0) throw new AppError(/(?:^|\n)ERROR 1419\b/.test(diagnostic) ? 'recovery_binlog_policy' : 'restore_import_failed')
  })
  try {
    await Promise.all([pipeline(createReadStream(file), child.stdin), completion])
  } catch (err) {
    if (child.exitCode === null) child.kill()
    const failure = await completion.then(() => err, reason => reason)
    throw failure instanceof AppError ? failure : new AppError('restore_import_failed')
  }
}

export function startWorker (store, root, { recoveryTarget, mysqlClient, log }) {
  let active
  let closing = false

  async function backup (run, scratch) {
    const update = (stage, detail = {}, state) => store.updateRun(run.id, stage, detail, state)
    const settings = store.getStorage()
    const details = { trigger: run.actor === '$schedule' ? 'schedule' : 'manual', destinations: [] }
    const sql = join(scratch, run.id + '.sql')
    update('exporting', details)
    const dump = await mysqldump({
      connection: backupConnection({ ...run.plan.connection, connectTimeout: 10000 }),
      dump: { tables: run.plan.tables, excludeTables: run.plan.excludeTables, trigger: backupTriggerOptions() },
      dumpToFile: sql
    })
    if (!dump.tables?.length) throw new AppError('no_tables_selected')
    details.tables = dump.tables.length
    const encrypted = Boolean(run.plan.archivePassword)
    const suffix = encrypted ? '.zip' : '.sql'
    const output = encrypted ? join(scratch, run.id + suffix) : sql
    if (encrypted) {
      update('encrypting', details)
      const writer = new ZipWriterStream({ level: 8, encryptionStrength: 3, password: run.plan.archivePassword })
      await pipeline(createReadStream(sql), writer.transform(run.id + '.sql'), createWriteStream(output, { mode: 0o600 }))
    }
    const hash = await fileHash(output)
    const { size } = await stat(output)
    const key = '/mysql-backup/' + new Date(run.createdAt).toISOString().slice(0, 10).replaceAll('-', '/') + '/' + run.id + suffix
    let successful = 0
    for (const type of run.plan.providers) {
      update('uploading', details)
      try {
        const object = await uploadArchive(settings, type, key, output)
        store.recordArchive(randomUUID(), run.id, type, object, hash, size, encrypted, storageLocation(settings, type))
        details.destinations.push({ provider: type, status: 'uploaded' })
        successful++
      } catch (err) {
        const reason = codeOf(err)
        details.destinations.push({ provider: type, status: reason === 'storage_disabled' ? 'failed' : 'unknown', reason })
      }
    }
    const state = successful === run.plan.providers.length ? 'completed' : successful ? 'partial'
      : details.destinations.some(destination => destination.status === 'unknown') ? 'unknown' : 'failed'
    update('finished', { ...details, bytes: size, sha256: hash }, state)
    const preferences = store.getNotifications()
    const send = { tencent: sendTencent, submail: sendSubmail }[preferences.enable]
    if (send) {
      const params = {
        name: run.plan.name, createdTime: new Date(run.createdAt).toISOString(), fileSize: String(size),
        tablesSum: String(details.tables), dumpTime: '', objectStorageType: run.plan.providers.join(', '), uploadTime: '',
        jobTime: String(Math.round((Date.now() - run.createdAt) / 1000))
      }
      Promise.resolve(send(state === 'completed' ? 'success' : 'failed', params, preferences[preferences.enable])).catch(() => {})
    }
  }

  async function restore (run, scratch) {
    if (!recoveryTarget) throw new AppError('recovery_target_unconfigured', 409)
    const actor = { name: run.actor, role: 'admin' }
    const archive = store.getArchive(actor, run.archiveId)
    const source = store.archiveSnapshot(archive)
    if (source.connection.database.toLowerCase() === recoveryTarget.database.toLowerCase()) {
      throw new AppError('recovery_target_conflicts_with_source', 409)
    }
    const settings = store.getStorage()
    if (await inspectArchive(settings, archive) !== 'ready') throw new AppError('archive_unavailable', 409)
    const targetView = { database: recoveryTarget.database }
    store.updateRun(run.id, 'checking_target', { archiveId: archive.id, target: targetView })
    const empty = await testConnection(recoveryTarget)
    if (empty.length) throw new AppError('recovery_target_not_empty', 409)
    const payload = join(scratch, 'archive')
    store.updateRun(run.id, 'downloading', { archiveId: archive.id, target: targetView })
    const { outputStream } = await downloadArchive(settings, archive)
    await pipeline(outputStream, createWriteStream(payload, { mode: 0o600 }))
    const received = await fileHash(payload)
    if (archive.digest && received !== archive.digest) throw new AppError('archive_checksum_mismatch')
    let sql = payload
    if (archive.encrypted) {
      sql = join(scratch, 'restore.sql')
      const zip = new ZipReader(new BlobReader(await openAsBlob(payload)))
      try {
        const entries = await zip.getEntries()
        const [entry] = entries
        if (entries.length !== 1 || entry.directory || !entry.filename.endsWith('.sql') || !entry.encrypted) {
          throw new AppError('unsupported_archive')
        }
        await entry.getData(Writable.toWeb(createWriteStream(sql, { mode: 0o600 })), { password: source.archivePassword, checkSignature: true })
      } catch (err) {
        if (err instanceof AppError) throw err
        throw new AppError('archive_decryption_failed')
      } finally {
        await zip.close()
      }
    }
    const details = { archiveId: archive.id, target: targetView, sha256: received, matchedOriginalChecksum: Boolean(archive.digest) }
    store.updateRun(run.id, 'importing', details)
    if ((await testConnection(recoveryTarget)).length) throw new AppError('recovery_target_not_empty', 409)
    try {
      await importSQL(sql, recoveryTarget, mysqlClient, scratch)
    } catch (err) {
      store.updateRun(run.id, 'restore_failed', { ...details, reason: codeOf(err), targetMayContainData: true }, 'failed')
      return
    }
    const restored = await testConnection(recoveryTarget)
    const { tables } = store.getRun(actor, archive.run)
    if (!restored.length || (tables && restored.length !== tables)) throw new AppError('restored_objects_mismatch')
    store.updateRun(run.id, 'verified', {
      ...details, tables: restored.filter(item => item.type === 'BASE TABLE').length,
      views: restored.filter(item => item.type === 'VIEW').length
    }, 'completed')
  }

  async function execute (run) {
    let scratch
    const heartbeat = setInterval(() => store.heartbeat(run.id), 10000)
    heartbeat.unref()
    try {
      scratch = await mkdtemp(join(root, '.operation-'))
      await (run.kind === 'backup' ? backup(run, scratch) : restore(run, scratch))
    } catch (err) {
      store.updateRun(run.id, run.kind === 'restore' ? 'restore_failed' : 'backup_failed', {
        ...(run.archiveId && { archiveId: run.archiveId }), reason: codeOf(err)
      }, 'failed')
    } finally {
      clearInterval(heartbeat)
      if (scratch) await rm(scratch, { recursive: true, force: true })
    }
  }

  function poll () {
    if (closing || active) return
    try {
      const run = store.tick(Date.now())
      if (run) active = execute(run).catch(() => log.error('Backup worker could not finish its durable run')).finally(() => { active = null })
    } catch {
      log.error('Backup scheduler could not claim work')
    }
  }

  const timer = setInterval(poll, 500)
  timer.unref()
  poll()
  return async () => {
    closing = true
    clearInterval(timer)
    await active
  }
}
