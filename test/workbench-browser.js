import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createApplication } from '../src/workbench/app.js'

const host = '127.0.0.1'
const root = await mkdtemp(join(tmpdir(), 'mysql-backup-browser-'))
const admin = { name: 'isolated-browser', password: 'browser-fixture-password' }
const worker = await createApplication({ root, env: {}, logger: false })
await worker.listen({ host, port: 0 })
const parent = createServer((request, reply) => {
  reply.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
    '<iframe title="Backup Workbench" sandbox="allow-scripts allow-same-origin" src="' +
    worker.listeningOrigin + '" style="width:100%;height:740px;border:0"></iframe>'
  )
})
await new Promise(resolve => parent.listen(0, host, resolve))
let browser
try {
  browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width: 460, height: 850 } })
  await page.goto('http://' + host + ':' + parent.address().port)
  const frame = page.frameLocator('iframe')
  await frame.getByLabel('初始化代码').fill((await readFile(join(root, 'setup-code'), 'utf8')).trim())
  await frame.getByLabel('用户名').fill(admin.name)
  await frame.getByLabel('密码').fill(admin.password)
  await frame.getByRole('button', { name: '创建管理员' }).click()
  await frame.getByRole('heading', { name: '总览' }).waitFor()
  await frame.getByRole('button', { name: '新建备份计划' }).first().click()
  await frame.getByLabel('计划名称').fill('Sandbox fixture')
  await frame.getByLabel('数据库', { exact: true }).fill('test_only')
  await frame.getByLabel('主机', { exact: true }).fill(host)
  await frame.getByLabel('用户名', { exact: true }).fill('fixture')
  await frame.getByLabel('Cron 表达式').fill('0 0 1 1 *')
  await frame.getByRole('button', { name: '返回总览' }).click()
  await frame.getByRole('button', { name: '继续编辑计划' }).click()
  assert.equal(await frame.getByLabel('计划名称').inputValue(), 'Sandbox fixture')
  await frame.getByLabel('计划名称').press('Enter')
  await frame.getByText('备份计划已保存').waitFor()
  assert(await frame.getByText('Sandbox fixture', { exact: true }).isVisible())

  const workbench = page.frames().find(frame => frame.url().startsWith(worker.listeningOrigin))
  assert(workbench && await workbench.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth))
  console.log('Sandboxed workbench initialized and saved a plan on a narrow viewport')
} finally {
  await browser?.close()
  await new Promise(resolve => parent.close(resolve))
  await worker.close()
  await rm(root, { recursive: true, force: true })
}
