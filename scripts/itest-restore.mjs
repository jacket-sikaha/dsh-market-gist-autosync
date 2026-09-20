// Integration test: verify the merge-restore semantics directly against
// restoreBackup() in an isolated temp DSH_HOME — restoring must NOT delete
// plugins already installed on the target machine.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href
const { restoreBackup, mergeManifests } = await import(libUrl)

// --- 1) mergeManifests: backup deps overlay, current deps kept, bundles unioned
const backupManifest = {
  name: 'dsh-profile-desktop',
  dependencies: { dshmarket: '1.47.0', 'dsh-context': '0.53.3' },
  dsh: { profile: { bundles: ['dshmarket', 'dsh-context'] } },
}
const currentManifest = {
  name: 'dsh-profile-desktop',
  dependencies: { dshmarket: '1.40.0', 'existing-plugin': '9.9.9' }, // existing-plugin NOT in backup
  dsh: { profile: { bundles: ['dshmarket', 'existing-plugin'], patchReload: 'live' } },
}
const merged = mergeManifests(backupManifest, currentManifest)
const mDeps = merged.dependencies
const mBundles = merged.dsh.profile.bundles
console.log('merged deps:', JSON.stringify(mDeps))
console.log('merged bundles:', JSON.stringify(mBundles))

const mergeOk =
  mDeps['existing-plugin'] === '9.9.9' &&        // existing kept (not deleted)
  mDeps['dshmarket'] === '1.47.0' &&             // backup version wins on conflict
  mDeps['dsh-context'] === '0.53.3' &&           // backup-only dep added
  mBundles.includes('existing-plugin') &&        // existing bundle kept
  mBundles.includes('dsh-context') &&            // backup bundle added
  mBundles.length === 3                          // union, deduped
console.log(mergeOk ? 'mergeManifests: PASS (existing plugin preserved)' : 'mergeManifests: FAIL')

// --- 2) restoreBackup end-to-end in a temp DSH_HOME -------------------------
const tmp = mkdtempSync(join(tmpdir(), 'gist-restore-itest-'))
mkdirSync(join(tmp, 'profiles', 'desktop'), { recursive: true })
// current package.json already has existing-plugin
writeFileSync(join(tmp, 'profiles', 'desktop', 'package.json'), JSON.stringify(currentManifest, null, 2), 'utf8')
writeFileSync(join(tmp, 'settings.yaml'), 'old: true\n', 'utf8')

const backup = {
  format: 'dsh-config-gist-backup',
  version: 1,
  files: [
    { path: 'profiles/desktop/package.json', json: backupManifest },
    { path: 'settings.yaml', lines: ['ui-theme:', '  preference: light', ''] },
    { path: 'newdir/nested.json', json: { a: 1 } }, // creates missing dirs
  ],
}
const result = restoreBackup(tmp, backup)
console.log('restoreBackup ->', JSON.stringify(result))

const afterPkg = JSON.parse(readFileSync(join(tmp, 'profiles', 'desktop', 'package.json'), 'utf8'))
const afterSettings = readFileSync(join(tmp, 'settings.yaml'), 'utf8')
const afterNested = readFileSync(join(tmp, 'newdir', 'nested.json'), 'utf8')

const restoreOk =
  result.ok === true &&
  result.mergedManifest === true &&
  afterPkg.dependencies['existing-plugin'] === '9.9.9' &&  // existing preserved on disk
  afterPkg.dependencies['dsh-context'] === '0.53.3' &&     // backup dep added
  afterSettings.includes('preference: light') &&           // text file overwritten
  JSON.parse(afterNested).a === 1                          // nested dir created + written

console.log('restored package.json deps:', JSON.stringify(afterPkg.dependencies))
console.log(restoreOk ? 'restoreBackup: PASS' : 'restoreBackup: FAIL')

const pass = mergeOk && restoreOk
console.log(pass ? '\nPASS — 合并恢复语义正确：现有插件被保留' : '\nFAIL')
process.exit(pass ? 0 : 1)
