// Strict validation test: aligned with dshmarket's validatedBackup rules.
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const v = lib.validateBackupStrict

const cases = [
  ['ok: minimal valid', { format: 'dsh-profile-backup', files: [{ path: 'package.json', json: {} }] }, null],
  ['reject: not object', null, '备份不是对象'],
  ['reject: no format', { files: [] }, 'format'],
  ['reject: no files', { format: 'x' }, 'files'],
  ['reject: .. path', { format: 'x', files: [{ path: '../evil.json', json: {} }] }, '不安全'],
  ['reject: absolute', { format: 'x', files: [{ path: 'C:/abs.json', json: {} }] }, '不安全'],
  ['reject: duplicate', { format: 'x', files: [{ path: 'a.yml', lines: [] }, { path: 'a.yml', lines: [] }] }, '重复'],
  ['reject: node_modules', { format: 'x', files: [{ path: 'node_modules/x/y.js', lines: [] }] }, '排除'],
  ['reject: no content', { format: 'x', files: [{ path: 'a.yml' }] }, 'json 也无 lines'],
  ['reject: bad pkg json', { format: 'x', files: [{ path: 'package.json', json: [1, 2] }] }, '不是对象'],
  ['reject: bad lines', { format: 'x', files: [{ path: 'a.yml', lines: [1, 2] }] }, '非字符串'],
]

let pass = 0, fail = 0
for (const [label, input, expect] of cases) {
  const got = v(input)
  const ok = expect === null ? got === null : (got !== null && got.includes(expect.replace(/.*: /, '')))
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.log(`✗ ${label} — expected ${expect === null ? 'valid' : expect}, got ${JSON.stringify(got)}`) }
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${cases.length} strict-validation cases`)
process.exit(fail === 0 ? 0 : 1)
