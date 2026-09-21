// Profile-detection integration test: initProfileContext must resolve the
// booted profile from the desktopProfiles service (Desktop), then from
// `--profile` argv (plain dsh web), then DSH_PROFILE env, then 'desktop'.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Isolate config/home before loading the bundle.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'gist-profile-itest-'))

const here = dirname(fileURLToPath(import.meta.url))
const lib = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const { initProfileContext, activeProfile } = lib

let pass = 0, fail = 0
function check(label, cond) {
  if (cond) { pass++; console.log(`✓ ${label}`) } else { fail++; console.log(`✗ ${label}`) }
}

const realArgv = process.argv
const realEnv = process.env.DSH_PROFILE

function reset() {
  process.argv = realArgv.filter((a, i) => {
    if (a === '--profile') return false
    if (i > 0 && realArgv[i - 1] === '--profile') return false
    return true
  })
  delete process.env.DSH_PROFILE
}

// 1) desktopProfiles service wins over everything (Desktop contract)
reset()
process.argv = [...process.argv, '--profile', 'web']
process.env.DSH_PROFILE = 'should-not-win'
const desktopCtx = { get: (k) => (k === 'desktopProfiles' ? { current: { name: 'desktop', dir: 'D:\\profiles\\desktop' } } : undefined) }
initProfileContext(desktopCtx)
check('desktopProfiles service beats argv and env', activeProfile() === 'desktop')

// 2) argv --profile wins when the service is absent (plain `dsh web --profile web`)
reset()
process.argv = [...process.argv, '--profile', 'web']
initProfileContext({ get: () => undefined })
check('argv --profile detected without desktopProfiles', activeProfile() === 'web')

// 3) --profile without a value (flag at end) falls through to env
reset()
process.argv = [...process.argv, '--profile']
process.env.DSH_PROFILE = 'envprofile'
initProfileContext({ get: () => undefined })
check('bare --profile flag ignored, env used', activeProfile() === 'envprofile')

// 4) nothing detectable -> historical default
reset()
initProfileContext({ get: () => undefined })
check('falls back to desktop', activeProfile() === 'desktop')

// 5) a desktopProfiles service with a malformed current entry falls through
reset()
initProfileContext({ get: (k) => (k === 'desktopProfiles' ? { current: {} } : undefined) })
check('malformed desktopProfiles falls through to default', activeProfile() === 'desktop')

process.argv = realArgv
if (realEnv === undefined) delete process.env.DSH_PROFILE
else process.env.DSH_PROFILE = realEnv

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} profile-detection cases`)
process.exit(fail === 0 ? 0 : 1)
