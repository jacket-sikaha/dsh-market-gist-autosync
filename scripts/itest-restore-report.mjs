// Integration test: the restore message must not contradict itself.
//
// install.ts prunes a link:/file: dep whose path is gone on this machine, and
// reports it as "已剔除". operations.ts separately reported every machine-local
// dep found in the INCOMING gist as "需手动重装" - so a dep that had just been
// pruned was announced twice, once as removed and once as needing a manual
// reinstall. The user got two instructions for one dependency and no way to
// tell which was true.
//
// The fix is to compute the report from the manifest AFTER the install ran.
// This test pins the mechanism: after pruning, the dep is gone from the file,
// so the post-install read cannot see it.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const { installRestoredDeps, unportableDeps } = lib

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass += 1; console.log('  PASS  ' + label) }
  else { fail += 1; console.log('  FAIL  ' + label + '\n        got:  ' + a + '\n        want: ' + e) }
}

/** The manifest as operations.ts now reads it, after the install step. */
function postInstallWarnings(root) {
  return unportableDeps(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies)
}

console.log('=== 1) a dead local dep is pruned, then reported only once ===')
const root = mkdtempSync(join(tmpdir(), 'gist-dup-'))
const deadPath = join(root, 'definitely-not-here', 'settings-scroll-fix')
writeFileSync(join(root, 'package.json'), JSON.stringify({
  name: 'dsh-profile-desktop',
  dependencies: {
    'settings-scroll-fix': `link:${deadPath.split('\\').join('/')}`,
  },
  dsh: { profile: { bundles: ['settings-scroll-fix'] } },
}, null, 2), 'utf8')

// What the OLD code reported: read straight from the incoming backup.
const incoming = { 'settings-scroll-fix': `link:${deadPath.split('\\').join('/')}` }
const oldWarnings = unportableDeps(incoming)
check('the incoming gist does contain the dep (so old code saw it)', oldWarnings.length, 1)

const outcome = await installRestoredDeps(root)
check('install reports it as pruned', outcome.prunedNames, ['settings-scroll-fix'])
check('and says so in its summary', outcome.summary.includes('已剔除'), true)

// This is the fix: nothing left for the second message to claim.
const newWarnings = postInstallWarnings(root)
check('the post-install report is EMPTY (no duplicate)', newWarnings, [])
check('the dep is gone from the manifest',
  Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies), [])
check('its bundle row went too',
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dsh.profile.bundles, [])
rmSync(root, { recursive: true, force: true })

console.log('=== 2) a local dep whose path EXISTS is kept and reported ===')
// The other half of the honesty fix: a surviving machine-local dep is still
// worth mentioning (it will not travel), but the message must not tell the user
// to reinstall something that is working right now.
const root2 = mkdtempSync(join(tmpdir(), 'gist-dup2-'))
const liveDir = join(root2, 'vendor', 'live-local')
mkdirSync(liveDir, { recursive: true })
writeFileSync(join(liveDir, 'package.json'), '{"name":"live-local","version":"1.0.0"}', 'utf8')
writeFileSync(join(root2, 'package.json'), JSON.stringify({
  name: 'dsh-profile-desktop',
  dependencies: { 'live-local': `link:${liveDir.split('\\').join('/')}` },
  dsh: { profile: { bundles: ['live-local'] } },
}, null, 2), 'utf8')

const outcome2 = await installRestoredDeps(root2)
check('a live local dep is NOT pruned', outcome2.prunedNames, [])
const keptWarnings = postInstallWarnings(root2)
check('but it IS still reported as machine-local', keptWarnings.map((w) => w.name), ['live-local'])
check('and it stays in the manifest',
  Object.keys(JSON.parse(readFileSync(join(root2, 'package.json'), 'utf8')).dependencies), ['live-local'])
rmSync(root2, { recursive: true, force: true })

console.log('')
console.log(fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
