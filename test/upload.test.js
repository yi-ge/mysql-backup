import {
  fileURLToPath
} from 'url'
import path from 'path'
import upload from '../src/lib/object-storage/upload.js'

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
  const res = await upload('/test.txt', path.join(__dirname, '../db/test.txt'), 'oss')

  console.log(res)
})()
