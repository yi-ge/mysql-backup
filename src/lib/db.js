import low from 'lowdb'
import path from 'path'
import uuid from 'uuid'
import auth from './auth.js'
import FileSync from 'lowdb/adapters/FileSync.js'

const SYSTEM_NAME = 'mysql-backup'
const isDev = process.env.NODE_ENV ? process.env.NODE_ENV === 'development' : false
const adapter = new FileSync(path.join((isDev ? null : process.env.WORKPATH) || 'db', SYSTEM_NAME + '-db.json'))
const db = low(adapter)

const initUser = () => {
  const users = db.get('users').value()
  if (users.length === 0) {
    const user = {
      username: 'admin',
      password: auth.createPassword('admin888'),
      token: uuid.v4(),
      isAdministrator: true,
      createdTime: new Date().getTime()
    }

    users.push(user)
    db.set('users', users).write()
  }
}

if (!db.get('config').value()) {
  db.defaults({
    config: {},
    users: [],
    databases: [],
    exec: [],
    codes: [],
    download: [],
    logs: []
  }).write()
}

if (!db.get('users').value()) db.set('users', []).write()
if (!db.get('databases').value()) db.set('databases', []).write()
if (!db.get('exec').value()) db.set('exec', []).write()
if (!db.get('codes').value()) db.set('codes', []).write()
if (!db.get('download').value()) db.set('download', []).write()
if (!db.get('logs').value()) db.set('logs', []).write()

initUser()

export default db
