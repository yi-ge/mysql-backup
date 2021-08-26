import {
  restoreObject as restoreObjectForCOS
} from './tencent-cos.js'
import {
  restoreObject as restoreObjectForOSS
} from './ali-oss.js'
import {
  restoreObject as restoreObjectForQiniu
} from './qiniu.js'

export default async (key, type) => {
  switch (type) {
    case 'cos':
      try {
        const res = await restoreObjectForCOS(key)
        let status = null
        let waitingTime = null
        if (typeof res === 'object') {
          status = res.status
          const tier = res.Tier

          switch (tier) {
            case 'Standard':
              waitingTime = '3-5个小时'
              break
            case 'Expedited':
              waitingTime = '1-15分钟'
              break
            case 'Bulk':
              waitingTime = '5-12小时'
              break
          }

        } else {
          status = res
        }

        return {
          status,
          waitingTime: waitingTime,
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
        const status = await restoreObjectForOSS(key)
        return {
          status,
          waitingTime: '一分钟左右',
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
        const status = await restoreObjectForQiniu(key)
        return {
          status,
          waitingTime: '1-5分钟',
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
