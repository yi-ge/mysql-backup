import {
  sendSMS as sendSMSUseTencent
} from './tencent.js'
import {
  sendSMS as sendSMSUseSubmail
} from './submail.js'
import db from '../db.js'

export default async (action, params) => {
  const sendSMS = async (action, params) => {
    const config = db.get('config').cloneDeep().value()

    
    if (!config.setting.SMS.enable) return null
    if (typeof config.setting.SMS.enable !== "string") return null
    
    const type = config.setting.SMS.enable

    switch (type) {
      case 'tencent':
        try {
          const res = await sendSMSUseTencent(action, params, config.setting.SMS[type])
          return {
            ...res,
            smsType: type
          }
        } catch (err) {
          return {
            status: -1,
            err,
            smsType: type
          }
        }

      case 'submail':
        try {
          const res = await sendSMSUseSubmail(action, params, config.setting.SMS[type])
          return {
            ...res,
            smsType: type
          }
        } catch (err) {
          return {
            status: -1,
            err,
            smsType: type
          }
        }
      
      default:
        return {
          status: -100,
          smsType: type
        }
    }
  }

  const result = await sendSMS(action, params)

  db.get('logs').push({
    action: 'sendSMS',
    success: result.status === 1,
    result,
    createdTime: new Date().getTime()
  }).write()

  return result
}
