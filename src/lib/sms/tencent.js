import QcloudSms from 'qcloudsms_js'

export const sendSMS = async (action, params, SMSConfig) => {
  // 短信应用SDK AppID
  const appid = SMSConfig.appid;  // SDK AppID是1400开头

  // 短信应用SDK AppKey
  const appkey = SMSConfig.appkey

  // 需要发送短信的手机号码
  const phoneNumbers = SMSConfig.phoneNumbers

  console.log(SMSConfig.action, SMSConfig.action.includes(action), action)

  if (!SMSConfig.action.includes(action)) { // 如果没有开启该事件，则不进行操作
    return null
  }

  // 短信模板ID，需要在短信应用中申请
  const templateId = SMSConfig.templateIDs[action];  // NOTE: 这里的模板ID`7839`只是一个示例，真实的模板ID需要在短信控制台中申请

  // 签名
  const smsSign = SMSConfig.smsSign;  // NOTE: 这里的签名只是示例，请使用真实的已申请的签名, 签名参数使用的是`签名内容`，而不是`签名ID`

  // 实例化QcloudSms
  const qcloudsms = QcloudSms(appid, appkey)

  const msender = qcloudsms.SmsMultiSender()

  params = Object.values(params)

  console.log(params)

  return new Promise((resolve, reject) => {
    msender.sendWithParam("86", phoneNumbers, templateId, params, smsSign, "", "", function(err, res, resData) {
      if (err) {
        console.log(err)
        reject(err)
      } else {
          if (resData.result === 0) {

            const result = resData.detail

            for (const n in result) {
              if (result.status === 0) result.status = 1
              if (result.status === 1) result.status = -1
              if (result.errmsg) result.msg = result.errmsg
              if (result.sid) result.send_id = result.sid
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
              result
            })
          } else {
            reject({
              requestData: res.req,
              resData
            })
          }
      }
    })
  })
}
