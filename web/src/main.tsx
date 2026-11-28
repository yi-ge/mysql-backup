import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ActionForm } from './action-form'
import { createRoot } from 'react-dom/client'
import { Activity, Archive, ArrowDownToLine, ArrowRight, ArrowUpRight, CircleCheck, CircleHelp, Database, HardDrive, LogOut, Plus, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react'
import { PlanEditor } from './editor'
import { SettingsPage } from './settings'
import { connectHost, investigate } from './host'
import { useRunHistory } from './history'
import { errorText, pages, providers, size, stamp, statuses } from './data'
import type { Actor, Api, ArchiveCopy, Page, Plan, Run } from './data'
import './style.css'

type Session = { session: string; actor: Actor; recoveryTarget: string | null }
type Envelope<T> = { ok: true; data: T } | { ok: false; code: string }

async function call<T> (op: string, args = {}, session?: string): Promise<T> {
  const result = await fetch('/console/v1', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, args, session })
  })
  const payload: Envelope<T> = await result.json().catch(() => ({ ok: false, code: 'worker_unavailable' }))
  if (!payload.ok) throw new Error(payload.code)
  return payload.data
}
const badgeTone = (state: string) => state === 'completed' || state === 'ready' ? 'positive' : state === 'failed' ? 'negative' : state === 'archived' ? 'neutral' : 'pending'
const Badge = ({ state }: { state: string }) => <span className={'pill ' + badgeTone(state)}><span/> {statuses[state] ?? state}</span>

