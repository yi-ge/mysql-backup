type HostAppearance = { colorScheme?: 'light' | 'dark'; tokens?: Record<string, string> }
type HostEvent = { type: string; locale?: string; appearance?: HostAppearance }
type HostResult = { locale?: string; appearance?: HostAppearance; capabilities?: string[] }
export type Host = { call: (method: string, value?: object) => Promise<HostResult>; onEvent?: (listener: (event: HostEvent) => void) => (() => void) | undefined }

declare global { interface Window { desirecoreApp?: Host } }

const stable = (value: string, fallback: string) => value && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : fallback

export function connectHost (apply: (value: HostResult) => void) {
  const host = window.desirecoreApp
  if (!host) return
  let appearanceChanged = false
  let localeChanged = false
  const unsubscribe = host.onEvent?.(event => {
    if (event.type === 'appearance-changed') { appearanceChanged = true; apply({ appearance: event.appearance }) }
    if (event.type === 'locale-changed') { localeChanged = true; apply({ locale: event.locale }) }
  })
  void host.call('connect', {}).then(value => apply({
    capabilities: value.capabilities,
    ...(!appearanceChanged && { appearance: value.appearance }),
    ...(!localeChanged && { locale: value.locale })
  })).catch(() => {})
  return unsubscribe
}

export async function investigate (agentId: string, planId: string, runId: string, reason?: string) {
  const host = window.desirecoreApp
  if (!host) throw new Error('host_unavailable')
  const clientRequestId = crypto.randomUUID()
  await host.call('prepareWork', {
    agentId: stable(agentId, 'invalid'), clientRequestId, userMessageId: crypto.randomUUID(),
    operation: 'inspect-backup-run',
    prompt: '请使用 MySQL Backup MCP 工具检查计划 ' + planId + ' 的运行 ' + runId + '。说明当前状态、证据和可选处理方式。',
    scopeDescription: '只读调查该运行。',
    selection: { schemaVersion: 1, selectionRevision: crypto.randomUUID(), objects: [],
      summary: '计划 ' + planId + ' · 运行 ' + runId + (reason ? ' · ' + reason : '') }
  })
}
