// Plugin-log switch test: the host plugin-manager's pnpm install logs travel
// only when the user asks for them, its run record never travels, and a restore
// writes whatever the backup actually holds.
//
// The asymmetry is the whole point. `includePluginLogs` is a COLLECTION-time
// decision, so it cannot be re-applied at restore time: the backup may come from
// a machine whose switch was the opposite, and a switch is not a property of
// someone else's file. The run record is the one exception in both directions —
// it names a pid on the machine that wrote the backup, so writing it here would
// make this profile's next plugin install refuse with "process N is still
// running".
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '.itest-plugin-logs')
rmSync(root, { recursive: true, force: true })

// A fixture profile: manifest, one ordinary config file, one install log, and a
// run record. Point the module at it through DSH_HOME/DSH_PROFILE, the same
// escape hatch initProfileContext() documents.
const home = join(root, 'home')
const profile = join(home, 'profiles', 'desktop')
const logDir = join(profile, '.plugin-manager', 'logs', 'operation-abc123')
mkdirSync(logDir, { recursive: true })
const manifest = { name: 'dsh-profile', dependencies: {}, dsh: { profile: { bundles: [] } } }
writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
writeFileSync(join(profile, 'cordis.patch.yml'), 'plugins: {}\n')
const logText = 'dsh: warning: Plugin dsh-find-plugin@0.4.0 is incompatible with dsh 0.2.1-rc.2\n'
writeFileSync(join(logDir, 'pnpm.log'), logText)
writeFileSync(join(profile, '.plugin-manager', 'run.json'), JSON.stringify({ pid: 4242, grouped: [] }))

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

console.log('=== 1) by default the backup carries configuration only ===')
const plain = lib.collectProfileBackup()
const plainPaths = paths(plain)
check('collects the manifest and the config file', plainPaths.includes('package.json') && plainPaths.includes('cordis.patch.yml'), plainPaths)
check('no .plugin-manager path at all', plainPaths.every((p) => !p.startsWith('.plugin-manager')), plainPaths)
check('pluginLogBytes is 0', plain.pluginLogBytes === 0, plain.pluginLogBytes)

console.log('=== 2) the switch adds the logs, never the run record ===')
const withLogs = lib.collectProfileBackup({ includePluginLogs: true })
const logPaths = paths(withLogs)
check('the install log is collected', logPaths.includes('.plugin-manager/logs/operation-abc123/pnpm.log'), logPaths)
check('run.json is still excluded', !logPaths.includes('.plugin-manager/run.json'), logPaths)
check('only the log directory came in', logPaths.filter((p) => p.startsWith('.plugin-manager')).length === 1, logPaths)
check('pluginLogBytes counts the serialized log', withLogs.pluginLogBytes === Buffer.byteLength(logText), { got: withLogs.pluginLogBytes, want: Buffer.byteLength(logText) })

console.log('=== 3) a too-large backup can name the logs as the reason ===')
const largest = lib.largestBackupEntries(withLogs.files)
check('the biggest entry is reported', largest.length > 0 && typeof largest[0].path === 'string' && largest[0].bytes > 0, largest)
check('largest entries are sorted descending', largest.every((e, i) => i === 0 || largest[i - 1].bytes >= e.bytes), largest)

console.log('=== 4) validation still accepts logs (dshmarket writes them) ===')
const withLogBackup = {
  format: 'dsh-profile-backup',
  version: 0.2,
  files: [
    { path: 'package.json', json: manifest },
    { path: '.plugin-manager/logs/operation-abc123/pnpm.log', lines: logText.split('\n') },
  ],
}
check('a log-carrying backup passes strict validation', lib.validateBackupStrict(withLogBackup) === null, lib.validateBackupStrict(withLogBackup))

console.log('=== 5) restore follows the backup, and drops the run record ===')
const target = join(root, 'restored')
const restored = lib.restoreBackup(target, {
  ...withLogBackup,
  files: [
    { path: 'package.json', json: manifest },
    { path: '.plugin-manager/logs/operation-abc123/pnpm.log', lines: logText.split('\n') },
    { path: '.plugin-manager/run.json', lines: ['{"pid":4242}'] },
  ],
})
check('the restore succeeds', restored.ok === true, restored)
check('the log was written back', existsSync(join(target, '.plugin-manager', 'logs', 'operation-abc123', 'pnpm.log')))
check('the log content is intact', readFileSync(join(target, '.plugin-manager', 'logs', 'operation-abc123', 'pnpm.log'), 'utf8') === logText)
check('run.json was NOT written back', !existsSync(join(target, '.plugin-manager', 'run.json')))
check('the skip is reported', JSON.stringify(restored.skipped) === JSON.stringify(['.plugin-manager/run.json']), restored.skipped)
check('restored counts only what was written', restored.restored === 2, restored.restored)

console.log('=== 6) a log-free backup writes no plugin-manager directory ===')
const cleanFiles = withLogBackup.files.filter((f) => !f.path.startsWith('.plugin-manager'))
const clean = lib.restoreBackup(join(root, 'restored-clean'), { ...withLogBackup, files: cleanFiles })
check('the restore succeeds', clean.ok === true, clean)
check('no .plugin-manager was created', !existsSync(join(root, 'restored-clean', '.plugin-manager')))

rmSync(root, { recursive: true, force: true })

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} plugin-log checks`)
process.exit(fail === 0 ? 0 : 1)
