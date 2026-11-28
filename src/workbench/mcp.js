import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { AppError } from './contract.js'

const tools = {
  list_backup_plans: ['plans.list', 'List backup plans and their last successful and verified times.', true],
  list_backup_runs: ['runs.list', 'List recent backup or recovery runs.', true],
  get_backup_run: ['runs.get', 'Read the durable state of an existing run by ID.', true],
  inspect_archive: ['archive.status', 'Read the availability of a single archive copy.', true],
  start_backup: ['runs.start', 'Queue one backup using a stable client requestId, then query its returned run ID.', false],
  thaw_archive: ['archive.thaw', 'Request a potentially billable retrieval from archival storage.', false],
  start_restore_drill: ['restore.start', 'Queue a restore into the deployment-defined empty recovery database.', false]
}

export function registerMcp (app, store, api) {
  app.route({
    method: ['POST', 'GET', 'DELETE'], url: '/mcp',
    async handler (request, reply) {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')
      const actor = match && store.getToken(match[1])
      if (!actor) return reply.code(401).header('www-authenticate', 'Bearer realm="mysql-backup"').send({ error: 'auth_required' })
      const server = new McpServer({ name: 'mysql-backup', version: '1.0.0' })
      for (const [name, [op, description, readonly]] of Object.entries(tools)) {
        if (!readonly && (actor.scope === 'read' || actor.role === 'viewer')) continue
        if (op === 'restore.start' && actor.role !== 'admin') continue
        server.registerTool(name, {
          description, inputSchema: api.schema(op),
          annotations: { readOnlyHint: readonly, destructiveHint: op === 'restore.start', idempotentHint: op !== 'archive.thaw', openWorldHint: true }
        }, async args => {
          try {
            const data = await api.invoke(op, actor, args)
            return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { result: data } }
          } catch (err) {
            const code = err instanceof AppError ? err.code : 'operation_failed'
            return { isError: true, content: [{ type: 'text', text: code }] }
          }
        })
      }
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
      reply.hijack()
      reply.raw.once('close', () => { void server.close().catch(() => {}) })
      try {
        await server.connect(transport)
        await transport.handleRequest(request.raw, reply.raw, request.body)
      } catch {
        if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"operation_failed"}')
        else reply.raw.destroy()
      }
    }
  })
}
