import axios from 'axios'

const request = axios.create({
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
  }
})

export const sendSMS = async (action, params, SMSConfig) => {
  if (!SMSConfig.action.includes(action)) return null

  const body = new URLSearchParams({
    appid: SMSConfig.appid,
    project: SMSConfig.templateIDs[action],
    multi: JSON.stringify(Object.values(SMSConfig.phoneNumbers).map(to => ({ to, vars: params }))),
    signature: SMSConfig.appkey
  })

  const { data } = await request.post('https://api.mysubmail.com/message/multixsend.json', body.toString())
  if (!data) throw -2

  for (const item of Object.values(data)) {
    if (item.status === 'success') item.status = 1
    if (item.to) item.mobile = item.to
    if (item.sms_credits) delete item.sms_credits
  }

  return { status: 1, result: data }
}
