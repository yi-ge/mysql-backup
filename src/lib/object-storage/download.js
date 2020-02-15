import {
  downloadObject as downloadObjectForCOS
} from './tencent-cos.js'
import {
  downloadObject as downloadObjectForOSS
} from './ali-oss.js'
import {
  downloadObject as downloadObjectForQiniu
} from './qiniu.js'

export default async (key, type) => {
  switch (type) {
    case 'cos':
      try {
        const res = await downloadObjectForCOS(key)
        return {
          ...res,
          objectStorageType: type
        }
      } catch (err) {
        return {
          status: -1,
          err,
          objectStorageType: type
        }
      }

    case 'oss':
      try {
        const res = await downloadObjectForOSS(key)
        return {
          ...res,
          objectStorageType: type
        }
      } catch (err) {
        return {
          status: -1,
          err,
          objectStorageType: type
        }
      }

    case 'qiniu':
      try {
        const res = await downloadObjectForQiniu(key)
        return {
          ...res,
          objectStorageType: type
        }
      } catch (err) {
        console.log(err)
        return {
          status: -1,
          err,
          objectStorageType: type
        }
      }
    default:
      return {
        status: -100,
        objectStorageType: type
      }
  }
}
