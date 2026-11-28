import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { randomUUID as generateUUID } from 'node:crypto'
import { ZipWriterStream } from '@zip.js/zip.js'
import mysqldump from 'mysqldump'
import schedule from 'node-schedule'
import upload from './lib/object-storage/upload.js'
import sendSMS from './lib/sms/index.js'
import dayjs from 'dayjs'
import { workPath } from './lib/db.js'
import { backupConnection, backupTriggerOptions } from './lib/mysql.js'

const getObjectStorageType = (value) => {
  switch (value) {
    case 'qiniu':
      return '七牛云'
    case 'oss':
      return '阿里云'
    case 'cos':
      return '腾讯云'
  }
}

const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export default (db, log) => {
  log.warn('Cron is running...')

  const dbs = new Map()
  try {
    schedule.scheduleJob({
      rule: '* * * * *',
      tz: 'Asia/Shanghai'
    }, async function () {
      await db.read()
      const databases = db.data.databases

      for (const { uuid, cron, name } of databases) {
        const previous = dbs.get(uuid)
        if (!db.data.codes.some(item => item.uuid === uuid && !item.deletedTime)) {
          if (previous) {
            previous.job.cancel()
            dbs.delete(uuid)
          }
          continue
        }

        if (!previous || previous.cron !== cron) {
          // 每个数据库里面的任务
          const job = schedule.scheduleJob({
            rule: cron,
            tz: 'Asia/Shanghai'
          }, async () => {
            let success = false
            let execUUID = generateUUID()
            const startTime = new Date().getTime()

            await db.read()
            if (!db.data.codes.find(item => item.uuid === uuid && !item.deletedTime)) {
              return
            }

            const database = db.data.databases.find(i => i.uuid === uuid)

            let dumpToFileName = generateUUID() + '.sql'
            let dumpToFilePath = path.join(workPath, dumpToFileName)
            let fileSize = 0
            let result = null
            let oldFilePath = null
            let dumpTime = null

            try {
              result = await mysqldump({
                connection: backupConnection(database.connection),
                dump: {
                  tables: database.dumpOptions.tables,
                  excludeTables: database.dumpOptions.excludeTables,
                  trigger: backupTriggerOptions()
                },
                dumpToFile: dumpToFilePath,
                compressFile: false
              })

              const stat = fs.statSync(dumpToFilePath)
              if (stat.isFile()) fileSize = stat.size

              dumpTime = new Date().getTime()
            } catch (err) {
              db.data.exec.push({
                execUUID,
                uuid,
                success: false,
                objectName: null,
                objectStorageType: null,
                startTime,
                dumpTime: new Date().getTime(),
                uploadTime: new Date().getTime(),
                tables: null,
                fileSize,
                createdTime: new Date().getTime()
              })

              await db.write()

              if (!success) {
                log.debug('发送失败短信')
                sendSMS('failed', {
                  name,
                  createdTime: dayjs().format('MM月DD日HH:mm')
                })
              }

              const code = db.data.codes.find(i => i.uuid === uuid)
              Object.assign(code, {
                lastExecTime: startTime,
                updatedTime: new Date().getTime()
              })

              db.data.logs.push({
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
              })
              await db.write()

              fs.unlink(dumpToFilePath, async (err) => {
                if (err && err.code !== 'ENOENT') {
                  db.data.logs.push({
                    action: 'del-oldFile',
                    success: false,
                    execUUID,
                    result: {
                      uuid,
                      dumpToFilePath,
                      err
                    },
                    createdTime: new Date().getTime()
                  })
                  await db.write()
                }
              })

              return
            }

            try {
              if (result.tables) {
                // create a file to stream archive data to.
                if (database.encryptZipFile) {
                  if (typeof database.zipPassword !== 'string' || database.zipPassword.length === 0) {
                    throw new Error('zipPassword is required when encryptZipFile is enabled')
                  }

                  oldFilePath = dumpToFilePath
                  const oldFileName = dumpToFileName
                  dumpToFileName = generateUUID() + '.zip'
                  dumpToFilePath = path.join(workPath, dumpToFileName)
                  const archive = new ZipWriterStream({
                    level: 8,
                    encryptionStrength: 3,
                    password: database.zipPassword
                  })
                  const output = fs.createWriteStream(dumpToFilePath)
                  await pipeline(fs.createReadStream(oldFilePath), archive.transform(oldFileName), output)
                  fileSize = output.bytesWritten

                  if (oldFilePath) {
                    fs.unlink(oldFilePath, async (err) => {
                      if (err) {
                        db.data.logs.push({
                          action: 'del-oldFile',
                          success: false,
                          execUUID,
                          result: {
                            uuid,
                            oldFilePath,
                            err
                          },
                          createdTime: new Date().getTime()
                        })
                        await db.write()
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

                const storage = database.objectStorage
                if (!(typeof storage === 'string' && storage.length) && !(Array.isArray(storage) && storage.length)) {
                  db.data.exec.push({
                    execUUID,
                    uuid,
                    success: false,
                    objectName: null,
                    objectStorageType: null,
                    startTime,
                    dumpTime,
                    uploadTime: dumpTime,
                    tables: result.tables.length,
                    fileSize,
                    createdTime: new Date().getTime()
                  })

                  await db.write()

                  if (!success) {
                    log.debug('发送失败短信')
                    sendSMS('failed', {
                      name,
                      createdTime: dayjs().format('MM月DD日HH:mm')
                    })
                  }

                  const code = db.data.codes.find(i => i.uuid === uuid)
                  Object.assign(code, {
                    lastExecTime: startTime,
                    updatedTime: new Date().getTime()
                  })

                  db.data.logs.push({
                    action: 'upload-backup',
                    success: false,
                    execUUID,
                    result: {
                      uuid,
                      dumpToFilePath,
                      msg: 'objectStorage字段异常，请检查配置数据。'
                    },
                    createdTime: new Date().getTime()
                  })

                  await db.write()

                  fs.unlink(dumpToFilePath, async (err) => {
                    if (err) {
                      db.data.logs.push({
                        action: 'del-oldFile',
                        success: false,
                        execUUID,
                        result: {
                          uuid,
                          dumpToFilePath,
                          err
                        },
                        createdTime: new Date().getTime()
                      })

                      await db.write()
                    }
                  })

                  return
                } else if (typeof storage === 'string') {
                  uploadJobs.push(upload(objectName, dumpToFilePath, storage, execUUID))
                } else {
                  for (const n in storage) {
                    if (Number(n) > 0) {
                      execUUID = generateUUID()
                    }
                    uploadJobs.push(upload(objectName, dumpToFilePath, storage[n], execUUID))
                  }
                }

                let jobTime = uploadJobs.length

                for (const n in uploadJobs) {
                  uploadJobs[n].then(async res => {
                    jobTime--
                    if (res.objectName) {
                      // 写入日志
                      const createdTime = new Date().getTime()

                      success = true
                      db.data.exec.push({
                        name,
                        execUUID: res.execUUID,
                        uuid,
                        success: true,
                        objectName: res.objectName,
                        objectStorageType: res.objectStorageType,
                        startTime,
                        dumpTime,
                        uploadTime: createdTime,
                        tables: result.tables.length,
                        fileSize,
                        createdTime,
                      })

                      const code = db.data.codes.find(i => i.uuid === uuid)
                      Object.assign(code, {
                        lastExecTime: startTime,
                        updatedTime: new Date().getTime()
                      })
                      await db.write()

                      log.debug('发送成功短信')
                      sendSMS('success', {
                        name,
                        createdTime: dayjs().format('MM月DD日HH:mm'),
                        fileSize: formatBytes(fileSize),
                        tablesSum: String(result.tables.length),
                        dumpTime: String((dumpTime - startTime) / 1000),
                        objectStorageType: getObjectStorageType(res.objectStorageType),
                        uploadTime: String((createdTime - dumpTime) / 1000),
                        jobTime: String((createdTime - startTime) / 1000)
                      })
                    } else {
                      db.data.exec.push({
                        execUUID: res.execUUID,
                        uuid,
                        success: false,
                        objectName: null,
                        objectStorageType: res.objectStorageType,
                        startTime,
                        dumpTime,
                        uploadTime: new Date().getTime(),
                        tables: result.tables.length,
                        fileSize,
                        createdTime: new Date().getTime()
                      })
                      await db.write()

                      if (!success) {
                        log.debug('发送失败短信')
                        sendSMS('failed', {
                          name,
                          createdTime: dayjs().format('MM月DD日HH:mm')
                        })
                      }

                      const code = db.data.codes.find(i => i.uuid === uuid)
                      Object.assign(code, {
                        lastExecTime: startTime,
                        updatedTime: new Date().getTime()
                      })
                      await db.write()

                      db.data.logs.push({
                        action: 'upload-backup',
                        success: false,
                        execUUID: res.execUUID,
                        result: {
                          uuid,
                          dumpToFilePath,
                          msg: '上传备份异常，请检查对象存储配置或服务器网络。（重点检查是否开启了对应的对象存储）'
                        },
                        createdTime: new Date().getTime()
                      })
                      await db.write()
                    }
                  }).catch(async err => {
                    jobTime--
                    db.data.exec.push({
                      execUUID,
                      uuid,
                      success: false,
                      objectName: null,
                      objectStorageType: null,
                      startTime,
                      dumpTime,
                      uploadTime: new Date().getTime(),
                      tables: result.tables.length,
                      fileSize,
                      createdTime: new Date().getTime()
                    })
                    await db.write()

                    if (!success) {
                      log.debug('发送失败短信')
                      sendSMS('failed', {
                        name,
                        createdTime: dayjs().format('MM月DD日HH:mm')
                      })
                    }

                    const code = db.data.codes.find(i => i.uuid === uuid)
                    Object.assign(code, {
                      lastExecTime: startTime,
                      updatedTime: new Date().getTime()
                    })
                    await db.write()

                    db.data.logs.push({
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
                    })
                    await db.write()
                  })
                }

                const delOldFile = () => {
                  setTimeout(() => {
                    if (jobTime <= 0) {
                      if (dumpToFilePath) {
                        fs.unlink(dumpToFilePath, async (err) => {
                          if (err) {
                            db.data.logs.push({
                              action: 'del-oldFile',
                              success: false,
                              execUUID,
                              result: {
                                uuid,
                                oldFilePath: dumpToFilePath,
                                err
                              },
                              createdTime: new Date().getTime()
                            })
                            await db.write()
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
                db.data.exec.push({
                  execUUID,
                  uuid,
                  success: false,
                  objectName: null,
                  objectStorageType: null,
                  startTime,
                  dumpTime,
                  uploadTime: dumpTime,
                  tables: result.tables.length,
                  fileSize,
                  createdTime: new Date().getTime()
                })
                await db.write()

                if (!success) {
                  log.debug('发送失败短信')
                  sendSMS('failed', {
                    name,
                    createdTime: dayjs().format('MM月DD日HH:mm')
                  })
                }

                const code = db.data.codes.find(i => i.uuid === uuid)
                Object.assign(code, {
                  lastExecTime: startTime,
                  updatedTime: new Date().getTime()
                })

                db.data.logs.push({
                  action: 'create-mysqldump',
                  success: false,
                  execUUID,
                  result: {
                    uuid,
                    dumpToFilePath,
                    msg: '备份异常，请检查数据库连接'
                  },
                  createdTime: new Date().getTime()
                })

                await db.write()

                fs.unlink(dumpToFilePath, async (err) => {
                  if (err) {
                    db.data.logs.push({
                      action: 'del-oldFile',
                      success: false,
                      execUUID,
                      result: {
                        uuid,
                        dumpToFilePath,
                        err
                      },
                      createdTime: new Date().getTime()
                    })

                    await db.write()
                  }
                })
              }
            } catch (err) {
              db.data.exec.push({
                execUUID,
                uuid,
                success: false,
                objectName: null,
                objectStorageType: null,
                startTime,
                dumpTime,
                uploadTime: dumpTime,
                tables: result.tables.length,
                fileSize,
                createdTime: new Date().getTime()
              })
              await db.write()

              if (!success) {
                log.debug('发送失败短信')
                sendSMS('failed', {
                  name,
                  createdTime: dayjs().format('MM月DD日HH:mm')
                })
              }

              Object.assign(db.data.codes.find(i => i.uuid === uuid), {
                lastExecTime: startTime,
                updatedTime: new Date().getTime()
              })
              await db.write()

              db.data.logs.push({
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
              })
              await db.write()

              fs.unlink(dumpToFilePath, async (err) => {
                if (err) {
                  db.data.logs.push({
                    action: 'del-oldFile',
                    success: false,
                    execUUID,
                    result: {
                      uuid,
                      dumpToFilePath,
                      err
                    },
                    createdTime: new Date().getTime()
                  })

                  await db.write()
                }
              })

              if (oldFilePath) {
                fs.unlink(oldFilePath, async (err) => {
                  if (err) {
                    db.data.logs.push({
                      action: 'del-oldFile',
                      success: false,
                      execUUID,
                      result: {
                        uuid,
                        oldFilePath,
                        err
                      },
                      createdTime: new Date().getTime()
                    })

                    await db.write()
                  }
                })
              }
            }
          })

          if (previous) {
            previous.job.cancel()
            dbs.delete(uuid)
          }

          if (!job) {
            log.error({ uuid, cron }, '无效的定时任务')
            continue
          }
          job.on('error', err => log.error(err))
          dbs.set(uuid, { cron, job })
          log.debug((previous ? '更新了定时任务：' : '创建了新定时任务：') + uuid + ' (' + cron + ')')
        }
      }
    }).on('error', err => log.error(err))
  } catch (err) {
    log.error(err)
  }
}
