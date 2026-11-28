import { z } from 'zod'
import { CronExpressionParser } from 'cron-parser'

export const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.:-]+$/).describe('Stable resource or request identifier')
export const provider = z.enum(['oss', 'cos', 'qiniu']).describe('Object storage provider')
const label = z.string().trim().min(1).max(120)
const password = z.string().max(4096)

export const connection = z.strictObject({
  host: z.string().min(1).max(255).describe('Host reachable from the backup worker'),
  port: z.coerce.number().int().min(1).max(65535).default(3306).describe('MySQL TCP port'),
  user: label.describe('MySQL account scoped to this database'),
  database: label.describe('Database schema to back up'),
  password: password.optional().describe('Replacement password. Omit to retain the saved credential'),
  charset: z.string().min(1).max(80).optional().describe('Optional mysql2 client collation'),
  ssl: z.strictObject({
    ca: z.string().max(65536).optional(), cert: z.string().max(65536).optional(),
    key: z.string().max(65536).optional(), rejectUnauthorized: z.literal(true).optional()
  }).nullable().optional().describe('Verified TLS, with optional CA and client certificate PEM')
}).describe('Structured MySQL connection settings')

export const planInput = z.strictObject({
  name: label.describe('Display name of the backup plan'),
  serviceProvider: z.string().max(120).optional().describe('Optional source hosting provider label'),
  notes: z.string().max(4000).optional().describe('Operator notes about this backup plan'),
  connection,
  cron: z.string().trim().min(1).max(100).describe('Five-field or six-field cron expression'),
  timezone: z.string().min(1).max(100).default('Asia/Shanghai').describe('Schedule IANA time zone'),
  enabled: z.boolean().default(true).describe('Whether this plan participates in scheduled execution'),
  tables: z.array(label).max(1000).default([]).describe('Tables selected by the table mode'),
  excludeTables: z.boolean().default(false).describe('Exclude the selected tables instead of including them'),
  providers: z.array(provider).min(1).max(3).refine(items => new Set(items).size === items.length).describe('Destinations for the uploaded archive'),
  archivePassword: password.optional().describe('Replacement AES ZIP password. Empty selects plain SQL')
}).superRefine((plan, ctx) => {
  try {
    CronExpressionParser.parse(plan.cron, { tz: plan.timezone }).next()
  } catch {
    ctx.addIssue({ code: 'custom', path: ['cron'], message: 'Invalid cron or time zone' })
  }
}).describe('Portable backup plan configuration')

export const providerSettings = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('oss'), enabled: z.boolean(), bucket: label,
    region: z.string().max(120).optional(), endpoint: z.url().optional(), cname: z.boolean().optional(),
    accessKeyId: password.optional(), accessKeySecret: password.optional(), secure: z.boolean().default(true),
    internal: z.boolean().optional(), timeout: z.number().int().min(1000).max(3600000).optional()
  }),
  z.strictObject({
    provider: z.literal('cos'), enabled: z.boolean(), bucket: label, region: label,
    SecretId: password.optional(), SecretKey: password.optional(), url: z.url().optional()
  }),
  z.strictObject({
    provider: z.literal('qiniu'), enabled: z.boolean(), bucket: label, zone: label,
    url: z.url(), accessKey: password.optional(), secretKey: password.optional()
  })
]).describe('Storage details and credential replacements for one provider')

export const storageKeys = { oss: 'OSS', cos: 'COS', qiniu: 'QINIU' }
export const secretFields = { oss: ['accessKeyId', 'accessKeySecret'], cos: ['SecretId', 'SecretKey'], qiniu: ['accessKey', 'secretKey'] }

export function schedulePreview (expression, timezone, from = Date.now()) {
  const iterator = CronExpressionParser.parse(expression, { currentDate: new Date(from), tz: timezone })
  return Array.from({ length: 3 }, () => iterator.next().getTime())
}

export class AppError extends Error {
  constructor (code, status = 400) {
    super(code)
    this.code = code
    this.status = status
  }
}

export function requireInput (schema, value) {
  const result = schema.safeParse(value)
  if (!result.success) throw new AppError('invalid_input')
  return result.data
}

export function publicPlan (plan) {
  const { password, ssl, ...source } = plan.connection
  return {
    id: plan.id, name: plan.name, serviceProvider: plan.serviceProvider, notes: plan.notes,
    cron: plan.cron, timezone: plan.timezone, enabled: plan.enabled,
    revision: plan.revision, tables: plan.tables, excludeTables: plan.excludeTables, providers: plan.providers,
    connection: { ...source, ssl: Boolean(ssl) }, hasPassword: Boolean(password), encrypted: Boolean(plan.archivePassword),
    updatedAt: plan.updatedAt
  }
}

export function publicStorage (settings, type) {
  const key = storageKeys[type]
  const { bucket = '', region = '', endpoint = '', zone = '', url = '', secure = true, cname = false,
    internal = false } = settings[key] ?? {}
  return {
    provider: type, enabled: Boolean(settings['use' + key]), bucket, region, endpoint, zone, url, secure, cname, internal,
    hasCredentials: secretFields[type].every(field => Boolean(settings[key]?.[field]))
  }
}
