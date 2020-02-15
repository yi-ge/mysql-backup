import {
  fileURLToPath
} from 'url'
import path from 'path'
import restore from '../src/lib/object-storage/restore.js'

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
  const res = await restore('/test.txt', 'qiniu')

  console.log(res)
})()
