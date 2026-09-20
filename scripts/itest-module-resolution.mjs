// Module-resolution smoke test: import lib/index.js exactly like the Cordis
// loader would (ESM import of the bundle entry), and confirm every split
// module resolves and the plugin's exports are intact.
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = pathToFileURL(join(here, '..', 'lib', 'index.js')).href

const mod = await import(entry)
const required = ['name', 'inject', 'Config', 'apply']
const missing = required.filter((k) => mod[k] === undefined)

// test-surface re-exports
const testSurface = ['mergeManifests', 'restoreBackup', 'validateBackupStrict', 'collectProfileBackup', 'serializeBackup', 'installRestoredDeps']
const missingTest = testSurface.filter((k) => mod[k] === undefined)

console.log('name:', mod.name)
console.log('inject:', JSON.stringify(mod.inject))
console.log('plugin exports missing:', missing.length ? missing : '(none)')
console.log('test-surface missing:', missingTest.length ? missingTest : '(none)')

const ok = missing.length === 0 && missingTest.length === 0 && mod.name === 'dsh-market-gist-autosync'
console.log(ok ? '\nPASS — 拆分后模块链可解析，插件导出完整' : '\nFAIL')
process.exit(ok ? 0 : 1)
