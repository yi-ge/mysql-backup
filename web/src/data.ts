import { Activity, Archive, Database, LayoutDashboard, Settings } from 'lucide-react'

export const pages = [
  { id: 'overview', label: '总览', en: 'Overview', icon: LayoutDashboard },
  { id: 'plans', label: '备份计划', en: 'Plans', icon: Database },
  { id: 'runs', label: '运行记录', en: 'Runs', icon: Activity },
  { id: 'archives', label: '归档与恢复', en: 'Archives & recovery', icon: Archive },
  { id: 'settings', label: '设置', en: 'Settings', icon: Settings }
] as const

export type Page = typeof pages[number]['id']
export type Actor = { name: string; role: 'admin' | 'operator' | 'viewer' }
export type Provider = 'oss' | 'cos' | 'qiniu'
export const providers: Record<Provider, string> = { oss: '阿里云 OSS', cos: '腾讯云 COS', qiniu: '七牛云 Kodo' }
export const statuses: Record<string, string> = {
  queued: '排队中', running: '执行中', completed: '成功', partial: '部分成功', failed: '失败', unknown: '结果待核对',
  archived: '已归档', thawing: '解冻中', ready: '可访问',
  exporting: '导出 SQL', encrypting: '正在加密', uploading: '上传归档', finished: '已结束', migrated: '已迁移',
  checking_target: '检查目标库', downloading: '下载归档', importing: '导入 SQL', verified: '已验证',
  starting: '启动中', interrupted: '执行中断', backup_failed: '备份失败', restore_failed: '恢复失败'
}
export const errors: Record<string, string> = {
  auth_required: '会话已过期，请重新登录。', invalid_credentials: '用户名或密码不正确。',
  invalid_setup: '初始化代码无效或已使用。', weak_password: '密码至少需要 12 个字符。',
  rate_limited: '尝试次数过多，请稍后重试。', invalid_input: '请核对提交的字段。',
  forbidden: '当前账号没有权限执行此操作。', database_connection_failed: '数据库连接失败，请检查执行节点的网络和凭据。',
  revision_conflict: '此计划已被更新。请先重新载入。', invalid_schedule: '请检查 Cron 表达式和时区。',
  archive_unavailable: '归档尚不可用，请先解冻并检查状态。', archive_status_unknown: '暂时无法读取归档状态。',
  archive_decryption_failed: '无法使用备份时记录的密码解密归档。',
  archive_checksum_mismatch: '归档与原始校验和不匹配。', recovery_target_not_empty: '隔离目标库已有对象，恢复已停止。',
  recovery_target_conflicts_with_source: '恢复目标和源库的库名冲突。', recovery_target_unconfigured: '管理员尚未登记可用的隔离恢复库。',
  recovery_binlog_policy: '目标实例的二进制日志策略拦截了触发器导入。请检查隔离实例设置。',
  storage_credentials_required: '启用存储前，请填写访问密钥。', download_url_unconfigured: '执行节点尚未配置独立 HTTPS 下载地址。',
  worker_unavailable: '暂时无法连接备份执行节点。', worker_unconfigured: '请在此安装的数据目录配置执行节点地址。', upload_unconfirmed: '存储服务未确认上传。',
  operation_failed: '操作失败，请查看执行节点及运行记录。'
}

export type Connection = { host: string; port: number; database: string; user: string; password?: string; ssl?: object | null }
export type Plan = {
  id: string; name: string; serviceProvider?: string; notes?: string; enabled: boolean; cron: string; timezone: string;
  connection: Omit<Connection, 'ssl'> & { ssl?: boolean };
  tables: string[]; excludeTables: boolean; providers: Provider[]; encrypted: boolean; hasPassword: boolean;
  revision: number; nextAt: number | null; lastSuccessAt?: number | null; lastVerifiedAt?: number | null
}
export type ArchiveCopy = { id: string; provider: Provider; bytes: number | null; sha256: string | null; encrypted: boolean; availability: string }
export type Run = {
  id: string; planId: string; kind: 'backup' | 'restore'; actor: string; state: string; stage: string; createdAt: number;
  updatedAt: number; reason?: string; tables?: number; views?: number; trigger?: string; matchedOriginalChecksum?: boolean; targetMayContainData?: boolean;
  archives: ArchiveCopy[]; target?: { database: string }; destinations?: { provider: Provider; status: string; reason?: string }[]
}
export type Api = <T>(op: string, args?: object) => Promise<T>

export function stamp (time?: number | null) {
  return time ? new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(time) : '—'
}
export const size = (bytes: number | null) => bytes === null ? '—' : bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB'
export const errorText = (error: unknown) => {
  const code = error instanceof Error ? error.message : String(error)
  return errors[code] ?? ('操作未完成 · ' + code)
}
