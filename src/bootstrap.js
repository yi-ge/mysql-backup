import fs from 'fs'
import path from 'path'
import generateUuid from 'uuid'
import archiver from 'archiver'
import archiverZipEncrypted from 'archiver-zip-encrypted'
import mysqldump from 'mysqldump'
import schedule from 'node-schedule'
import upload from './lib/object-storage/upload.js'

// register format for archiver
// note: only do it once per Node.js process/application, as duplicate registration will throw an error
archiver.registerFormat('zip-encrypted', archiverZipEncrypted)

export default (db, log) => {
  log.warn('Cron is running...')

  const dbs = new Map()
  try {
    schedule.scheduleJob('* * * * *', function () {
      const databases = db.get('databases').cloneDeep().value()

      for (const n in databases) {
        if (!dbs.has(databases[n].uuid) || (dbs.has(databases[n].uuid) && dbs.get(databases[n].uuid).cron !== databases[n].cron)) {
          const uuid = databases[n].uuid
          const check = db.get('codes').find({
            uuid,
            deletedTime: null
          }).cloneDeep().value()

          if (!check) {
            return
          }

          const job = schedule.scheduleJob(databases[n].cron, async () => {
            const startTime = new Date().getTime()
            let execUUID = generateUuid.v4()
            const check = db.get('codes').find({
              uuid,
              deletedTime: null
            }).cloneDeep().value()

            if (!check) {
              return
            }

            const database = db.get('databases').find({
              uuid
            }).cloneDeep().value()

            let dumpToFileName = generateUuid.v4() + '.sql'
            let dumpToFilePath = path.join(__dirname, '../db/', dumpToFileName)
            let fileSize = 0
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
                compressFile: false
              })

              const stat = fs.statSync(dumpToFilePath)
              if (stat.isFile()) fileSize = stat.size

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
                fileSize,
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
                  dumpToFileName = generateUuid.v4() + '.zip'
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

                  fileSize = await zipEncrypted()

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
                    fileSize,
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
                      execUUID = generateUuid.v4()
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
                        fileSize,
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
                        fileSize,
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
                      fileSize,
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
                  fileSize,
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
                fileSize,
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
          })

          if (dbs.has(databases[n].uuid)) { // 如果已经存在任务，则取消旧任务
            const oldJob = dbs.get(databases[n].uuid)
            oldJob.job.cancel()
            log.debug('更新了定时任务：' + databases[n].uuid + ' (' + databases[n].cron + ')')
          } else {
            log.debug('创建了新定时任务：' + databases[n].uuid + ' (' + databases[n].cron + ')')
          }

          dbs.set(uuid, Object.assign(databases[n], {
            job
          }))
        }
      }
    })
  } catch (err) {
    log.error(err)
  }
}
