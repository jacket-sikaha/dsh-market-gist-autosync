// Restore safety test: a backup may not write outside the profile through a
// symlinked/junction parent directory, and a directory in the way is refused.
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const root = join(here, '..', '.itest-restore-safety')
rmSync(root, { recursive: true, force: true })

const base = { format: 'dsh-profile-backup', version: 0.2 }
const manifest = { name: 'dsh-profile', dependencies: {}, dsh: { profile: { bundles: [] } } }
const profile = join(root, 'profile')
const outside = join(root, 'outside')
mkdirSync(profile, { recursive: true })
mkdirSync(outside, { recursive: true })

let pass = 0, fail = 0
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`) }
}

console.log('=== 1) a linked parent directory cannot smuggle the write outside ===')
// Windows junction: lstat calls it a plain directory, so only a resolved path can catch it.
// POSIX: a real directory symlink, with no privilege needed.
let linkedParent = null
for (const kind of ['dir', 'junction']) {
  try { symlinkSync(outside, join(profile, 'dsh'), kind); linkedParent = kind; break } catch { /* try next kind */ }
}
if (linkedParent) {
  const res = lib.restoreBackup(profile, { ...base, files: [{ path: 'dsh/plugins/x.json', lines: ['{}'] }] })
  check(`${linkedParent}: the restore is refused`, res.ok === false, JSON.stringify(res))
  check(`${linkedParent}: nothing landed outside the profile`, !existsSync(join(outside, 'plugins', 'x.json')))
} else {
  console.log('  SKIP  no symlink privilege on this machine')
}

console.log('=== 2) a plain nested path still restores, creating directories ===')
const profile2 = join(root, 'profile2')
const fresh = lib.restoreBackup(profile2, {
  ...base,
  files: [{ path: 'package.json', json: manifest }, { path: 'sub/deep/a.json', lines: ['{}'] }],
})
check('restore succeeds', fresh.ok === true, JSON.stringify(fresh))
check('restored both files', fresh.restored === 2)
check('intermediate directories were created', existsSync(join(profile2, 'sub', 'deep', 'a.json')))

console.log('=== 3) a directory sitting where a file belongs is refused ===')
mkdirSync(join(profile2, 'sub', 'deep', 'b.json'), { recursive: true })
const clash = lib.restoreBackup(profile2, { ...base, files: [{ path: 'sub/deep/b.json', lines: ['{}'] }] })
check('the restore is refused', clash.ok === false, JSON.stringify(clash))
check('it says the target is not a regular file', /不是普通文件/.test(clash.error ?? ''))

console.log('=== 4) a path escaping the profile by ".." is refused ===')
writeFileSync(join(root, 'note.txt'), 'x')
const escape = lib.restoreBackup(profile2, { ...base, files: [{ path: '../note.txt', lines: ['pwned'] }] })
check('the restore is refused', escape.ok === false, JSON.stringify(escape))
check('the file outside keeps its content', (await import('node:fs')).readFileSync(join(root, 'note.txt'), 'utf8') === 'x')

// rmSync cannot remove a tree containing a junction; remove the link first.
try { rmSync(join(profile, 'dsh'), { recursive: true, force: true }) } catch { /* ignore */ }
rmSync(root, { recursive: true, force: true })

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} restore-safety checks`)
process.exit(fail === 0 ? 0 : 1)
