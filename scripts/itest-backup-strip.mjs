// Integration test: the backup half of cross-machine sync.
//
// A link:/file: dependency naming an absolute path is a statement about ONE
// machine's disk layout. A shared gist is read by every machine, so a backup
// that carries one makes the peer's restore inherit a dependency nothing there
// can satisfy - and the peer's only options are to fail the install or to prune
// the dep and drop the bundle row, rewriting a local limitation into shared
// state that the next backup carries back.
//
// The fix is to keep the gist a description of the portable composition: strip
// those deps before upload, together with the bundle rows that name them (a row
// whose package can never be installed fails the boot). This test pins the
// stripping, the reporting, and - most importantly - that the origin machine
// loses nothing, because restore merges as a union.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const { stripMachineLocalDeps, unportableDeps, collectProfileBackup, mergeManifests } = lib

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass += 1; console.log('  PASS  ' + label) }
  else { fail += 1; console.log('  FAIL  ' + label + '\n        got:  ' + a + '\n        want: ' + e) }
}

console.log('=== 1) which specs count as machine-local ===')
check('windows link: is stripped',
  unportableDeps({ a: 'link:C:/Users/Someone/dev/x' }).map((d) => d.name), ['a'])
check('posix file: is stripped',
  unportableDeps({ b: 'file:/home/me/dev/y' }).map((d) => d.name), ['b'])
check('UNC is stripped',
  unportableDeps({ c: 'file:\\\\server\\share\\z' }).map((d) => d.name), ['c'])
check('backslash drive-letter is stripped',
  unportableDeps({ d: 'link:D:\\study\\plugin' }).map((d) => d.name), ['d'])
check('a relative file: spec is portable and kept',
  unportableDeps({ e: 'file:./vendor/z' }), [])
check('a registry version is untouched',
  unportableDeps({ f: '^1.2.3' }), [])
check('a non-object is not a crash',
  unportableDeps(null), [])

console.log('=== 2) stripping a manifest ===')
const dirty = {
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: {
    dshmarket: '1.51.0',
    'settings-scroll-fix': 'link:C:/Users/Administrator/Desktop/cron/x/settings-scroll-fix',
    'other-local': 'file:/home/me/dev/other',
    'vendor-relative': 'file:./vendor/keep',
  },
  dsh: {
    profile: {
      bundles: ['dshmarket', 'settings-scroll-fix', 'other-local', 'vendor-relative'],
      patchReload: 'live',
    },
  },
}
const stripped = stripMachineLocalDeps(dirty)
check('both absolute deps are reported',
  stripped.strippedDeps.map((d) => d.name), ['settings-scroll-fix', 'other-local'])
check('their bundle rows go too',
  stripped.strippedBundles, ['settings-scroll-fix', 'other-local'])
check('portable deps survive',
  Object.keys(stripped.json.dependencies), ['dshmarket', 'vendor-relative'])
check('portable bundle rows survive',
  stripped.json.dsh.profile.bundles, ['dshmarket', 'vendor-relative'])
check('unrelated manifest fields survive', stripped.json.private, true)
check('sibling dsh.profile fields survive', stripped.json.dsh.profile.patchReload, 'live')
check('the original object is not mutated',
  Object.keys(dirty.dependencies).length, 4)

console.log('=== 3) a clean manifest is untouched ===')
const clean = { name: 'p', dependencies: { a: '^1.0.0' }, dsh: { profile: { bundles: ['a'] } } }
const cleanOut = stripMachineLocalDeps(clean)
check('nothing reported', cleanOut.strippedDeps, [])
check('nothing dropped', cleanOut.strippedBundles, [])
check('manifest is equivalent', cleanOut.json, clean)

console.log('=== 4) the origin machine keeps its own row (union merge) ===')
// This is the safety property that makes stripping acceptable: a peer restoring
// the stripped gist must not be able to take away a dependency or bundle the
// local profile still declares. mergeManifests overlays deps (backup wins on
// conflicts) and unions bundles, so a row absent from the backup stays put.
const localManifest = {
  name: 'dsh-profile-desktop',
  dependencies: { 'settings-scroll-fix': 'link:C:/Users/Administrator/Desktop/x', dshmarket: '1.51.0' },
  dsh: { profile: { bundles: ['dshmarket', 'settings-scroll-fix'] } },
}
const peerBackup = stripMachineLocalDeps(localManifest).json // what the peer uploaded
const merged = mergeManifests(localManifest, peerBackup)
check('origin keeps its link dep', merged.dependencies['settings-scroll-fix'], 'link:C:/Users/Administrator/Desktop/x')
check('origin keeps its bundle row', merged.dsh.profile.bundles.includes('settings-scroll-fix'), true)
check('origin keeps the shared dep', merged.dependencies.dshmarket, '1.51.0')

console.log('=== 5) the gist actually uploaded carries no machine path ===')
const home = mkdtempSync(join(tmpdir(), 'gist-strip-home-'))
const profDir = join(home, 'profiles', 'desktop')
mkdirSync(profDir, { recursive: true })
process.env.DSH_HOME = home
process.env.DSH_PROFILE = 'desktop'
writeFileSync(join(profDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-desktop',
  dependencies: { dshmarket: '1.51.0', 'local-thing': 'link:C:/Users/Someone/elsewhere/local-thing' },
  dsh: { profile: { bundles: ['dshmarket', 'local-thing'] } },
}, null, 2), 'utf8')
const { initProfileContext } = lib
initProfileContext()
const collected = collectProfileBackup(false)
const manifestEntry = collected.files.find((f) => f.path === 'package.json')
check('the collected manifest has no absolute path left',
  JSON.stringify(manifestEntry.json).includes('C:/Users/Someone'), false)
check('the local dep is reported to the user',
  collected.strippedDeps.map((d) => d.name), ['local-thing'])
check('and so is its bundle row', collected.strippedBundles, ['local-thing'])
check('the shared dep is still there',
  Object.keys(manifestEntry.json.dependencies), ['dshmarket'])
// The file on disk must NOT have been rewritten: stripping applies to the
// backup copy only. The origin machine keeps its working local plugin.
check('the profile on disk is untouched',
  Object.keys(JSON.parse(readFileSync(join(profDir, 'package.json'), 'utf8')).dependencies),
  ['dshmarket', 'local-thing'])

rmSync(home, { recursive: true, force: true })
console.log('')
console.log(fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
