import OSS from 'ali-oss'
import db from '../db.js'

/***
 * 分片上传
 * 在需要上传的文件较大时，可以通过multipartUpload接口进行分片上传。分片上传的好处是将一个大请求分成多个小请求来执行，这样当其中一些请求失败后，不需要重新上传整个文件，而只需要上传失败的分片就可以了。一般对于大于100MB的文件，建议采用分片上传的方法。
 * @param objectName
 * @param localFile
 */
export const uploadMultipart = async (objectName, localFile) => {
  await db.read()
  const config = db.data.config

  if (!config.setting.ObjectStorage.useOSS) {
    return null
  }

  const OSSConfig = config.setting.ObjectStorage.OSS
  delete OSSConfig.url

  const client = new OSS(OSSConfig)

  try {
    const result = await client.multipartUpload(objectName, localFile)

    return result.name
  } catch (err) {
    console.log(err)
    return null
  }
}

/**
 * 解冻文件
 * @param {string} objectName
 */
export const restoreObject = async (objectName) => {
  await db.read()
  const config = db.data.config

  if (!config.setting.ObjectStorage.useOSS) {
    return null
  }

  const OSSConfig = config.setting.ObjectStorage.OSS
  delete OSSConfig.url

  const client = new OSS(OSSConfig)

  try {
    const head = await client.head(objectName)

    if (head.res.headers['x-oss-storage-class'] !== 'Archive') {
      return -3 // 非归档存储
    }

    if (head.res.headers['x-oss-restore'] && head.res.headers['x-oss-restore'] === 'ongoing-request="true"') {
      return 2 // 解冻中
    }

    if (head.res.headers['x-oss-restore'] && head.res.headers['x-oss-restore'].includes('ongoing-request="false"')) {
      return 3 // 解冻完成
    }

    const res = await client.restore(objectName)
    if (res.res.status === 202) {
      return 1
    }

    return null
  } catch (err) {
    console.log(err)
    return null
  }
}

/**
 * 下载文件
 * @param {string} objectName
 */
export const downloadObject = async (objectName) => {
  await db.read()
  const config = db.data.config

  if (!config.setting.ObjectStorage.useOSS) {
    return null
  }

  const OSSConfig = config.setting.ObjectStorage.OSS
  delete OSSConfig.url

  const client = new OSS(OSSConfig)

  try {
    const result = await client.getStream(objectName)

    return {
      status: 1,
      contentType: result.res.headers['content-type'],
      contentLength: result.res.headers['content-length'],
      outputStream: result.stream
    }
  } catch (err) {
    console.log(err)
    return {
      status: -2, // 未知错误
      err
    }
  }
}
