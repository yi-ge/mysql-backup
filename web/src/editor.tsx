import { useState } from 'react'
import type { FormEvent } from 'react'
import { ActionForm } from './action-form'
import { ArrowLeft, Check, Plug, Save } from 'lucide-react'
import { errorText, providers, stamp } from './data'
import type { Api, Plan, Provider } from './data'

export function PlanEditor ({ plan, api, returnLabel, onBack, onDiscard, onSave }: {
  plan?: Plan; api: Api; returnLabel: string; onBack: () => void; onDiscard: () => void; onSave: (p: Plan) => void
}) {
  const [name, setName] = useState(plan?.name ?? '')
  const [serviceProvider, setServiceProvider] = useState(plan?.serviceProvider ?? '')
  const [notes, setNotes] = useState(plan?.notes ?? '')
  const [source, setSource] = useState({ host: plan?.connection.host ?? '', port: plan?.connection.port ?? 3306, user: plan?.connection.user ?? '', database: plan?.connection.database ?? '' })
  const [password, setPassword] = useState('')
  const [tls, setTls] = useState(plan?.connection.ssl ?? false)
  const [archivePassword, setArchivePassword] = useState('')
  const [encrypted, setEncrypted] = useState(plan?.encrypted ?? false)
  const [cron, setCron] = useState(plan?.cron ?? '0 2 * * *')
  const [timezone, setTimezone] = useState(plan?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [mode, setMode] = useState(plan?.tables.length ? (plan.excludeTables ? 'exclude' : 'include') : 'all')
  const [tables, setTables] = useState(plan?.tables.join('\n') ?? '')
  const [targets, setTargets] = useState<Provider[]>(plan?.providers ?? ['oss'])
  const [preview, setPreview] = useState<number[]>([])
  const [available, setAvailable] = useState<{ name: string; type: string }[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const connect = { ...source, ...(password || !plan ? { password } : {}),
    ...(tls === Boolean(plan?.connection.ssl) ? {} : { ssl: tls ? {} : null }) }
  async function act (callback: () => Promise<void>) {
    setPending(true); setError(''); setMessage('')
    try { await callback() } catch (err) { setError(errorText(err)) } finally { setPending(false) }
  }

  function save (event: FormEvent) {
    event.preventDefault()
    void act(async () => {
      const selection = mode === 'all' ? [] : [...new Set(tables.split(/[\n,，]+/).map(item => item.trim()).filter(Boolean))]
      if (mode !== 'all' && !selection.length) throw new Error('请填写至少一张表')
      if (encrypted && !archivePassword && !plan?.encrypted) throw new Error('请填写归档密码')
      if (!targets.length) throw new Error('请选择至少一个存储')
      onSave(await api<Plan>('plans.save', {
        ...(plan && { planId: plan.id, revision: plan.revision }),
        plan: { name, serviceProvider, notes, connection: connect, cron, timezone, enabled: plan?.enabled ?? true, tables: selection, excludeTables: mode === 'exclude',
          providers: targets, ...(!encrypted || archivePassword ? { archivePassword: encrypted ? archivePassword : '' } : {}) }
      }))
    })
  }

  return <ActionForm className="editor" onSubmit={save}>
    <button className="quiet back" type="button" onClick={onBack}><ArrowLeft size={16}/> 返回{returnLabel}</button>
    <h1>{plan ? '编辑备份计划' : '新建备份计划'}</h1>
    <section><h2>数据库连接</h2>
      <div className="form-grid">
        <label>计划名称<input value={name} onChange={e => setName(e.target.value)} required maxLength={120}/></label>
        <label>数据库<input value={source.database} onChange={e => setSource({ ...source, database: e.target.value })} required/></label>
        <label>主机<input value={source.host} onChange={e => setSource({ ...source, host: e.target.value })} required/></label>
        <label>端口<input type="number" min="1" max="65535" value={source.port} onChange={e => setSource({ ...source, port: Number(e.target.value) })} required/></label>
        <label>用户名<input value={source.user} onChange={e => setSource({ ...source, user: e.target.value })} required/></label>
        <label>密码<input type="password" autoComplete="new-password" value={password} placeholder={plan?.hasPassword ? '留空保留现有凭据' : ''} onChange={e => setPassword(e.target.value)}/></label>
        <label>服务商<input value={serviceProvider} onChange={e => setServiceProvider(e.target.value)} maxLength={120}/></label>
        <label>备注<textarea value={notes} onChange={e => setNotes(e.target.value)} maxLength={4000}/></label>
      </div>
      <div className="row"><label className="check"><input type="checkbox" checked={tls} onChange={e => setTls(e.target.checked)}/> 使用 TLS</label>
        <button type="button" disabled={pending} onClick={() => void act(async () => {
          const result = await api<{ name: string; type: string }[]>('plans.test', { planId: plan?.id, connection: connect })
          setAvailable(result); setMessage('连接成功 · ' + result.length + ' 个表和视图')
        })}><Plug size={15}/> 测试连接</button></div>
    </section>
    <section><h2>表范围与计划</h2><div className="form-grid">
      <label>表范围<select value={mode} onChange={e => setMode(e.target.value)}><option value="all">全部表和视图</option><option value="include">仅备份以下表</option><option value="exclude">排除以下表</option></select></label>
      {mode !== 'all' && <label>表名（每行一个）<textarea value={tables} onChange={e => setTables(e.target.value)}/></label>}
      <label>Cron 表达式<input value={cron} onChange={e => { setCron(e.target.value); setPreview([]) }} required/></label>
      <label>时区<input value={timezone} onChange={e => { setTimezone(e.target.value); setPreview([]) }} required/></label>
    </div>
      {mode !== 'all' && available.length > 0 && <div className="row table-choices">{available.slice(0, 30).map(item => <button type="button" key={item.name} onClick={() => setTables(value => value ? value + '\n' + item.name : item.name)}>{item.name}</button>)}</div>}
      <button type="button" disabled={pending} onClick={() => void act(async () => setPreview(await api<number[]>('plans.preview', { cron, timezone })))}>预览执行时间</button>
      {preview.length > 0 && <p className="muted">本机时间 · {preview.map(stamp).join(' / ')}</p>}
    </section>
    <section><h2>存储与加密</h2><div className="row">{(Object.keys(providers) as Provider[]).map(id =>
      <label className="check" key={id}><input type="checkbox" checked={targets.includes(id)} onChange={e => setTargets(e.target.checked ? [...targets, id] : targets.filter(item => item !== id))}/>{providers[id]}</label>)}</div>
      <label className="check"><input type="checkbox" checked={encrypted} onChange={e => setEncrypted(e.target.checked)}/> AES-256 ZIP 加密</label>
      {encrypted && <label>归档密码<input type="password" autoComplete="new-password" placeholder={plan?.encrypted ? '留空保留现有密码' : ''} value={archivePassword} onChange={e => setArchivePassword(e.target.value)}/></label>}
    </section>
    {message && <p className="success" role="status"><Check size={15}/> {message}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="editor-footer"><button type="button" onClick={onDiscard}>放弃修改</button><button className="primary" disabled={pending} type="submit"><Save size={16}/> 保存计划</button></div>
  </ActionForm>
}
