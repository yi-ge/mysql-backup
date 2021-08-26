import axios from 'axios'
import qs from 'qs'

const request = axios.create({
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
  }
})

export const sendSMS = async (action, params, SMSConfig) => {
  const appid = SMSConfig.appid
  const appkey = SMSConfig.appkey

  // 需要发送短信的手机号码
  const phoneNumbers = SMSConfig.phoneNumbers

  if (!SMSConfig.action.includes(action)) { // 如果没有开启该事件，则不进行操作
    return null
  }

  const templateId = SMSConfig.templateIDs[action]

  const datas = []

  for (const i in phoneNumbers) {
    datas.push({
      to: phoneNumbers[i],
      vars: params
    })
  }

  return new Promise(async (resolve, reject) => {
    try {
      const body = qs.stringify({
        appid,
        project: templateId,
        multi: JSON.stringify(datas),
        signature: appkey
      })

      const {
        data
      } = await request.post('https://api.mysubmail.com/message/multixsend.json', body)

      if (data) {
        for (const n in data) {
          if (data[n].status === "success") data[n].status = 1
          if (data[n].to) data[n].mobile = data[n].to
          if (data[n].sms_credits) delete data[n].sms_credits
        }

        // 参数	        必选	类型  	描述
        // status	      是	number	错误码，1表示成功（计费依据），非1表示失败
        // msg	        否	string	错误消息，status 非1时的具体错误信息
        // fee	        是	number	短信计费的条数，计费规则请参考具体运营商
        // mobile	      是	string	手机号码
        // nationCode 	否	string	国家（或地区）码
        // send_id	    否	string	本次发送标识 ID，标识一次短信下发记录

        resolve({
          status: 1,
          result: data
        })
      } else {
        reject(-2) // 收到未知错误
      }
    } catch (err) {
      reject(err)
    }
  })
}