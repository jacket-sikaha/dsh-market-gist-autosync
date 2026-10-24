// Hidden-directory test: the backup carries profile *configuration*, so every
// hidden directory is skipped wholesale — `.plugin-manager` (the host's pnpm
// install logs, 790 KB on one real profile), market caches, `.git` — while
// hidden FILES still travel, because `.env` and `.npmrc` are real config.
//
// The rule matches dshmarket 1.70.1+ (#972). Restore is deliberately more
// permissive than collection: backups written by older versions of this plugin
// or by dshmarket can still carry `.plugin-manager/logs`, and refusing them
// would break backups that restore perfectly well. The one entry never written
// back is `run.json`, because it names a pid on the machine that WROTE the
// backup.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '.itest-hidden-dirs')
rmSync(root, { recursive: true, force: true })

// A fixture profile carrying one of everything the walk has to decide about.
const home = join(root, 'home')
const profile = join(home, 'profiles', 'desktop')
const logDir = join(profile, '.plugin-manager', 'logs', 'operation-abc123')
mkdirSync(logDir, { recursive: true })
mkdirSync(join(profile, '.cache'), { recursive: true })
mkdirSync(join(profile, '.dsh-market'), { recursive: true })
mkdirSync(join(profile, 'node_modules', 'dep'), { recursive: true })
mkdirSync(join(profile, 'sub'), { recursive: true })
const manifest = {
  name: 'dsh-profile',
  dependencies: { dshmarket: '^1.70.1', 'dsh-find-plugin': '0.4.0' },
  // `@deepseek-ai/dsh-base` is a bundle the host itself provides: no dependency row.
  dsh: { profile: { bundles: ['dshmarket', 'dsh-find-plugin', '@deepseek-ai/dsh-base'] } },
}
writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
writeFileSync(join(profile, 'cordis.patch.yml'), 'plugins: {}\n')
writeFileSync(join(profile, 'sub', 'nested.yml'), 'a: 1\n')
// Hidden FILE — real config, must survive.
writeFileSync(join(profile, '.env'), 'TOKEN=keep-me\n')
// Hidden DIR not in PROFILE_SKIP — skipped by the hidden rule alone.
writeFileSync(join(profile, '.cache', 'junk.json'), '{"junk":true}\n')
writeFileSync(join(profile, '.dsh-market', 'index.json'), '{"cache":true}\n')
// Host scratch: install log + the pid record.
const logText = 'dsh: warning: Plugin dsh-find-plugin@0.4.0 is incompatible with dsh 0.2.1-rc.2\n'
writeFileSync(join(logDir, 'pnpm.log'), logText)
writeFileSync(join(profile, '.plugin-manager', 'run.json'), JSON.stringify({ pid: 4242, grouped: [] }))
// Skipped by name / suffix.
writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
writeFileSync(join(profile, 'package.json.bak'), '{}\n')
writeFileSync(join(profile, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')

process.env.DSH_HOME = home
process.env.DSH_PROFILE = 'desktop'
const lib = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log('  PASS  ' + label) }
  else { fail += 1; console.log('  FAIL  ' + label + (detail === undefined ? '' : ' — ' + JSON.stringify(detail))) }
}
const paths = (collected) => collected.files.map((f) => f.path)

