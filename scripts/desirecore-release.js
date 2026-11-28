import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const registryLabel = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
const repositoryLabel = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*'
const pinnedImage = new RegExp('^(?:localhost|' + registryLabel + '(?:\\.' + registryLabel + ')+)(?::([1-9][0-9]{0,4}))?/(' + repositoryLabel + '/)*' + repositoryLabel + '@sha256:[a-f0-9]{64}$')
const { values } = parseArgs({ options: { image: { type: 'string' }, commit: { type: 'string' }, output: { type: 'string' } } })
const image = pinnedImage.exec(values.image ?? '')
if (!image || values.image.length > 2048 || (image[1] && Number(image[1]) > 65535) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(values.commit ?? '') || !values.output) {
  throw new Error('Required: --image registry/repository@sha256:<digest> --commit <git-sha> --output <new-directory>')
}

const files = [
  { path: 'LICENSE', role: 'license', bytes: readFileSync(new URL('../LICENSE', import.meta.url)) },
  { path: 'run.md', role: 'documentation', bytes: readFileSync(new URL('../desirecore/run.md', import.meta.url)) }
]
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const manifest = {
  schemaVersion: 1,
  canonicalization: 'app-release-c14n-v1',
  definition: {
    id: 'mysql-backup',
    name: 'MySQL Backup',
    version,
    productKind: 'application',
    entrypoints: [{ id: 'main', name: 'Backup Workbench', kind: 'embedded-web', serviceRef: 'mysql-backup' }],
    placementPolicy: { showInMyApps: true, allowAgentBinding: true, allowNavPin: true }
  },
  delivery: { type: 'docker-app', runtimeInstructionsPath: 'run.md', imageRefs: [values.image] },
  files: files.map(({ path, role, bytes }) => ({
    path,
    role,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  })),
  source: { kind: 'git', commit: values.commit },
  supportedPlatforms: ['darwin', 'win32', 'linux', 'web'],
  requiredCapabilities: ['app-authoring-v1'],
  bridgeCapabilities: ['requestWork'],
  instructionsPath: 'run.md'
}

const output = resolve(values.output)
mkdirSync(output, { mode: 0o755 })
for (const { path, bytes } of files) writeFileSync(join(output, path), bytes, { flag: 'wx' })
writeFileSync(join(output, 'app-release.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
