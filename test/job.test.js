import {
  fileURLToPath
} from 'url'
import fs from 'fs'
import path from 'path'
import generateUuid from 'uuid'
import archiver from 'archiver'
import archiverZipEncrypted from 'archiver-zip-encrypted'
import mysqldump from 'mysqldump'
import schedule from 'node-schedule'
import upload from '../src/lib/object-storage/upload.js'
import db from '../src/lib/db.js'

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

// register format for archiver
// note: only do it once per Node.js process/application, as duplicate registration will throw an error
archiver.registerFormat('zip-encrypted', archiverZipEncrypted)

const uuid = 'c2d480ea-9ac9-4cf9-afe3-9a5e576a3830';

(async () => {
  const startTime = new Date().getTime()
  let execUUID = generateUuid()
  const check = db.get('codes').find({
    uuid,
    deletedTime: null
  }).cloneDeep().value()

  if (!check) {
    console.log('检查不通过')
    return
  }

  const database = db.get('databases').find({
    uuid
  }).cloneDeep().value()

  let dumpToFileName = generateUuid() + (database.compressFile ? '.sql.gz' : '.sql')
  let dumpToFilePath = path.join(__dirname, '../db/', dumpToFileName)
  let result = null
  let oldFilePath = null
  let oldFileName = null
  let dumpTime = null

  try {
    result = await mysqldump({
      connection: database.connection,
      dump: {
        tables: database.dumpOptions.tables,
        excludeTables: database.dumpOptions.excludeTables
      },
      dumpToFile: dumpToFilePath,
      compressFile: database.compressFile
    })

    dumpTime = new Date().getTime()
  } catch (err) {
    db.get('exec').push({
      execUUID,
      uuid,
      success: false,
      objectName: null,
      objectStorageType: null,
      startTime,
      dumpTime: new Date().getTime(),
      uploadTime: new Date().getTime(),
      tables: null,
      createdTime: new Date().getTime()
    }).write()

    db.get('codes').find({
      uuid
    }).assign({
      lastExecTime: startTime,
      updatedTime: new Date().getTime()
    }).write()

    db.get('logs').push({
      action: 'create-mysqldump',
      success: false,
      execUUID,
      result: {
        uuid,
        dumpToFilePath,
        err,
        msg: '备份异常，请检查配置数据'
      },
      createdTime: new Date().getTime()
    }).write()

    fs.unlink(dumpToFilePath, (err) => {
      if (err) {
        db.get('logs').push({
          action: 'del-oldFile',
          success: false,
          execUUID,
          result: {
            uuid,
            dumpToFilePath,
            err
          },
          createdTime: new Date().getTime()
        }).write()
      }
    })

    return
  }

  try {
    if (result.tables) {
      // create a file to stream archive data to.
      if (database.encryptZipFile && database.zipPassword) {
        oldFilePath = dumpToFilePath
        oldFileName = dumpToFileName
        dumpToFileName = generateUuid() + '.zip'
        dumpToFilePath = path.join(__dirname, '../db/', dumpToFileName)
        const output = fs.createWriteStream(dumpToFilePath)
        const zipEncrypted = () => {
          return new Promise((resolve, reject) => {
            // create archive and specify method of encryption and password
            const archive = archiver.create('zip-encrypted', {
              zlib: {
                level: 8
              },
              encryptionMethod: 'aes256',
              password: database.zipPassword
            })

            // listen for all archive data to be written
            // 'close' event is fired only when a file descriptor is involved
            output.on('close', function () {
              resolve(archive.pointer()) // total bytes
            })

            // good practice to catch this error explicitly
            archive.on('error', function (err) {
              return reject(err)
            })

            // pipe archive data to the file
            archive.pipe(output)

            archive.append(fs.createReadStream(oldFilePath), {
              name: oldFileName
            })

            archive.finalize()
          })
        }

        await zipEncrypted()

        if (oldFilePath) {
          fs.unlink(oldFilePath, (err) => {
            if (err) {
              db.get('logs').push({
                action: 'del-oldFile',
                success: false,
                execUUID,
                result: {
                  uuid,
                  oldFilePath,
                  err
                },
                createdTime: new Date().getTime()
              }).write()
            }
          })
        }

        dumpTime = new Date().getTime()
      }

      const date = new Date()
      const MM = (date.getMonth() + 1 < 10 ? '0' + (date.getMonth() + 1) : date.getMonth() + 1)
      const DD = (date.getDate() < 10 ? '0' + (date.getDate()) : date.getDate())
      const objectName = '/mysql-backup/' + date.getFullYear() + '/' + MM + '/' + DD + '/' + dumpToFileName
      const uploadJobs = []

      if (!database.objectStorage || (typeof database.objectStorage === 'string' && database.objectStorage === '')) {
        db.get('exec').push({
          execUUID,
          uuid,
          success: false,
          objectName: null,
          objectStorageType: null,
          startTime,
          dumpTime,
          uploadTime: dumpTime,
          tables: result.tables.length,
          createdTime: new Date().getTime()
        }).write()

        db.get('codes').find({
          uuid
        }).assign({
          lastExecTime: startTime,
          updatedTime: new Date().getTime()
        }).write()

        db.get('logs').push({
          action: 'upload-backup',
          success: false,
          execUUID,
          result: {
            uuid,
            dumpToFilePath,
            msg: 'objectStorage字段异常，请检查配置数据。'
          },
          createdTime: new Date().getTime()
        }).write()

        fs.unlink(dumpToFilePath, (err) => {
          if (err) {
            db.get('logs').push({
              action: 'del-oldFile',
              success: false,
              execUUID,
              result: {
                uuid,
                dumpToFilePath,
                err
              },
              createdTime: new Date().getTime()
            }).write()
          }
        })

        return
      } else if (typeof database.objectStorage === 'string' && database.objectStorage.length > 0) {
        uploadJobs.push(upload(objectName, dumpToFilePath, database.objectStorage, execUUID))
      } else if (typeof database.objectStorage === 'object' && database.objectStorage.length > 0) {
        for (const n in database.objectStorage) {
          if (Number(n) > 0) {
            execUUID = generateUuid()
          }
          uploadJobs.push(upload(objectName, dumpToFilePath, database.objectStorage[n], execUUID))
        }
      }

      let jobTime = uploadJobs.length

      for (const n in uploadJobs) {
        uploadJobs[n].then(res => {
          jobTime--
          if (res.objectName) {
            // 写入日志
            db.get('exec').push({
              execUUID: res.execUUID,
              uuid,
              success: true,
              objectName: res.objectName,
              objectStorageType: res.objectStorageType,
              startTime,
              dumpTime,
              uploadTime: new Date().getTime(),
              tables: result.tables.length,
              createdTime: new Date().getTime()
            }).write()

            db.get('codes').find({
              uuid
            }).assign({
              lastExecTime: startTime,
              updatedTime: new Date().getTime()
            }).write()
          } else {
            db.get('exec').push({
              execUUID: res.execUUID,
              uuid,
              success: false,
              objectName: null,
              objectStorageType: res.objectStorageType,
              startTime,
              dumpTime,
              uploadTime: new Date().getTime(),
              tables: result.tables.length,
              createdTime: new Date().getTime()
            }).write()

            db.get('codes').find({
              uuid
            }).assign({
              lastExecTime: startTime,
              updatedTime: new Date().getTime()
            }).write()

            db.get('logs').push({
              action: 'upload-backup',
              success: false,
              execUUID: res.execUUID,
              result: {
                uuid,
                dumpToFilePath,
                msg: '上传备份异常，请检查对象存储配置或服务器网络。（重点检查是否开启了对应的对象存储）'
              },
              createdTime: new Date().getTime()
            }).write()
          }
        }).catch(err => {
          jobTime--
          db.get('exec').push({
            execUUID,
            uuid,
            success: false,
            objectName: null,
            objectStorageType: null,
            startTime,
            dumpTime,
            uploadTime: new Date().getTime(),
            tables: result.tables.length,
            createdTime: new Date().getTime()
          }).write()

          db.get('codes').find({
            uuid
          }).assign({
            lastExecTime: startTime,
            updatedTime: new Date().getTime()
          }).write()

          db.get('logs').push({
            action: 'upload-backup',
            success: false,
            execUUID,
            result: {
              uuid,
              dumpToFilePath,
              err,
              msg: '上传备份异常，请检查对象存储配置或服务器网络。'
            },
            createdTime: new Date().getTime()
          }).write()
        })
      }

      const delOldFile = () => {
        setTimeout(() => {
          if (jobTime <= 0) {
            if (dumpToFilePath) {
              fs.unlink(dumpToFilePath, (err) => {
                if (err) {
                  db.get('logs').push({
                    action: 'del-oldFile',
                    success: false,
                    execUUID,
                    result: {
                      uuid,
                      oldFilePath: dumpToFilePath,
                      err
                    },
                    createdTime: new Date().getTime()
                  }).write()
                }
              })
            }
          } else {
            delOldFile()
          }
        }, 1000)
      }

      delOldFile()
    } else {
      db.get('exec').push({
        execUUID,
        uuid,
        success: false,
        objectName: null,
        objectStorageType: null,
        startTime,
        dumpTime,
        uploadTime: dumpTime,
        tables: result.tables.length,
        createdTime: new Date().getTime()
      }).write()

      db.get('codes').find({
        uuid
      }).assign({
        lastExecTime: startTime,
        updatedTime: new Date().getTime()
      }).write()

      db.get('logs').push({
        action: 'create-mysqldump',
        success: false,
        execUUID,
        result: {
          uuid,
          dumpToFilePath,
          msg: '备份异常，请检查数据库连接'
        },
        createdTime: new Date().getTime()
      }).write()

      fs.unlink(dumpToFilePath, (err) => {
        if (err) {
          db.get('logs').push({
            action: 'del-oldFile',
            success: false,
            execUUID,
            result: {
              uuid,
              dumpToFilePath,
              err
            },
            createdTime: new Date().getTime()
          }).write()
        }
      })
    }
  } catch (err) {
    db.get('exec').push({
      execUUID,
      uuid,
      success: false,
      objectName: null,
      objectStorageType: null,
      startTime,
      dumpTime,
      uploadTime: dumpTime,
      tables: result.tables.length,
      createdTime: new Date().getTime()
    }).write()

    db.get('codes').find({
      uuid
    }).assign({
      lastExecTime: startTime,
      updatedTime: new Date().getTime()
    }).write()

    db.get('logs').push({
      action: 'zip-encrypted',
      success: false,
      execUUID,
      result: {
        uuid,
        dumpToFilePath,
        err,
        msg: '压缩异常，请检查压缩配置'
      },
      createdTime: new Date().getTime()
    }).write()

    fs.unlink(dumpToFilePath, (err) => {
      if (err) {
        db.get('logs').push({
          action: 'del-oldFile',
          success: false,
          execUUID,
          result: {
            uuid,
            dumpToFilePath,
            err
          },
          createdTime: new Date().getTime()
        }).write()
      }
    })

    if (oldFilePath) {
      fs.unlink(oldFilePath, (err) => {
        if (err) {
          db.get('logs').push({
            action: 'del-oldFile',
            success: false,
            execUUID,
            result: {
              uuid,
              oldFilePath,
              err
            },
            createdTime: new Date().getTime()
          }).write()
        }
      })
    }
  }
})()