import { randomUUID } from 'node:crypto'
import auth from './auth.js'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'

const SYSTEM_NAME = 'mysql-backup'
const isDev = process.env.NODE_ENV ? process.env.NODE_ENV === 'development' : false
// Use JSON file for storage
export const workPath = isDev ? join(import.meta.dirname, '../../db') : (process.env.WORKPATH || 'db')
await mkdir(workPath, { recursive: true })
const file = join(workPath, SYSTEM_NAME + '-db.json')
const adapter = new JSONFile(file)
const db = new Low(adapter, {
  config: {},
  users: [],
  databases: [],
  exec: [],
  codes: [],
  download: [],
  logs: []
})

await db.read()

if (!db.data.users || db.data.users.length === 0) db.data.users = [{
  username: 'admin',
  password: auth.createPassword('admin888'),
  token: randomUUID(),
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
