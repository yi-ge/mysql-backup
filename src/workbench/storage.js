import * as oss from '../lib/object-storage/ali-oss.js'
import * as cos from '../lib/object-storage/tencent-cos.js'
import * as qiniu from '../lib/object-storage/qiniu.js'
import { AppError, storageKeys } from './contract.js'

const providers = {
  oss: { ...oss, upload: oss.uploadMultipart },
  cos: { ...cos, upload: cos.uploadToCOS },
  qiniu: { ...qiniu, upload: qiniu.uploadLocalFileToQiniu }
}

export function storageLocation (settings, provider) {
  const config = settings[storageKeys[provider]] ?? {}
  return JSON.stringify([config.bucket, config.endpoint ?? config.region ?? config.zone ?? null])
}

function adapter (settings, type, expected) {
  if (!settings['use' + storageKeys[type]]) throw new AppError('storage_disabled', 409)
  if (expected && expected !== storageLocation(settings, type)) throw new AppError('storage_location_changed', 409)
  return providers[type]
}

export async function uploadArchive (settings, type, key, path) {
  const result = await adapter(settings, type).upload(key, path, settings)
  if (typeof result !== 'string' || !result) throw new AppError('upload_unconfirmed', 502)
  return result
}

export async function inspectArchive (settings, archive, initiate = false) {
  const storage = adapter(settings, archive.provider, archive.location)
  const result = await storage.restoreObject(archive.object, settings, !initiate)
  const status = typeof result === 'object' && result ? result.status : result
  if (status === -3 || status === 3) return 'ready'
  if (status === 2 || status === 1) return 'thawing'
  if (status === 0) return 'archived'
  throw new AppError('archive_status_unknown', 502)
}

export async function downloadArchive (settings, archive) {
  const result = await adapter(settings, archive.provider, archive.location).downloadObject(archive.object, settings)
  if (result?.status !== 1 || !result.outputStream) throw new AppError('archive_unavailable', 409)
  return result
}
