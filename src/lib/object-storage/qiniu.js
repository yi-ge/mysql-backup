
import qiniu from 'qiniu'
import request from 'request'
import db from '../db.js'

export const uploadLocalFileToQiniu = (key, localFile) => {
  const dbConfig = db.get('config').value()

  if (!dbConfig.setting.ObjectStorage.useQINIU) {
    return null
  }

  const QINIUConfig = dbConfig.setting.ObjectStorage.QINIU

  const mac = new qiniu.auth.digest.Mac(QINIUConfig.accessKey, QINIUConfig.secretKey)
  const putPolicy = new qiniu.rs.PutPolicy({
    scope: QINIUConfig.bucket
  })

  const config = new qiniu.conf.Config()
  // 空间对应的机房
  config.zone = qiniu.zone[QINIUConfig.zone]
  // 是否使用https域名
  config.useHttpsDomain = true
  // 上传是否使用cdn加速
  // config.useCdnDomain = true;

  return new Promise((resolve, reject) => {
    const uploadToken = putPolicy.uploadToken(mac)
    var resumeUploader = new qiniu.resume_up.ResumeUploader(config)
    var putExtra = new qiniu.resume_up.PutExtra()
    // 如果指定了断点记录文件，那么下次会从指定的该文件尝试读取上次上传的进度，以实现断点续传
    // putExtra.resumeRecordFile = 'progress.log';
    // 文件分片上传
    const remoteKey = key.substr(1) // 删除开头的/
    resumeUploader.putFile(uploadToken, remoteKey, localFile, putExtra, function (respErr,
      respBody, respInfo) {
      if (respErr) {
        return reject(respErr)
      }
      if (respInfo.statusCode === 200) {
        const newType = 2 // 0 表示标准存储；1 表示低频存储；2 表示归档存储
        const bucketManager = new qiniu.rs.BucketManager(mac, config)
        bucketManager.changeType(QINIUConfig.bucket, remoteKey, newType, function (err, respBody, respInfo) {
          if (err) {
            return reject(err)
          } else {
            // 200 is success
            if (respInfo.statusCode === 200) {
              resolve(key)
            } else {
              return reject(respInfo)
            }
          }
        })
      } else {
        return reject(respInfo)
      }
    })
  })
}

/**
 * 解冻文件
 * @param {string} objectName
 */
export const restoreObject = async (objectName) => {
  const dbConfig = db.get('config').value()

  if (!dbConfig.setting.ObjectStorage.useQINIU) {
    return null
  }

  const QINIUConfig = dbConfig.setting.ObjectStorage.QINIU

  const mac = new qiniu.auth.digest.Mac(QINIUConfig.accessKey, QINIUConfig.secretKey)

  const config = new qiniu.conf.Config()
  // 空间对应的机房
  config.zone = qiniu.zone[QINIUConfig.zone]
  // 是否使用https域名
  config.useHttpsDomain = true
  // 上传是否使用cdn加速
  // config.useCdnDomain = true;

  return new Promise((resolve, reject) => {
    // 预取链接
    const bucketManager = new qiniu.rs.BucketManager(mac, config)
    const remoteKey = objectName.substr(1)
    bucketManager.stat(QINIUConfig.bucket, remoteKey, function (err, respBody, respInfo) {
      if (err) {
        return reject(err)
      } else {
        // 200 is success
        if (respInfo.statusCode === 200) {
          if (respBody.type !== 2) {
            return resolve(-3) // 非归档存储
          }

          if (respBody.restoreStatus) {
            resolve(respBody.restoreStatus + 1) // 2 解冻中、 3 解冻完成
          } else {
            bucketManager.restore(QINIUConfig.bucket, remoteKey, 7, function (res) {
              if (res.status === 200) {
                resolve(1) // 开始解冻
              } else {
                return reject(res)
              }
            })
          }
        } else {
          return reject(respInfo)
        }
      }
    })
  })
}

/**
 * 下载文件
 * @param {string} objectName
 */
export const downloadObject = async (objectName) => {
  const dbConfig = db.get('config').value()

  if (!dbConfig.setting.ObjectStorage.useQINIU) {
    return null
  }

  const QINIUConfig = dbConfig.setting.ObjectStorage.QINIU

  const mac = new qiniu.auth.digest.Mac(QINIUConfig.accessKey, QINIUConfig.secretKey)

  const config = new qiniu.conf.Config()
  // 空间对应的机房
  config.zone = qiniu.zone[QINIUConfig.zone]
  // 是否使用https域名
  config.useHttpsDomain = true
  // 上传是否使用cdn加速
  // config.useCdnDomain = true;

  const bucketManager = new qiniu.rs.BucketManager(mac, config)
  const deadline = parseInt(Date.now() / 1000) + 3600 * 24 // 24小时过期
  const remoteKey = objectName.substr(1)
  const privateDownloadUrl = bucketManager.privateDownloadUrl(QINIUConfig.url, remoteKey, deadline)

  console.log(privateDownloadUrl)

  return new Promise((resolve, reject) => {
    if (privateDownloadUrl) {
      bucketManager.stat(QINIUConfig.bucket, remoteKey, function (err, respBody, respInfo) {
        if (err) {
          return reject(err)
        } else {
          // 200 is success
          if (respInfo.statusCode === 200) {
            if (respBody.type !== 2) {
              return resolve({
                status: -3
              }) // 非归档存储
            }

            const outputStream = request
              .get(privateDownloadUrl)
              .on('error', function (err) {
                return resolve({
                  status: -4, // 下载过程发生错误
                  err
                }) // 没有获取到下载地址
              })

            resolve({
              status: 1,
              contentType: respBody.mimeType,
              contentLength: respBody.fsize,
              outputStream: outputStream
            })
          } else {
            resolve({
              status: -11
            }) // 网络错误
          }
        }
      })
    } else {
      resolve({
        status: -10
      }) // 没有获取到下载地址
    }
  })
}
