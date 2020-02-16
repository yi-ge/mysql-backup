import {
  fileURLToPath
} from 'url'
import path from 'path'
import sms from '../src/lib/sms/index.js'
import dayjs from 'dayjs'

if (typeof (__filename) === 'undefined') {
  try {
    // eslint-disable-next-line
    global.__filename = fileURLToPath(
      import.meta.url)
  } catch (err) {
    console.log(err)
  }
}

if (typeof (__dirname) === 'undefined') {
  global.__dirname = path.dirname(__filename)
}

(async () => {
  const res = await sms('failed', {
    name: '测试',
    createdTime: dayjs().format('MM月DD日HH:mm')
  })

  console.log(res)
})()
