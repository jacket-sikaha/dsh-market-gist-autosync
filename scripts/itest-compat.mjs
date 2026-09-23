// Compatibility test: my backup output must pass dshmarket's own
// validatedBackup() and be restorable by restoreProfileBackup().
// This is the core of "完全兼容 dshmarket 的恢复功能".
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

// dshmarket's own validators, imported from wherever it is actually installed.
// The path used to be hardcoded to one developer's machine, which made this test
// fail with ERR_MODULE_NOT_FOUND everywhere else — a broken test, not a real
// incompatibility. Probe the usual anchors instead and skip loudly if absent.
function findDshmarket() {
  const candidates = []
  if (process.env.DSH_MARKET_PATH) candidates.push(process.env.DSH_MARKET_PATH)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  for (const profile of ['desktop', 'web']) {
    candidates.push(join(home, 'profiles', profile, 'node_modules', 'dshmarket'))
  }
  // The DSH installation itself ships dshmarket in some Desktop builds.
  const resourcesPath = process.resourcesPath
  if (typeof resourcesPath === 'string' && resourcesPath !== '') {
    for (const appRoot of ['app.asar.unpacked', 'app.asar', 'app']) {
      candidates.push(join(resourcesPath, appRoot, 'node_modules', 'dshmarket'))
    }
  }
  for (const dir of candidates) {
    const entry = join(dir, 'lib', 'backup.js')
    if (existsSync(entry)) return entry
  }
  return null
}
const dshmarketEntry = findDshmarket()
if (dshmarketEntry === null) {
  console.log('SKIP — dshmarket is not installed on this machine; cannot verify')
  console.log('       cross-plugin compatibility. Install it (or set DSH_MARKET_PATH)')
  console.log('       to run this test.')
  process.exit(0)
}
console.log('using dshmarket at:', dshmarketEntry)
const dshmarketBackup = await import(pathToFileURL(dshmarketEntry).href)

// --- build a temp profile that looks like a real desktop profile ----------
const home = mkdtempSync(join(tmpdir(), 'gist-compat-home-'))
process.env.DSH_HOME = home
process.env.DSH_PROFILE = 'desktop'
const profDir = join(home, 'profiles', 'desktop')
mkdirSync(profDir, { recursive: true })
writeFileSync(join(profDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-desktop', private: true,
  dependencies: { dshmarket: '1.47.0', 'dsh-context': '0.53.3' },
  dsh: { profile: { bundles: ['dshmarket', 'dsh-context'], patchReload: 'live' } },
}, null, 2), 'utf8')
writeFileSync(join(profDir, 'cordis.patch.yml'), '# patch\n- id: web\n  config:\n    x: 1\n', 'utf8')
writeFileSync(join(profDir, 'cordis.yml'), '[]\n', 'utf8')
writeFileSync(join(profDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')
// a .bak leftover that must be excluded
writeFileSync(join(profDir, 'package.json.bak-asm'), '{}', 'utf8')

// --- produce my backup envelope (what doBackup uploads) -------------------
const { files } = lib.collectProfileBackup(false)
const backup = {
  format: 'dsh-profile-backup',
  version: 0.2,
  createdAt: new Date().toISOString(),
  profile: 'desktop',
  files,
}
const content = lib.serializeBackup(backup)
console.log('backup bytes:', Buffer.byteLength(content))
console.log('paths:', files.map((f) => f.path))

// --- 1) dshmarket's validatedBackup must ACCEPT it -------------------------
let validated = null
let validErr = null
try {
  validated = dshmarketBackup.validatedBackup(JSON.parse(content))
} catch (e) {
  validErr = e.message
}
const compatOk = validated !== null
console.log(compatOk ? 'dshmarket.validatedBackup: ACCEPT ✓' : `dshmarket.validatedBackup: REJECT ✗ — ${validErr}`)

// --- 2) restoreProfileBackup must restore it into a fresh profile ---------
let restoreOk = false
let restoreErr = null
if (compatOk) {
  const target = mkdtempSync(join(tmpdir(), 'gist-compat-restore-'))
  mkdirSync(target, { recursive: true })
  try {
    const res = dshmarketBackup.restoreProfileBackup('desktop', JSON.parse(content), target)
    const restoredPkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    restoreOk = res.files === files.length && restoredPkg.dependencies['dsh-context'] === '0.53.3'
    console.log('dshmarket.restoreProfileBackup files:', res.files)
  } catch (e) {
    restoreErr = e.message
  }
}
console.log(restoreOk ? 'dshmarket.restoreProfileBackup: OK ✓' : `dshmarket.restoreProfileBackup: FAIL ✗ — ${restoreErr}`)

// --- 3) .bak leftover must be excluded ------------------------------------
const bakExcluded = !files.some((f) => f.path.includes('.bak'))
console.log(bakExcluded ? '.bak excluded ✓' : '.bak NOT excluded ✗')

const pass = compatOk && restoreOk && bakExcluded
console.log(pass ? '\nPASS — 备份完全兼容 dshmarket 恢复' : '\nFAIL')
process.exit(pass ? 0 : 1)
