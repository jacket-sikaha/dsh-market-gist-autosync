// Integration test: the post-restore boot pre-check. The boot loader reads
// dsh.profile.bundles and dies on the FIRST name it cannot resolve - the whole
// profile, not just that plugin - and only at the NEXT restart. A gist that
// carries a bundle this machine cannot resolve (classically a link: dep from
// another machine) used to restore "successfully" and then boot into recovery
// mode. These cases pin the fix: catch it, drop it, and never mistake an
// unknown for a missing package.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href
const { analyzeBundles, orphanBundles, removeBundles, INBOX_BUNDLES } = await import(libUrl)

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass += 1; console.log('  PASS  ' + label) }
  else { fail += 1; console.log('  FAIL  ' + label + '\n        got:  ' + a + '\n        want: ' + e) }
}

const root = mkdtempSync(join(tmpdir(), 'gist-bootcheck-'))
// A resolved package needs a package.json - that is exactly what the check probes for.
function profile(name, manifest, present = []) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const dep of present) {
    const pkgDir = join(dir, 'node_modules', dep)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: dep, version: '1.0.0' }))
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  return dir
}

try {
  console.log('=== 1) the historical failure: a link: dep from another machine ===')
  const broken = profile('broken', {
    name: 'dsh-profile-desktop',
    dependencies: { 'settings-scroll-fix': 'link:C:/Users/Someone/Desktop/elsewhere/settings-scroll-fix' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'settings-scroll-fix', 'good-plugin'] } },
  }, ['good-plugin'])
  check('unresolvable community bundle is flagged fatal',
    analyzeBundles(broken, null).filter((l) => l.error !== null).map((l) => l.name), ['settings-scroll-fix'])
  check('in-box bundle is NOT fatal (supplied by the installation)',
    analyzeBundles(broken, null).find((l) => l.name === '@deepseek-ai/dsh-base').error, null)
  check('orphanBundles reports only the community name', orphanBundles(broken, null), ['settings-scroll-fix'])

  console.log('=== 2) removal makes the profile bootable again ===')
  check('removeBundles returns what it dropped', removeBundles(broken, orphanBundles(broken, null)), ['settings-scroll-fix'])
  check('bundles no longer name it',
    JSON.parse(readFileSync(join(broken, 'package.json'), 'utf8')).dsh.profile.bundles,
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'good-plugin'])
  check('deps are left alone (install.ts owns those)',
    Object.keys(JSON.parse(readFileSync(join(broken, 'package.json'), 'utf8')).dependencies), ['settings-scroll-fix'])
  check('the profile now passes the pre-check', orphanBundles(broken, null), [])
  check('removal is idempotent', removeBundles(broken, orphanBundles(broken, null)), [])

  console.log('=== 3) a healthy profile is never touched ===')
  const healthy = profile('healthy', {
    name: 'dsh-profile-desktop',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'my-plugin'] } },
  }, ['my-plugin'])
  check('no orphans', orphanBundles(healthy, null), [])
  check('the plugin resolves to a directory', analyzeBundles(healthy, null).find((l) => l.name === 'my-plugin').directory !== null, true)

  console.log('=== 4) unknown is not missing (the dangerous confusion) ===')
  // createRequire needs an ABSOLUTE anchor. A relative one used to throw, which
  // was swallowed as "not found" - reporting every bundle missing and then
  // deleting them all. A probe that cannot run must read as unknown.
  const rel = profile('relcheck', { name: 'dsh-profile-desktop', dsh: { profile: { bundles: ['relplug'] } } }, ['relplug'])
  const relDir = rel.replace(process.cwd(), '.').split('\\').join('/')
  check('a relative profile directory still resolves', orphanBundles(relDir, null), [])
  check('and still finds the package', analyzeBundles(relDir, null)[0].directory !== null, true)

  console.log('=== 5) genuinely absent IS fatal ===')
  const missing = profile('missing', { name: 'dsh-profile-desktop', dsh: { profile: { bundles: ['ghost'] } } })
  check('valid anchors + package not there -> error', analyzeBundles(missing, null)[0].error !== null, true)
  check('and it is reported as an orphan', orphanBundles(missing, null), ['ghost'])

  console.log('=== 6) malformed input never crashes or over-reports ===')
  check('empty bundle list', orphanBundles(profile('empty', { name: 'dsh-profile-desktop', dsh: { profile: { bundles: [] } } }), null), [])
  check('no bundles field', orphanBundles(profile('nobundles', { name: 'dsh-profile-desktop' }), null), [])
  check('non-string entries are ignored',
    orphanBundles(profile('mixed', { name: 'dsh-profile-desktop', dsh: { profile: { bundles: [123, null, 'ghost2'] } } }), null), ['ghost2'])
  check('a directory that does not exist', orphanBundles(join(root, 'nope'), null), [])
  check('removeBundles on nothing is a no-op', removeBundles(healthy, []), [])
  check('INBOX_BUNDLES is the in-box trio', [...INBOX_BUNDLES], ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'])
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('')
console.log(fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)