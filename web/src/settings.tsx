import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ActionForm } from './action-form'
import { Check, KeyRound, Save, Server, Users } from 'lucide-react'
import { errorText, providers, stamp } from './data'
import type { Actor, Api, Provider } from './data'

type Storage = { provider: Provider; enabled: boolean; bucket: string; region: string; endpoint: string; zone: string; url: string; secure: boolean; cname: boolean; internal: boolean; hasCredentials: boolean }
type AccessToken = { id: string; label: string; scope: string; created: number }
type Notify = { enabled: string; appid?: string; phoneNumbers?: string[]; action?: string[]; templateIDs?: Record<string, string>; smsSign?: string; hasKey?: boolean }
const keyFields: Record<Provider, [string, string]> = { oss: ['accessKeyId', 'accessKeySecret'], cos: ['SecretId', 'SecretKey'], qiniu: ['accessKey', 'secretKey'] }

export function SettingsPage ({ api, actor, recoveryTarget, onSaved }: { api: Api; actor: Actor; recoveryTarget: string | null; onSaved: () => void }) {
  const [storage, setStorage] = useState<Storage[]>([])
  const [members, setMembers] = useState<Actor[]>([])
  const [tokens, setTokens] = useState<AccessToken[]>([])
  const [notify, setNotify] = useState<Notify>({ enabled: 'off' })
  const [generated, setGenerated] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let current = true
    async function load () {
      try {
        const credentials = await api<AccessToken[]>('tokens.list')
        if (!current) return
        setTokens(credentials)
        if (actor.role === 'admin') {
          const [stores, users, preferences] = await Promise.all([api<Storage[]>('storage.list'), api<Actor[]>('members.list'), api<Notify>('notifications.get')])
          if (current) { setStorage(stores); setMembers(users); setNotify(preferences) }
        }
      } catch (err) { if (current) setError(errorText(err)) }
    }
    void load()
    return () => { current = false }
  }, [api, actor.role])

  async function act (event: FormEvent<HTMLFormElement>, callback: (form: FormData) => Promise<void>) {
    event.preventDefault()
    const form = event.currentTarget
    setError(''); setMessage(''); setPending(true)
    try {
      await callback(new FormData(form)); setMessage('已保存'); onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally { setPending(false) }
  }

  return <div className="settings-content">
    <section className="panel settings-section">
      <h2><Server size={18}/> 执行节点</h2>
      <p className="muted">恢复演练目标 <strong>{recoveryTarget ?? '未配置'}</strong></p>
      <p className="muted">隔离库由执行节点管理员配置，应用从备份归档导入到空库。</p>
    </section>
    {actor.role === 'admin' && <>
      <section className="panel settings-section"><h2>对象存储</h2>
        {storage.map(config => <details key={config.provider}><summary>{providers[config.provider]} <span className="muted">{config.enabled ? config.bucket : '未启用'}</span></summary>
          <ActionForm onSubmit={e => void act(e, async form => {
            const type = config.provider
            const [keyId, secret] = keyFields[type]
            const optional = (key: string) => String(form.get(key) ?? '') || undefined
            const fields = type === 'oss' ? { region: optional('region'), endpoint: optional('endpoint'), secure: form.has('secure'), cname: form.has('cname'), internal: form.has('internal') } :
              type === 'qiniu' ? { zone: optional('zone'), url: optional('url') } : { region: optional('region') }
            const saved = await api<Storage>('storage.save', { provider: type, enabled: form.has('enabled'), bucket: form.get('bucket'), ...fields, [keyId]: optional('key'), [secret]: optional('secret') })
            setStorage(previous => previous.map(item => item.provider === type ? saved : item))
          })}>
            <div className="form-grid">
              <label>Bucket<input name="bucket" defaultValue={config.bucket} required/></label>
              {config.provider !== 'qiniu' && <label>区域<input name="region" defaultValue={config.region}/></label>}
              {config.provider === 'qiniu' && <>
                <label>机房<input name="zone" defaultValue={config.zone || 'Zone_z0'} required/></label>
                <label>下载域名<input name="url" type="url" defaultValue={config.url} required/></label>
              </>}
              {config.provider === 'oss' && <label>自定义 Endpoint<input name="endpoint" type="url" defaultValue={config.endpoint}/></label>}
              <label>访问密钥 ID<input name="key" autoComplete="off" placeholder={config.hasCredentials ? '保留现有密钥' : ''}/></label>
              <label>访问密钥<input name="secret" type="password" autoComplete="new-password" placeholder={config.hasCredentials ? '保留现有密钥' : ''}/></label>
            </div>
            <div className="row">
              <label className="check"><input name="enabled" type="checkbox" defaultChecked={config.enabled}/> 启用</label>
              {config.provider === 'oss' && <>
                <label className="check"><input name="secure" type="checkbox" defaultChecked={config.secure}/> HTTPS</label>
                <label className="check"><input name="cname" type="checkbox" defaultChecked={config.cname}/> CNAME</label>
                <label className="check"><input name="internal" type="checkbox" defaultChecked={config.internal}/> 内网</label>
              </>}
              <button type="submit" disabled={pending}><Save size={15}/> 保存</button>
            </div>
          </ActionForm>
        </details>)}
      </section>
      <section className="panel settings-section"><h2>短信通知</h2>
        <ActionForm key={notify.enabled} onSubmit={e => void act(e, async form => {
          const enable = String(form.get('enable'))
          const data = enable === 'off' ? { enable } : {
            enable, appid: String(form.get('appid')), appkey: String(form.get('appkey')) || undefined,
            smsSign: String(form.get('smsSign') ?? ''), phoneNumbers: String(form.get('numbers')).split(/[,，\s]+/).filter(Boolean),
            action: form.getAll('action'), templateIDs: { success: String(form.get('successId')), failed: String(form.get('failedId')) }
          }
          await api('notifications.save', data)
          setNotify(await api<Notify>('notifications.get'))
        })}>
          <div className="form-grid">
            <label>提供商<select name="enable" defaultValue={notify.enabled}><option value="off">停用</option><option value="tencent">腾讯云短信</option><option value="submail">SUBMAIL</option></select></label>
            <label>应用 ID<input name="appid" defaultValue={notify.appid}/></label>
            <label>应用密钥<input name="appkey" type="password" autoComplete="new-password" placeholder={notify.hasKey ? '保留现有密钥' : ''}/></label>
            <label>接收手机号<input name="numbers" defaultValue={notify.phoneNumbers?.join(', ')}/></label>
            <label>成功模板<input name="successId" defaultValue={notify.templateIDs?.success}/></label>
            <label>失败模板<input name="failedId" defaultValue={notify.templateIDs?.failed}/></label>
            <label>短信签名<input name="smsSign" defaultValue={notify.smsSign}/></label>
          </div>
          <div className="row"><label className="check"><input name="action" type="checkbox" value="success" defaultChecked={notify.action?.includes('success')}/> 成功</label>
            <label className="check"><input name="action" type="checkbox" value="failed" defaultChecked={notify.action?.includes('failed')}/> 失败</label>
            <button type="submit" disabled={pending}>保存通知</button></div>
        </ActionForm>
      </section>
      <section className="panel settings-section"><h2><Users size={18}/> 成员</h2>
        {members.map(user => <p className="member" key={user.name}><strong>{user.name}</strong><span>{user.role}</span></p>)}
        <ActionForm onSubmit={e => void act(e, async form => {
          await api('members.save', { name: form.get('name'), password: form.get('password'), role: form.get('role') })
          setMembers(await api<Actor[]>('members.list'))
        })}>
          <div className="form-grid">
            <label>用户名<input name="name" required/></label>
            <label>初始或替换密码<input name="password" type="password" autoComplete="new-password" minLength={12} required/></label>
            <label>权限<select name="role"><option value="operator">操作员</option><option value="viewer">只读</option><option value="admin">管理员</option></select></label>
          </div>
          <button type="submit" disabled={pending}>保存成员</button>
        </ActionForm>
      </section>
    </>}
    <section className="panel settings-section"><h2><KeyRound size={18}/> Agent 工具令牌</h2>
      <p className="muted">在 DesireCore 添加 Streamable HTTP MCP，使用执行节点的 <code>/mcp</code> 和保存在凭据库中的 Bearer 令牌。</p>
      {tokens.map(token => <div className="member" key={token.id}><span>{token.label} · {token.scope} · {stamp(token.created)}</span>
        <button disabled={pending} onClick={() => { void api('tokens.revoke', { id: token.id }).then(() => setTokens(list => list.filter(item => item.id !== token.id))).catch(err => setError(errorText(err))) }}>撤销</button></div>)}
      {actor.role !== 'viewer' && <ActionForm onSubmit={e => void act(e, async form => {
        const result = await api<{ token: string }>('tokens.create', { label: form.get('label'), scope: form.get('scope') })
        setGenerated(result.token); setTokens(await api<AccessToken[]>('tokens.list'))
      })}>
        <div className="form-grid"><label>令牌名称<input name="label" required placeholder="例如 DesireCore 巡检"/></label>
          <label>范围<select name="scope"><option value="read">只读</option><option value="operate">操作</option></select></label></div>
        <button type="submit" disabled={pending}>生成令牌</button>
      </ActionForm>}
      {generated && <label className="token">令牌仅显示一次<input value={generated} readOnly onFocus={e => e.target.select()}/><button onClick={() => setGenerated('')}>隐藏</button></label>}
    </section>
    {message && <p className="success" role="status"><Check size={15}/> {message}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>
}
