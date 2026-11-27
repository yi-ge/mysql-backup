import axios from 'axios'
import qiniu from 'qiniu'
import db from '../db.js'

async function getStorage () {
  await db.read()
  const { useQINIU, QINIU: settings } = db.data.config.setting.ObjectStorage
  if (!useQINIU) return null

  const mac = new qiniu.auth.digest.Mac(settings.accessKey, settings.secretKey)
  const config = new qiniu.conf.Config({
    zone: qiniu.zone[settings.zone],
    useHttpsDomain: true
  })
  const manager = new qiniu.rs.BucketManager(mac, config)
  return { settings, mac, config, manager }
}

export const uploadLocalFileToQiniu = async (key, localFile) => {
  const storage = await getStorage()
  if (!storage) return null

  const { settings, mac, config, manager } = storage
  const remoteKey = key.slice(1)
  const token = new qiniu.rs.PutPolicy({ scope: settings.bucket }).uploadToken(mac)
  const uploader = new qiniu.resume_up.ResumeUploader(config)
  const upload = await uploader.putFileV2(token, remoteKey, localFile, qiniu.resume_up.PutExtra.create())
  if (!upload.ok()) throw upload.resp

  const archive = await manager.changeType(settings.bucket, remoteKey, 2)
  if (!archive.ok()) throw archive.resp
  return key
}

export const restoreObject = async (objectName) => {
  const storage = await getStorage()
  if (!storage) return null

  const { settings, manager } = storage
  const remoteKey = objectName.slice(1)
  const stat = await manager.stat(settings.bucket, remoteKey)
  if (!stat.ok()) throw stat.resp
  if (stat.data.type !== 2) return -3
  if (stat.data.restoreStatus) return stat.data.restoreStatus + 1

  const restore = await manager.restoreAr(settings.bucket + ':' + remoteKey, 7)
  if (!restore.ok()) throw restore.resp
  return 1
}

export const downloadObject = async (objectName) => {
  const storage = await getStorage()
  if (!storage) return null

  const { settings, manager } = storage
  const remoteKey = objectName.slice(1)
  const deadline = Math.floor(Date.now() / 1000) + 86400
  const url = manager.privateDownloadUrl(settings.url, remoteKey, deadline)
  if (!url) return { status: -10 }

  const stat = await manager.stat(settings.bucket, remoteKey)
  if (!stat.ok()) return { status: -11 }
  if (stat.data.type !== 2) return { status: -3 }

  try {
    const { data } = await axios.get(url, {
      responseType: 'stream',
      decompress: false,
      headers: { 'Accept-Encoding': 'identity' }
    })
    return {
      status: 1,
      contentType: stat.data.mimeType,
      contentLength: stat.data.fsize,
      outputStream: data
    }
  } catch (err) {
    err.response?.data?.destroy()
    return { status: -4 }
  }
}
