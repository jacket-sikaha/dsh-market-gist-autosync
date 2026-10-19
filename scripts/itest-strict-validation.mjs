// Strict validation test: aligned with dshmarket's validatedBackup rules.
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const v = lib.validateBackupStrict

// Every case starts from a valid envelope so each assertion hits its own rule
// instead of stopping at the format gate.
const base = { format: 'dsh-profile-backup', version: 0.2 }
const big = 'x'.repeat(2 * 1024 * 1024 + 1)

const cases = [
  ['ok: minimal valid', { ...base, files: [{ path: 'package.json', json: {} }] }, null],

  ['reject: not object', null, '备份不是对象'],
  ['reject: no format', { files: [] }, 'format'],
  ['reject: wrong format', { ...base, format: 'other-tool', files: [{ path: 'package.json', json: {} }] }, '不是本插件的备份'],
  ['reject: no version', { format: 'dsh-profile-backup', files: [{ path: 'package.json', json: {} }] }, '版本不受支持'],
  ['reject: wrong version', { ...base, version: 0.3, files: [{ path: 'package.json', json: {} }] }, '版本不受支持'],

  ['reject: no files', { ...base }, 'files'],
  ['reject: .. path', { ...base, files: [{ path: '../evil.json', json: {} }] }, '不安全'],
  ['reject: absolute', { ...base, files: [{ path: 'C:/abs.json', json: {} }] }, '不安全'],
  ['reject: duplicate', { ...base, files: [{ path: 'package.json', json: {} }, { path: 'package.json', json: {} }] }, '重复'],
  ['reject: node_modules', { ...base, files: [{ path: 'package.json', json: {} }, { path: 'node_modules/x/y.js', lines: [] }] }, '不该出现的路径'],
  ['reject: pnpm-lock.yaml', { ...base, files: [{ path: 'package.json', json: {} }, { path: 'pnpm-lock.yaml', lines: [] }] }, '不该出现的路径'],

  ['reject: no content', { ...base, files: [{ path: 'package.json', json: {} }, { path: 'a.yml' }] }, '必须是行数组'],
  ['reject: bad pkg json', { ...base, files: [{ path: 'package.json', json: [1, 2] }] }, 'json 对象'],
  ['reject: pkg json as lines', { ...base, files: [{ path: 'package.json', lines: ['{}'] }] }, 'json 对象'],
  ['reject: other file as json', { ...base, files: [{ path: 'package.json', json: {} }, { path: 'a.yml', json: {} }] }, '行数组'],
  ['reject: bad lines', { ...base, files: [{ path: 'package.json', json: {} }, { path: 'a.yml', lines: [1, 2] }] }, '非字符串'],
  ['reject: no package.json', { ...base, files: [{ path: 'a.yml', lines: [] }] }, '没有 package.json'],
  ['reject: too large', { ...base, files: [{ path: 'package.json', json: { pad: big } }] }, '过大'],
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
