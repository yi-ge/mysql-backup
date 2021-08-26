import { v4 as uuid } from 'uuid'
import auth from './auth.js'
import { join, dirname } from 'path'
import { Low, JSONFile } from 'lowdb'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SYSTEM_NAME = 'mysql-backup'
const isDev = process.env.NODE_ENV ? process.env.NODE_ENV === 'development' : false
// Use JSON file for storage
const file = join(isDev ? (join(__dirname, '../../db')) : (process.env.WORKPATH || 'db'), SYSTEM_NAME + '-db.json')
const adapter = new JSONFile(file)
const db = new Low(adapter)

// Read data from JSON file, this will set db.data content
await db.read()

db.data ||= {
  config: {},
  users: [],
  databases: [],
  exec: [],
  codes: [],
  download: [],
  logs: []
}

if (!db.data.users || db.data.users.length === 0) db.data.users = [{
  username: 'admin',
  password: auth.createPassword('admin888'),
  token: uuid(),
  isAdministrator: true,
  createdTime: new Date().getTime()
}]
if (!db.data.databases) db.data.databases = []
if (!db.data.exec) db.data.exec = []
if (!db.data.codes) db.data.codes = []
if (!db.data.download) db.data.download = []
if (!db.data.logs) db.data.logs = []

await db.write()

export default db
