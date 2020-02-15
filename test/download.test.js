import {
  fileURLToPath
} from 'url'
import fs from 'fs'
import path from 'path'
import download from '../src/lib/object-storage/download.js'

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
  const res = await download('/test.txt', 'qiniu')

  console.log(res)

  const writeStream = fs.createWriteStream(path.join(__dirname, '../db/test.out.txt'))

  writeStream.on('error', function(err) {
    console.log(err)
  })

  writeStream.on('finish', function() {
    console.log('完毕')
  })

  res.outputStream.pipe(writeStream)
})()
