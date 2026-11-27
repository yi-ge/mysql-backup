import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import test from 'node:test'
import axios from 'axios'
import qiniu from 'qiniu'

test('legacy state and password hashes remain readable', async t => {
  const workPath = await mkdtemp(join(tmpdir(), 'mysql-backup-legacy-'))
  const previousWorkPath = process.env.WORKPATH
  const previousNodeEnv = process.env.NODE_ENV
  process.env.WORKPATH = workPath
  process.env.NODE_ENV = 'test'
  t.after(async () => {
    if (previousWorkPath === undefined) delete process.env.WORKPATH
    else process.env.WORKPATH = previousWorkPath
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    await rm(workPath, { recursive: true, force: true })
  })

  const legacyHash = 'aaa3a282440c56c43fe33bf98a2f3a9e17c383111a57badb879ffb45b512bced79634276f361b462b227c684bba4f9ab8fc95a1f431f8105555da3f0774d31c3'
  const priorState = {
    config: { sessionKey: 'existing-session-key' },
    users: [{ username: 'legacy-user', password: legacyHash, token: 'existing-token' }],
    databases: [{ uuid: 'existing-job', objectStorage: ['qiniu', 'cos'] }],
    exec: [{ uuid: 'existing-job', objectName: '/mysql-backup/old.sql' }]
  }

  await writeFile(join(workPath, 'mysql-backup-db.json'), JSON.stringify(priorState))
  const { default: db } = await import('../src/lib/db.js')
  const { default: auth } = await import('../src/lib/auth.js')

  assert.equal(auth.createPassword('旧密码🔒'), legacyHash)
  assert.deepEqual(db.data.config, priorState.config)
  assert.deepEqual(db.data.users, priorState.users)
  assert.deepEqual(db.data.databases, priorState.databases)
  assert.deepEqual(db.data.exec, priorState.exec)

  await t.test('official Qiniu SDK adapter preserves archive and streaming operations', async t => {
    const payload = Buffer.from([0, 255, 39, 10])
    let downloadStatus = 200
    let downloaded
    const server = createServer((request, response) => {
      downloaded = new URL('http://127.0.0.1' + request.url)
      response.writeHead(downloadStatus).end(payload)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise(resolve => {
      server.close(resolve)
      server.closeAllConnections()
    }))

    const bucket = 'test-bucket'
    const key = '/mysql-backup/fixture.bin'
    db.data.config.setting = {
      ObjectStorage: {
        useQINIU: true,
        QINIU: {
          accessKey: 'fixture-key',
          secretKey: 'fixture-secret',
          bucket,
          zone: 'Zone_z0',
          url: 'http://127.0.0.1:' + server.address().port
        }
      }
    }
    await db.write()

    const adapter = await import('../src/lib/object-storage/qiniu.js')
    const ok = data => ({ data, ok: () => true })
    const uploader = qiniu.resume_up.ResumeUploader.prototype
    const manager = qiniu.rs.BucketManager.prototype
    const upload = t.mock.method(uploader, 'putFileV2', async (token, remoteKey, localFile, options) => {
      assert.match(token, /^fixture-key:/)
      assert.equal(remoteKey, key.slice(1))
      assert.equal(localFile, '/fixture/backup.bin')
      assert.ok(options instanceof qiniu.resume_up.PutExtra)
      return ok()
    })
    const archive = t.mock.method(manager, 'changeType', async () => ok())
    const restore = t.mock.method(manager, 'restoreAr', async () => ok())
    let restoreStatus = 0
    t.mock.method(manager, 'stat', async (resourceBucket, remoteKey) => {
      assert.equal(resourceBucket, bucket)
      assert.equal(remoteKey, key.slice(1))
      return ok({ type: 2, restoreStatus, mimeType: 'application/octet-stream', fsize: payload.length })
    })

    assert.equal(await adapter.uploadLocalFileToQiniu(key, '/fixture/backup.bin'), key)
    assert.equal(upload.mock.callCount(), 1)
    assert.deepEqual(archive.mock.calls[0].arguments, [bucket, key.slice(1), 2])

    assert.equal(await adapter.restoreObject(key), 1)
    assert.deepEqual(restore.mock.calls[0].arguments, [bucket + ':' + key.slice(1), 7])
    restoreStatus = 1
    assert.equal(await adapter.restoreObject(key), 2)
    restoreStatus = 2
    assert.equal(await adapter.restoreObject(key), 3)

    const result = await adapter.downloadObject(key)
    assert.equal(result.status, 1)
    assert.equal(result.contentLength, payload.length)
    assert.equal(result.contentType, 'application/octet-stream')
    assert.deepEqual(await buffer(result.outputStream), payload)
    assert.equal(downloaded.pathname, key)
    assert.match(downloaded.searchParams.get('token'), /^fixture-key:/)

    downloadStatus = 403
    assert.deepEqual(await adapter.downloadObject(key), { status: -4 })
  })
})

test('SUBMAIL still sends and normalizes form data', async () => {
  const originalAdapter = axios.defaults.adapter
  let sendSMS
  axios.defaults.adapter = async config => {
    assert.equal(config.url, 'https://api.mysubmail.com/message/multixsend.json')
    assert.match(config.headers.get('Content-Type'), /^application\/x-www-form-urlencoded/)
    const body = new URLSearchParams(config.data)
    assert.equal(body.get('appid'), '123')
    assert.equal(body.get('project'), '备份 通知')
    assert.equal(body.get('signature'), 'fixture&key')
    assert.deepEqual(JSON.parse(body.get('multi')), [{ to: '+8613800000000', vars: { name: '数据库 🔒' } }])
    return { data: [{ status: 'success', to: '+8613800000000', sms_credits: 1 }] }
  }
  try {
    ({ sendSMS } = await import('../src/lib/sms/submail.js'))
  } finally {
    axios.defaults.adapter = originalAdapter
  }

  const config = {
    appid: '123',
    appkey: 'fixture&key',
    action: ['failed'],
    templateIDs: { failed: '备份 通知' },
    phoneNumbers: ['+8613800000000']
  }

  assert.equal(await sendSMS('success', {}, config), null)
  assert.deepEqual(await sendSMS('failed', { name: '数据库 🔒' }, config), {
    status: 1,
    result: [{ status: 1, to: '+8613800000000', mobile: '+8613800000000' }]
  })
})