function Login ({ onLogin }: { onLogin: (session: Session) => void }) {
  const [setup, setSetup] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void call<{ setupRequired: boolean }>('public.status').then(result => { setSetup(result.setupRequired); setReady(true) }).catch(err => setError(errorText(err)))
  }, [])
  async function submit (event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    setBusy(true); setError('')
    try {
      const session = await call<Session>(setup ? 'setup' : 'session.login', Object.fromEntries(values))
      onLogin(session)
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  return <main className="login"><div className="login-panel">
    <div className="brand-icon"><Database size={24}/></div>
    <h1>MySQL Backup</h1>
    <p className="muted">{setup ? '初始化备份工作台' : '登录备份工作台'}</p>
    {ready && <ActionForm onSubmit={e => void submit(e)}>
      {setup && <label>初始化代码<input name="code" autoComplete="off" required placeholder="执行节点数据目录中的 setup-code"/></label>}
      <label>用户名<input name="name" autoComplete="username" required/></label>
      <label>密码<input name="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} minLength={setup ? 12 : undefined} required/></label>
      <button type="submit" className="primary" disabled={busy}>{setup ? '创建管理员' : '登录'} <ArrowRight size={17}/></button>
    </ActionForm>}
    {error && <p className="error" role="alert">{error}</p>}
  </div></main>
}

function RunInspector ({ api, run, plan, canWrite, recoveryTarget, canDelegate, onClose, onRun, refresh }: {
  api: Api; run: Run; plan?: Plan; canWrite: boolean; recoveryTarget: string | null;
  canDelegate: boolean; onClose: () => void; onRun: (id: string) => void; refresh: () => void
}) {
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [drill, setDrill] = useState<ArchiveCopy | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [agent, setAgent] = useState<string | null>(null)
  const [download, setDownload] = useState<{ url: string; expiresAt: number } | null>(null)
  const restoreKey = useRef('')
  async function act (fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  return <aside aria-label="运行详情" className="inspector panel">
    <div className="inspector-title"><div><span className="eyeline">{run.kind === 'restore' ? '恢复演练' : '备份执行'}</span><h2>{plan?.name ?? run.planId}</h2></div>
      <button className="icon-button quiet" aria-label="关闭详情" onClick={onClose}><X size={18}/></button></div>
    <div className="row"><Badge state={run.state}/><span className="muted">{statuses[run.stage] ?? run.stage}</span></div>
    <dl className="facts"><dt>运行 ID</dt><dd className="mono">{run.id}</dd><dt>开始时间</dt><dd>{stamp(run.createdAt)}</dd>
      <dt>最后更新</dt><dd>{stamp(run.updatedAt)}</dd>{run.target && <><dt>恢复目标</dt><dd>{run.target.database}</dd></>}
      {run.tables !== undefined && <><dt>对象数量</dt><dd>{run.tables}{run.views ? ' 表 · ' + run.views + ' 视图' : ''}</dd></>}
      {run.matchedOriginalChecksum !== undefined && <><dt>原始校验和</dt><dd>{run.matchedOriginalChecksum ? '匹配' : '历史归档无记录'}</dd></>}
    </dl>
    {run.reason && <p className="error" role="status">{errorText(new Error(run.reason))}</p>}
    {run.targetMayContainData && <p className="muted">目标库可能已部分写入。请核对并准备新的空目标后再试。</p>}
    {run.destinations && run.destinations.length > 0 && <div className="detail-list">{run.destinations.map(item =>
      <span key={item.provider}><strong>{providers[item.provider]}</strong> {item.status === 'uploaded' ? '上传成功' : item.status === 'failed' ? '上传失败' : '待核对'}</span>)}</div>}
    {run.archives.length > 0 && <div className="archive-list"><h3>归档副本</h3>{run.archives.map(copy =>
      <article className="archive-copy" key={copy.id}><div className="row between"><strong>{providers[copy.provider]}</strong><Badge state={copy.availability}/></div>
        <p className="muted">{size(copy.bytes)} · {copy.encrypted ? 'AES ZIP' : 'SQL'}</p>
        {copy.sha256 && <p className="mono hash" title={copy.sha256}>SHA-256 {copy.sha256}</p>}
        <div className="row">
          <button disabled={busy} onClick={() => void act(async () => { await api('archive.status', { archiveId: copy.id }); refresh() })}>检查状态</button>
          {canWrite && copy.availability === 'archived' && <button disabled={busy} onClick={() => void act(async () => { await api('archive.thaw', { archiveId: copy.id }); refresh(); setNotice('已查询或提交解冻') })}>申请解冻</button>}
          {canWrite && copy.availability === 'ready' && <>
            <button disabled={busy} onClick={() => void act(async () => setDownload(await api('archive.download', { archiveId: copy.id })))}><ArrowDownToLine size={15}/> 申请下载</button>
            <button disabled={busy || !recoveryTarget} onClick={() => { setDrill(copy); setConfirmed(false); restoreKey.current = crypto.randomUUID() }}>隔离恢复</button>
          </>}
        </div>
      </article>)}</div>}
    {download && (window.desirecoreApp
      ? <div className="download"><label>限时下载地址<input readOnly value={download.url} onFocus={e => e.currentTarget.select()}/></label>
        <p className="muted">请在 {stamp(download.expiresAt)} 前将地址复制到浏览器打开。链接仅可使用一次。</p></div>
      : <p className="download"><a href={download.url} target="_blank" rel="noreferrer" onClick={() => setNotice('已打开授权下载入口')}><ArrowUpRight size={16}/> 打开限时下载</a></p>)}
    {drill && <ActionForm className="action-review" onSubmit={e => { e.preventDefault(); void act(async () => {
      const result = await api<Run>('restore.start', { archiveId: drill.id, target: recoveryTarget, requestId: restoreKey.current })
      setDrill(null); onRun(result.id); refresh()
    }) }}>
      <h3>确认隔离恢复</h3><p>将 {providers[drill.provider]} 的归档导入空库 <strong>{recoveryTarget}</strong>。</p>
      <label className="check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/> 我已核对目标库</label>
      <div className="row"><button type="button" onClick={() => setDrill(null)}>取消</button><button type="submit" className="primary" disabled={!confirmed || busy}>开始恢复</button></div>
    </ActionForm>}
    {canDelegate && <div className="agent-action">
      {agent === null ? <button onClick={() => setAgent('')}><Sparkles size={16}/> 交给 Agent 调查</button> :
        <ActionForm onSubmit={e => { e.preventDefault(); void act(async () => {
          await investigate(agent, run.planId, run.id, run.reason)
          setAgent(null); setNotice('已准备调查提案，请在 DesireCore 确认。')
        }) }}><label>目标 Agent ID<input autoFocus value={agent} onChange={e => setAgent(e.target.value)} required/></label>
          <div className="row"><button type="button" onClick={() => setAgent(null)}>取消</button><button type="submit" disabled={busy}>准备提案</button></div></ActionForm>}
    </div>}
    {notice && <p className="success" role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </aside>
}

function Workbench ({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [page, setPage] = useState<Page>(() => pages.find(p => p.id === location.hash.slice(1))?.id ?? 'overview')
  const [plans, setPlans] = useState<Plan[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [editor, setEditor] = useState<{ plan?: Plan; source: 'overview' | 'plans' } | null>(null)
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [online, setOnline] = useState(false)
  const [english, setEnglish] = useState(false)
  const [canDelegate, setCanDelegate] = useState(false)
  const [busyPlan, setBusyPlan] = useState<string | null>(null)
  const requestKey = useRef(new Map<string, string>())
  const canWrite = session.actor.role !== 'viewer'
  const api: Api = useCallback(async <T,>(op: string, args = {}) => {
    try { return await call<T>(op, args, session.session) } catch (err) {
      if (err instanceof Error && err.message === 'auth_required') onLogout()
      throw err
    }
  }, [session.session, onLogout])
  const reportError = useCallback((err: unknown) => setError(errorText(err)), [])
  const historyPage = useRunHistory(api, page, filter, reportError)

  useEffect(() => connectHost(info => {
    if (info.locale) { document.documentElement.lang = info.locale; setEnglish(info.locale === 'en-US') }
    if (info.capabilities) setCanDelegate(info.capabilities.includes('requestWork'))
    if (info.appearance?.colorScheme) document.documentElement.dataset.theme = info.appearance.colorScheme
  }), [])

  const refresh = useCallback(async () => {
    try {
      const [refreshed, history] = await Promise.all([api<Plan[]>('plans.list'), api<Run[]>('runs.list', { limit: 100 })])
      setPlans(refreshed); setRuns(history); setOnline(true)
    } catch (err) { setError(errorText(err)); setOnline(false) } finally { setLoaded(true) }
  }, [api])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(interval)
  }, [refresh])

  function navigate (destination: Page) {
    if (destination !== page) historyPage.reset()
    setPage(destination); setEditing(false)
    location.hash = destination
  }
  function openEditor (plan?: Plan) {
    if (!editor) setEditor({ plan, source: page === 'overview' ? 'overview' : 'plans' })
    navigate('plans')
    setEditing(true)
  }
  useEffect(() => {
    const handler = () => {
      const destination = pages.find(p => p.id === location.hash.slice(1))?.id ?? 'overview'
      if (destination !== page) { historyPage.reset(); setPage(destination) }
    }
    addEventListener('hashchange', handler)
    return () => removeEventListener('hashchange', handler)
  }, [historyPage.reset, page])

  function openRun (id: string) {
    setSelected(id)
    if (page !== 'archives') navigate('runs')
  }
  async function start (plan: Plan) {
    if (busyPlan) return
    setBusyPlan(plan.id); setError(''); setNotice('')
    const key = requestKey.current.get(plan.id) ?? crypto.randomUUID()
    requestKey.current.set(plan.id, key)
    try {
      const run = await api<Run>('runs.start', { planId: plan.id, requestId: key })
      requestKey.current.delete(plan.id)
      setRuns(previous => [run, ...previous.filter(item => item.id !== run.id)])
      openRun(run.id)
      setNotice('备份已排队')
    } catch (err) { setError(errorText(err)) } finally { setBusyPlan(null) }
  }
  async function toggle (plan: Plan) {
    try { await api('plans.toggle', { planId: plan.id, revision: plan.revision, enabled: !plan.enabled }); await refresh() } catch (err) { setError(errorText(err)) }
  }

  const showRuns = historyPage.listing?.runs ?? []
  const selectedRun = showRuns.find(item => item.id === selected) ?? runs.find(item => item.id === selected)
  const activePlans = plans.filter(plan => plan.enabled)
  const currentRuns = runs.filter(run => run.state === 'running' || run.state === 'queued')
  const failure = new Map<string, Run>()
  for (const run of runs) if (run.kind === 'backup' && !failure.has(run.planId)) failure.set(run.planId, run)
  const issues = [...failure.values()].filter(run => ['partial', 'failed', 'unknown'].includes(run.state))
  const pageLabel = pages.find(item => item.id === page)!
  const selectedPlan = plans.find(plan => plan.id === selectedRun?.planId)
  return <div className="app-shell">
    <header className="topbar">
      <div className="wordmark"><div className="brand-icon"><Database size={19}/></div><strong>MySQL Backup</strong></div>
      <div className="row top-actions"><span className={'node-status ' + (online ? 'positive' : 'neutral')}><span/> {loaded ? online ? '执行节点在线' : '执行节点不可达' : '连接执行节点'}</span>
        <button className="icon-button quiet" aria-label="退出登录" title={session.actor.name} onClick={() => { void api('session.logout').catch(() => {}).finally(onLogout) }}><LogOut size={18}/></button></div>
    </header>
    <nav className="navigation" aria-label="工作台导航">{pages.map(({ id, label, en, icon: Icon }) =>
      <button key={id} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={17}/> {english ? en : label}</button>)}</nav>

    <main className="workspace">
      {editor && <div hidden={!editing || page !== 'plans'}>
        <PlanEditor key={editor.plan?.id ?? 'new'} plan={editor.plan} api={api} returnLabel={editor.source === 'overview' ? '总览' : '备份计划'}
          onBack={() => navigate(editor.source)} onDiscard={() => { navigate(editor.source); setEditor(null) }}
          onSave={plan => { setPlans(old => [plan, ...old.filter(item => item.id !== plan.id)]); navigate(editor.source); setEditor(null); setNotice('备份计划已保存'); void refresh() }}/>
      </div>}
      {(!editor || !editing || page !== 'plans') && <>
        <div className="page-heading"><div><h1>{english ? pageLabel.en : pageLabel.label}</h1>
          <p className="muted">{page === 'overview' ? '查看备份保护和实际恢复结果。' : page === 'plans' ? '管理数据库连接、执行时间和归档目标。' : page === 'archives' ? '解冻和验证归档，并恢复到独立测试库。' : page === 'runs' ? '追踪备份和恢复的每次执行。' : '管理连接、通知和授权。'}</p></div>
          <div className="row">
            <button className="icon-button quiet" aria-label="刷新" onClick={() => { setError(''); historyPage.reload(); void refresh() }}><RefreshCw size={17}/></button>
            {canWrite && (page === 'overview' || page === 'plans') && <button className="primary" onClick={() => openEditor()}><Plus size={17}/> {editor ? '继续编辑计划' : '新建备份计划'}</button>}
          </div>
        </div>
        {notice && <p className="notice" role="status"><CircleCheck size={16}/> {notice}<button className="quiet icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={15}/></button></p>}
        {error && <p role="alert" className="error">{error}</p>}
        {page === 'overview' && <>
          <div className="metrics">
            <div className="panel metric"><Database size={18}/><span>启用的计划</span><strong>{loaded ? activePlans.length : '—'}</strong></div>
            <div className="panel metric"><Activity size={18}/><span>执行中与排队</span><strong>{loaded ? currentRuns.length : '—'}</strong></div>
            <div className="panel metric"><ShieldCheck size={18}/><span>完成过恢复演练</span><strong>{loaded ? plans.filter(plan => plan.lastVerifiedAt).length : '—'}</strong></div>
          </div>
          <section className="panel attention"><div className="section-title"><h2>需要处理</h2>{issues.length > 0 && <span className="pill pending">{issues.length}</span>}</div>
            {issues.length ? issues.map(run => <button className="attention-row" key={run.id} onClick={() => openRun(run.id)}>
              <span className="row"><CircleHelp size={17}/><strong>{plans.find(plan => plan.id === run.planId)?.name ?? run.planId}</strong><Badge state={run.state}/></span>
              <span className="row muted">{stamp(run.createdAt)} <ArrowRight size={16}/></span></button>
            ) : <p className="muted">{loaded ? '最近的备份运行中没有需要处理的失败。' : '正在读取运行记录…'}</p>}
          </section>
        </>}
        {(page === 'overview' || page === 'plans') && <section className="panel list-panel">
          <div className="section-title"><h2>{page === 'overview' ? '备份保护情况' : '计划列表'}</h2>{page === 'overview' && <button className="quiet" onClick={() => navigate('plans')}>管理计划 <ArrowRight size={15}/></button>}</div>
          {plans.length ? <div className="data-table"><table><thead><tr><th>计划 / 数据库</th><th>最近成功</th><th>最近恢复</th><th>下次备份</th><th>操作</th></tr></thead>
            <tbody>{plans.map(plan => <tr key={plan.id}><td><strong>{plan.name}</strong><small><Database size={13}/> {plan.connection.database}</small></td>
              <td>{stamp(plan.lastSuccessAt)}</td><td>{stamp(plan.lastVerifiedAt)}</td><td>{plan.enabled ? stamp(plan.nextAt) : '已暂停'}</td>
              <td><div className="row actions">{canWrite && <>
                <button onClick={() => void start(plan)} disabled={busyPlan !== null}>立即备份</button>
                <button className="quiet" disabled={editor !== null} onClick={() => openEditor(plan)}>编辑</button>
                <button className="quiet" onClick={() => void toggle(plan)}>{plan.enabled ? '暂停' : '启用'}</button>
              </>}</div></td></tr>)}</tbody></table></div> :
            <div className="empty"><HardDrive size={27}/><strong>{loaded ? '还没有备份计划' : '正在读取计划…'}</strong></div>}
        </section>}
        {(page === 'runs' || page === 'archives') && <div className={'run-layout ' + (selectedRun ? 'with-inspector' : '')}>
          <div className="panel list-panel">
            <div className="section-title"><h2>{page === 'archives' ? '归档列表' : '历史记录'}</h2>
              <label className="inline-filter"><span>备份计划</span><select value={filter} onChange={e => { historyPage.reset(); setSelected(null); setFilter(e.target.value) }}><option value="">全部</option>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label></div>
            {showRuns.length ? <div className="data-table"><table><thead><tr><th>计划 / 运行类型</th><th>状态</th><th>开始时间</th></tr></thead>
              <tbody>{showRuns.map(run => <tr key={run.id} data-selected={run.id === selected}>
                <td><button className="run-link quiet" onClick={() => setSelected(run.id)}><span>{plans.find(plan => plan.id === run.planId)?.name ?? run.planId}</span> <ArrowRight size={14}/></button><small>{run.kind === 'backup' ? (run.actor === '$schedule' ? '定时备份' : '手动备份') : '隔离恢复'}</small></td>
                <td><Badge state={run.state}/></td><td>{stamp(run.createdAt)}</td></tr>)}</tbody></table></div> : <div className="empty"><Archive size={27}/><strong>{historyPage.listing ? '暂无记录' : '正在读取记录…'}</strong></div>}
            {(historyPage.pageNumber > 1 || historyPage.listing?.hasOlder) && <div className="row history-pages" aria-label="历史记录分页">
              <button disabled={historyPage.pageNumber === 1} onClick={() => { setSelected(null); historyPage.newer() }}>上一页</button>
              <span className="muted">第 {historyPage.pageNumber} 页</span>
              <button disabled={!historyPage.listing?.hasOlder} onClick={() => { setSelected(null); historyPage.older() }}>下一页</button>
            </div>}
          </div>
          {selectedRun && <RunInspector key={selectedRun.id} api={api} run={selectedRun} plan={selectedPlan} canWrite={canWrite}
            recoveryTarget={session.actor.role === 'admin' ? session.recoveryTarget : null} canDelegate={canDelegate} onClose={() => setSelected(null)}
            onRun={id => { navigate('runs'); setSelected(id) }} refresh={() => { historyPage.reload(); void refresh() }}/>}
        </div>}
        {page === 'settings' && <SettingsPage api={api} actor={session.actor} recoveryTarget={session.recoveryTarget} onSaved={() => void refresh()}/>}
      </>}
    </main>
  </div>
}

function App () {
  const [session, setSession] = useState<Session | null>(null)
  const logout = useCallback(() => setSession(null), [])
  return session ? <Workbench session={session} onLogout={logout}/> : <Login onLogin={setSession}/>
}

createRoot(document.getElementById('root')!).render(<App/>)
