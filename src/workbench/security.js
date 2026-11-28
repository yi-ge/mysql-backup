import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const derive = promisify(scrypt)
export const digest = value => createHash('sha256').update(value).digest('hex')
export const token = () => randomBytes(32).toString('base64url')

export function equals (left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function hashPassword (password) {
  const salt = randomBytes(16)
  const bytes = await derive(password, salt, 64)
  return 'scrypt:' + salt.toString('hex') + ':' + bytes.toString('hex')
}

export async function verifyPassword (password, saved) {
  if (/^[a-f0-9]{128}$/i.test(saved)) return equals(createHash('sha512').update(password).digest('hex'), saved.toLowerCase())
  const [format, salt, hash] = saved.split(':')
  if (format !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hash)) return false
  return equals(await derive(password, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'))
}

export function openVault (root) {
  const path = join(root, '.workbench-key')
  try { writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' }) } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  const key = readFileSync(path)
  if (key.length !== 32) throw new Error('Invalid workbench encryption key')
  return {
    seal (value, purpose) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(purpose))
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
    },
    open (value, purpose) {
      const bytes = Buffer.from(value, 'base64')
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      cipher.setAAD(Buffer.from(purpose))
      cipher.setAuthTag(bytes.subarray(12, 28))
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'))
    }
  }
}
