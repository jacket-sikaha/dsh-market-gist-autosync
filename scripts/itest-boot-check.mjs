// Integration test: the post-restore boot pre-check. The boot loader reads
// dsh.profile.bundles and dies on the FIRST name it cannot resolve - the whole
// profile, not just that plugin - and only at the NEXT restart. A gist that
// carries a bundle this machine cannot resolve (classically a link: dep from
// another machine) used to restore "successfully" and then boot into recovery
// mode. These cases pin the fix: catch it, drop it, and never mistake an
// unknown for a missing package.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href
const { analyzeBundles, orphanBundles, removeBundles, findDshInstallDir, INBOX_BUNDLES } = await import(libUrl)

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass += 1; console.log('  PASS  ' + label) }
  else { fail += 1; console.log('  FAIL  ' + label + '\n        got:  ' + a + '\n        want: ' + e) }
}

const root = mkdtempSync(join(tmpdir(), 'gist-bootcheck-'))
// A bundle is not merely a directory holding a package.json: the loader reads
// dsh.bundle.patch from that manifest and parses the file it names, throwing on
// every failure. Fixtures therefore carry a real patch by default, so a case
// that wants a broken bundle has to say so explicitly.
const PATCH = './cordis.patch.yml'
const OK_PATCH = '- id: fixture\n  config:\n    enabled: true\n'
function profile(name, manifest, present = []) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const dep of present) {
    const spec = typeof dep === 'string' ? { name: dep } : dep
    const pkgName = spec.name
    const pkgDir = join(dir, 'node_modules', pkgName)
    mkdirSync(pkgDir, { recursive: true })
    const manifestJson = { name: pkgName, version: '1.0.0' }
    if (spec.patch !== undefined) manifestJson.dsh = { bundle: { patch: PATCH } }
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifestJson))
    if (spec.patch !== undefined) writeFileSync(join(pkgDir, 'cordis.patch.yml'), spec.patch)
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  return dir
}
/** A present package that declares a patch (the healthy shape). */
const bundled = (name, patch = OK_PATCH) => ({ name, patch })

try {
  console.log('=== 1) the historical failure: a link: dep from another machine ===')
  const broken = profile('broken', {
    name: 'dsh-profile-desktop',
    dependencies: { 'settings-scroll-fix': 'link:C:/Users/Someone/Desktop/elsewhere/settings-scroll-fix' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'settings-scroll-fix', 'good-plugin'] } },
  }, [bundled('good-plugin')])
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
  }, [bundled('my-plugin')])
  check('no orphans', orphanBundles(healthy, null), [])
  check('the plugin resolves to a directory', analyzeBundles(healthy, null).find((l) => l.name === 'my-plugin').directory !== null, true)

  console.log('=== 4) unknown is not missing (the dangerous confusion) ===')
  // createRequire needs an ABSOLUTE anchor. A relative one used to throw, which
  // was swallowed as "not found" - reporting every bundle missing and then
  // deleting them all. A probe that cannot run must read as unknown.
  const rel = profile('relcheck', { name: 'dsh-profile-desktop', dsh: { profile: { bundles: ['relplug'] } } }, [bundled('relplug')])
  const relDir = rel.replace(process.cwd(), '.').split('\\').join('/')
  check('a relative profile directory still resolves', orphanBundles(relDir, null), [])
  check('and still finds the package', analyzeBundles(relDir, null)[0].directory !== null, true)

  console.log('=== 5) genuinely absent IS fatal ===')
  const missing = profile('missing', { name: 'dsh-profile-desktop', dsh: { profile: { bundles: ['ghost'] } } })
  check('valid anchors + package not there -> error', analyzeBundles(missing, null)[0].error !== null, true)
  check('and it is reported as an orphan', orphanBundles(missing, null), ['ghost'])

  console.log('=== 6) a bundle that resolves can still fail the boot ===')
  // Resolving the directory is not the end of the loader's work: it then reads
  // dsh.bundle.patch and parses the named file, throwing on each failure. These
  // cases pin the second half of the pre-check - the half that used to pass a
  // resolvable-but-unbootable bundle and let the user meet it as a recovery-mode
  // restart, the exact outcome the pre-check exists to prevent.
  const patchCases = profile('patchcases', {
    name: 'dsh-profile-desktop',
    dsh: { profile: { bundles: ['no-decl', 'missing-patch', 'bad-yaml', 'not-array', 'healthy'] } },
  }, [
    { name: 'no-decl' },                                   // no dsh.bundle at all
    { name: 'missing-patch', patch: undefined },            // declares, file absent
    { name: 'bad-yaml', patch: 'a: [1, 2\n  b: : :\n' },    // unparseable
    { name: 'not-array', patch: 'just: a string\n' },       // parses, wrong shape
    bundled('healthy'),                                     // the control
  ])
  check('and the healthy bundle is left alone',
    analyzeBundles(patchCases, null).find((l) => l.name === 'healthy').error, null)
  // The two parse cases only yield a verdict where js-yaml resolves (the plugin
  // resolves it from its own install location or the dsh installation). When it
  // does not, the check must report UNKNOWN rather than guess, because a wrong
  // "malformed" would delete a working plugin. Both outcomes are asserted
  // strictly, so a missing parser can never masquerade as a passing suite.
  const parserAnchor = [process.env.DSH_INSTALL_ANCHOR, findDshInstallDir()]
    .filter((p) => typeof p === 'string' && p !== '')
    .find((p) => { try { createRequire(p)('js-yaml'); return true } catch { return false } })
  const parseLayers = analyzeBundles(patchCases, parserAnchor ?? null)
    .filter((l) => l.name === 'bad-yaml' || l.name === 'not-array')
  const alwaysFatal = ['missing-patch', 'no-decl']
  if (parserAnchor === undefined) {
    check('no js-yaml here -> both parse cases are UNKNOWN, never fatal',
      parseLayers.map((l) => [l.error, l.unresolvedInbox]), [[null, true], [null, true]])
    check('the parser-independent shapes are still fatal',
      orphanBundles(patchCases, null).sort(), alwaysFatal)
    console.log('  SKIP  parser-dependent fatal assertions (no js-yaml resolvable in this checkout)')
  } else {
    check('every unbootable shape is reported fatal',
      analyzeBundles(patchCases, parserAnchor).filter((l) => l.error !== null).map((l) => l.name).sort(),
      ['bad-yaml', 'missing-patch', 'no-decl', 'not-array'])
    check('orphanBundles reports all four, not the healthy one',
      orphanBundles(patchCases, parserAnchor).sort(), ['bad-yaml', 'missing-patch', 'no-decl', 'not-array'])
  }
  // The !!js scalar tag is part of the loader's dialect and is used by real
  // community patches (dsh-better-sidebar, @tt-a1i/archify-dsh both ship it).
  // Parsing with a plain YAML/JSON reader would call these healthy plugins
  // malformed and then DELETE them, so the control matters as much as the
  // failures above.
  const jsBundle = profile('jsbundle', {
    name: 'dsh-profile-desktop',
    dsh: { profile: { bundles: ['js-plugin'] } },
  }, [bundled('js-plugin', "- id: s\n  config:\n    enabled: !!js ctx.get('x') ?? true\n")])
  check('a !!js patch is healthy, never malformed', orphanBundles(jsBundle, null), [])

  console.log('=== 7) malformed input never crashes or over-reports ===')
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