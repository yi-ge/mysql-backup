import COSSDK from 'cos-nodejs-sdk-v5'
import { getObjectStorage } from './settings.js'
import axios from 'axios'

export const uploadToCOS = async (key, filePath, settings) => {
  const storage = await getObjectStorage(settings)

  if (!storage.useCOS) {
    return null
  }

  const COSConfig = storage.COS

  const COS = {
    bucket: COSConfig.bucket,
    region: COSConfig.region,
    url: COSConfig.url
  }

  const qcloudAccessKey = {
    SecretId: COSConfig.SecretId,
    SecretKey: COSConfig.SecretKey
  }

  const cos = new COSSDK(qcloudAccessKey)

  return new Promise((resolve, reject) => {
    // 分片上传
    cos.sliceUploadFile(
      {
        Bucket: COS.bucket,
        Region: COS.region,
        Key: key,
        FilePath: filePath,
        StorageClass: 'ARCHIVE'
      },
      function (err, data) {
        if (err || !data) {
          reject(err)
        } else {
          resolve(key)
        }
      }
    )
  })
}

/**
 * 解冻文件
 * @param {string} objectName
 */
export const restoreObject = async (objectName, settings, statusOnly = false) => {
  const storage = await getObjectStorage(settings)

  if (!storage.useCOS) {
    return null
  }

  const COSConfig = storage.COS

  const COS = {
    bucket: COSConfig.bucket,
    region: COSConfig.region,
    url: COSConfig.url
  }

  const qcloudAccessKey = {
    SecretId: COSConfig.SecretId,
    SecretKey: COSConfig.SecretKey
  }

  const cos = new COSSDK(qcloudAccessKey)

  return new Promise((resolve, reject) => {
    cos.headObject({
      Bucket: COS.bucket,
      Region: COS.region,
      Key: objectName
    }, function (err, data) {
      if (err) return reject(err)
      if (data.headers['x-cos-storage-class'] !== 'ARCHIVE') {
        return resolve(-3) // 非归档存储
      }

      if (data.headers['x-cos-restore'] && data.headers['x-cos-restore'].includes('ongoing-request="true"')) {
        return resolve(2) // 解冻中
      }

      if (data.headers['x-cos-restore'] && data.headers['x-cos-restore'].includes('ongoing-request="false"')) {
        return resolve(3) // 解冻完成
      }

      if (statusOnly) return resolve(0)

      // Standard（标准模式，恢复任务在3 - 5小时内完成，支持256MB以下文件）
      // Expedited（极速模式，恢复任务在15分钟内可完成）
      // Bulk（批量模式，恢复任务在5 - 12小时内完成）
      let Tier = 'Standard'
      let contentLength = data.headers['content-length']
      if (contentLength) {
        contentLength = Number(contentLength)
        if (contentLength < 268435456) { // 256MB
          Tier = 'Expedited'
        }

        if (contentLength > '5368709120') { // 5GB
          Tier = 'Bulk'
        }
      }

      cos.restoreObject({
        Bucket: COS.bucket,
        Region: COS.region,
        Key: objectName,
        RestoreRequest: {
          Days: 7,
          CASJobParameters: {
            Tier
          }
        }
      }, function (err, data) {
        if (err) {
          if (err.statusCode === 409 && err.error?.Code?.includes('RestoreAlreadyInProgress')) {
            return resolve(2)
          } else {
            return reject(err)
          }
        }

        resolve({
          status: 1,
          Tier
        })
      })
    })
  })
}

/**
 * 下载文件
 * @param {string} objectName
 */
export const downloadObject = async (objectName, settings) => {
  const storage = await getObjectStorage(settings)

  if (!storage.useCOS) {
    return null
  }

  const availability = await restoreObject(objectName, storage, true)
  if (availability !== 3 && availability !== -3) return { status: -1 }

  const { bucket, region, SecretId, SecretKey } = storage.COS
  const cos = new COSSDK({ SecretId, SecretKey })
  const url = await new Promise((resolve, reject) => {
    cos.getObjectUrl({ Bucket: bucket, Region: region, Key: objectName, Expires: 120 }, (err, data) => {
      if (err) return reject(err)
      resolve(data.Url)
    })
  })
  try {
    const { data, headers } = await axios.get(url, {
      responseType: 'stream',
      maxRedirects: 0,
      timeout: 30000,
      decompress: false,
      headers: { 'Accept-Encoding': 'identity' }
    })
    return { status: 1, contentType: headers['content-type'], contentLength: headers['content-length'], outputStream: data }
  } catch (err) {
    err.response?.data?.destroy()
    return { status: -2 }
  }
}