console.log('=== 1) hidden directories never enter the backup ===')
const collected = lib.collectProfileBackup()
const list = paths(collected)
check('manifest and ordinary config files are collected', ['package.json', 'cordis.patch.yml', 'sub/nested.yml'].every((p) => list.includes(p)), list)
check('no .plugin-manager path', list.every((p) => !p.startsWith('.plugin-manager')), list)
check('no .cache path (not in PROFILE_SKIP, hidden rule alone)', list.every((p) => !p.startsWith('.cache')), list)
check('no .dsh-market path', list.every((p) => !p.startsWith('.dsh-market')), list)
check('no node_modules / pnpm-lock.yaml / *.bak', !list.some((p) => /(^|\/)node_modules\//.test(p) || p === 'pnpm-lock.yaml' || /\.bak\b/.test(p)), list)
check('hidden FILE .env still travels', list.includes('.env'), list)
check('nothing hidden-directory-shaped is present at all', !list.some((p) => p.split('/').slice(0, -1).some((seg) => seg.startsWith('.'))), list)
check('collectProfileBackup takes no options', lib.collectProfileBackup.length === 0, lib.collectProfileBackup.length)

console.log('=== 2) the preview shows exactly what would be uploaded ===')
const preview = lib.previewProfileBackup()
check('one entry per collected file', preview.entries.length === collected.files.length, { entries: preview.entries.length, files: collected.files.length })
check('same paths in the same order', JSON.stringify(preview.entries.map((e) => e.path)) === JSON.stringify(list), preview.entries.map((e) => e.path))
check('every entry has a positive byte count', preview.entries.every((e) => e.bytes > 0), preview.entries)
check('tiers are primary or secondary only', preview.entries.every((e) => e.tier === 'primary' || e.tier === 'secondary'), preview.entries)
check('package.json is primary, .env is secondary', preview.entries.find((e) => e.path === 'package.json')?.tier === 'primary' && preview.entries.find((e) => e.path === '.env')?.tier === 'secondary', preview.entries)
check('totalBytes is at least the sum of the entries', preview.totalBytes >= preview.entries.reduce((s, e) => s + e.bytes, 0), preview.totalBytes)
check('no per-file log marker survives in the wire shape', preview.entries.every((e) => !('pluginLog' in e)), Object.keys(preview.entries[0] ?? {}))
const largest = lib.largestBackupEntries(collected.files)
check('largest entries are sorted descending', largest.every((e, i) => i === 0 || largest[i - 1].bytes >= e.bytes), largest)

console.log('=== 2b) the dialog can list the plugins the backup carries ===')
const plugins = Array.isArray(preview.plugins) ? preview.plugins : []
const names = plugins.map((p) => p.name)
check('plugins is an array', Array.isArray(preview.plugins), preview.plugins)
check('one row per declared bundle', names.length === 3, names)
check('rows are sorted by name', JSON.stringify(names) === JSON.stringify(['@deepseek-ai/dsh-base', 'dsh-find-plugin', 'dshmarket']), names)
check('declared specs are carried verbatim', plugins.find((p) => p.name === 'dshmarket')?.version === '^1.70.1' && plugins.find((p) => p.name === 'dsh-find-plugin')?.version === '0.4.0', plugins)
check('a host-provided bundle has an empty version', plugins.find((p) => p.name === '@deepseek-ai/dsh-base')?.version === '', plugins.find((p) => p.name === '@deepseek-ai/dsh-base'))
check('dependencies that are not bundles are left out', !names.includes('zod'), names)

// Legacy config keys (`includePluginLogs` / `includeLock`) are dropped on read.
// That is asserted in itest-host-compat.mjs instead of here: `readBackupConfig`
// is internal, and lib/ is a single vite bundle, so it cannot be imported alone.

console.log('=== 3) restore still accepts log-carrying backups (interop) ===')
const withLogs = {
  format: 'dsh-profile-backup',
  version: 0.2,
  files: [
    { path: 'package.json', json: manifest },
    { path: '.plugin-manager/logs/operation-abc123/pnpm.log', lines: logText.split('\n') },
    { path: '.plugin-manager/run.json', lines: ['{"pid":4242}'] },
  ],
}
check('strict validation passes', lib.validateBackupStrict(withLogs) === null, lib.validateBackupStrict(withLogs))
const target = join(root, 'restored')
const restored = lib.restoreBackup(target, withLogs)
check('the restore succeeds', restored.ok === true, restored)
check('the log is written back', readFileSync(join(target, '.plugin-manager', 'logs', 'operation-abc123', 'pnpm.log'), 'utf8') === logText)
check('run.json is NOT written back', !existsSync(join(target, '.plugin-manager', 'run.json')))
check('the skip is reported', JSON.stringify(restored.skipped) === JSON.stringify(['.plugin-manager/run.json']), restored.skipped)
check('restored counts only what was written', restored.restored === 2, restored.restored)

console.log('=== 4) a backup collected here restores without a plugin-manager dir ===')
// Same envelope an upload builds (buildBackupEnvelope is internal; only the
// wrapper is reproduced here, the file entries come from the real walk).
const cleanEnvelope = {
  format: 'dsh-profile-backup',
  version: 0.2,
  files: JSON.parse(lib.serializeBackup(collected.files)),
}
const clean = lib.restoreBackup(join(root, 'restored-clean'), cleanEnvelope)
check('the restore succeeds', clean.ok === true, clean)
check('no .plugin-manager was created', !existsSync(join(root, 'restored-clean', '.plugin-manager')))
check('.env was restored', readFileSync(join(root, 'restored-clean', '.env'), 'utf8') === 'TOKEN=keep-me\n')
check('nothing was skipped', (clean.skipped ?? []).length === 0, clean.skipped)

rmSync(root, { recursive: true, force: true })

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} hidden-directory checks`)
process.exit(fail === 0 ? 0 : 1)
