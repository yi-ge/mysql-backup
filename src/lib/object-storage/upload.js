import {
  uploadToCOS as uploadLocalFileToCOS
} from './tencent-cos.js'
import {
  uploadMultipart as uploadLocalFileToOSS
} from './ali-oss.js'
import {
  uploadLocalFileToQiniu
} from './qiniu.js'

export default async (key, localFilePath, type, execUUID) => {
  switch (type) {
    case 'cos':
      try {
        const objectName = await uploadLocalFileToCOS(key, localFilePath)
        return {
          objectName,
          objectStorageType: type,
          execUUID
        }
      } catch (err) {
        return {
          objectName: null,
          err,
          objectStorageType: type,
          execUUID
        }
      }

    case 'oss':
      try {
        const objectName = await uploadLocalFileToOSS(key, localFilePath)
        return {
          objectName,
          objectStorageType: type,
          execUUID
        }
      } catch (err) {
        return {
          objectName: null,
          err,
          objectStorageType: type,
          execUUID
        }
      }

    case 'qiniu':
      try {
        const objectName = await uploadLocalFileToQiniu(key, localFilePath)
        return {
          objectName,
          objectStorageType: type,
          execUUID
        }
      } catch (err) {
        return {
          objectName: null,
          err,
          objectStorageType: type,
          execUUID
        }
      }
    default:
      return {
        objectName: null,
        objectStorageType: type,
        execUUID
      }
  }
}
