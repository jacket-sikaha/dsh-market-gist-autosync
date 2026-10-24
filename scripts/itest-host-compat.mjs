// itest-host-compat.mjs
//
// Proves the plugin loads and serves on the *real* host contract instead of a
// hand-written mock: a genuine cordis Context, the genuine web server service
// from @deepseek-ai/dsh-host-webserver, and the plugin mounted through
// ctx.plugin() exactly the way DSH mounts it.
//
// What it pins down (the parts this plugin depends on):
//   - cordis 4.x plugin shape: an exported { name, inject, apply, Config } module
//     object mounts and applies without throwing.
//   - webServer.register({ kind: 'exact', path, handler }) still exists and the
//     handler is reached through real HTTP on a loopback port.
//   - the route keeps its posture: POST only (405 + allow for anything else),
//     cross-site Origin refused with 403, same-origin config read answered 200.
//
// The host package is a devDependency pinned to the DSH release line we claim to
// support, so a breaking host change fails here rather than in the field.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import webserver from '@deepseek-ai/dsh-host-webserver'

// The plugin opens its upload table through ctx.get('storageDomain') and only
// falls back to config.json after a retry deadline when the service never
// appears — which would make every RPC call here wait out that deadline. The
// service contract is the only thing this test needs from storage, so a small
// in-memory facility stands in for the real domain package.
class StorageStub extends Service {
  constructor(c) {
    super(c, 'storageDomain')
  }

  async open() {
    const tables = new Map()
    return {
      table(name) {
        let map = tables.get(name)
        if (map === undefined) {
          map = new Map()
          tables.set(name, map)
        }
        return {
          async put(key, value) {
            map.set(String(key), value)
          },
          get(key) {
            return map.get(String(key))
          },
          get size() {
            return map.size
          },
          keys() {
            return [...map.keys()][Symbol.iterator]()
          },
          entries() {
            return [...map.entries()][Symbol.iterator]()
          },
          async delete(key) {
            return map.delete(String(key))
          },
        }
      },
      async close() {},
    }
  }
}

const here = fileURLToPath(new URL('.', import.meta.url))
const ROUTE = '/dsh-market-gist-autosync/rpc'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) console.log(`  PASS ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// A throwaway DSH home so the plugin reads and writes its own config file here
// instead of touching the real profile of whoever runs the test.
const root = mkdtempSync(join(tmpdir(), 'dsh-host-compat-'))
const profile = join(root, 'profiles', 'compat')
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'compat-profile', version: '1.0.0', dependencies: {} }, null, 2))
process.env.DSH_HOME = root
process.env.DSH_PROFILE = 'compat'
delete process.env.DSH_GITHUB_TOKEN

function call(port, { method = 'POST', body, origin } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: ROUTE,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          ...(origin === undefined ? {} : { origin }),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    const timer = setTimeout(() => req.destroy(new Error('request timed out')), 5000)
    req.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    req.on('close', () => clearTimeout(timer))
    if (body !== undefined) req.write(body)
    req.end()
  })
}

let ctx
try {
  const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

  ctx = new Context()
  try {
    await ctx.plugin(webserver, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(StorageStub)
  } catch (e) {
    check('the host web server boots on the pinned contract', false, String(e?.message ?? e))
    throw e
  }
  const server = ctx.get('webServer')
  check('the host web server boots on the pinned contract', server !== undefined)
  const port = server?.port
  check('the host hands out an OS-assigned loopback port', typeof port === 'number' && port > 0, String(port))

  try {
    await ctx.plugin(plugin, {})
  } catch (e) {
    check('the plugin mounts into the real context', false, String(e?.message ?? e))
    throw e
  }
  check('the plugin mounts into the real context', true)

  // A config.json written by an older version still carries switches that no
  // longer exist (`includePluginLogs` went away when the collector started
  // skipping every hidden directory; `includeLock` when pnpm-lock.yaml joined
  // PROFILE_SKIP). Read must drop them, or the UI would show a switch that does
  // nothing and every save would copy the dead key forward.
  mkdirSync(join(root, 'gist-autosync'), { recursive: true })
  writeFileSync(
    join(root, 'gist-autosync', 'config.json'),
    JSON.stringify({ gistId: 'legacy-abc', scheduleIntervalValue: 6, includePluginLogs: true, includeLock: true }, null, 2),
  )

  const ok = await call(port, { body: JSON.stringify({ action: 'getConfig' }) })
  let payload
  try {
    payload = JSON.parse(ok.text)
  } catch {
    payload = undefined
  }
  check('POST getConfig is answered 200', ok.status === 200, `status ${ok.status} body ${ok.text.slice(0, 200)}`)
  check('the answer is the plugin JSON envelope', payload?.ok === true, ok.text.slice(0, 200))
  check('the answer carries the config the UI reads', payload?.config?.scheduleIntervalUnit === 'hour', JSON.stringify(payload?.config ?? null).slice(0, 200))
  check('the answer reports the active profile', payload?.activeProfile === 'compat', String(payload?.activeProfile))
  check('no token is reported when none is set', payload?.envTokenSet === false, String(payload?.envTokenSet))
  check('a legacy includePluginLogs key is not echoed back', payload?.config !== undefined && !('includePluginLogs' in payload.config), JSON.stringify(Object.keys(payload?.config ?? {})))
  check('a legacy includeLock key is not echoed back', payload?.config !== undefined && !('includeLock' in payload.config))
  check('the real settings in that file still come back', payload?.config?.scheduleIntervalValue === 6, String(payload?.config?.scheduleIntervalValue))
  check('the profile package.json is left alone', JSON.parse((await import('node:fs')).readFileSync(join(profile, 'package.json'), 'utf8')).name === 'compat-profile')

  // The UI's "查看备份内容" dialog: same route, read-only action. It has to work
  // through the real host too, and its size numbers come from the same collector
  // the upload path uses.
  const preview = await call(port, { body: JSON.stringify({ action: 'previewBackup' }) })
  let previewPayload
  try {
    previewPayload = JSON.parse(preview.text)
  } catch {
    previewPayload = undefined
  }
  check('POST previewBackup is answered 200', preview.status === 200, `status ${preview.status} body ${preview.text.slice(0, 200)}`)
  check(
    'the preview lists the manifest as a primary entry',
    previewPayload?.preview?.entries?.[0]?.path === 'package.json' && previewPayload?.preview?.entries?.[0]?.tier === 'primary',
    preview.text.slice(0, 200),
  )
  check('the preview reports the 1 MB ceiling', previewPayload?.limitBytes === 1048576, String(previewPayload?.limitBytes))
  const previewExtra = await call(port, { body: JSON.stringify({ action: 'previewBackup', includePluginLogs: true }) })
  check(
    'a stale log toggle in the body is ignored, not echoed',
    JSON.parse(previewExtra.text)?.preview?.includePluginLogs === undefined,
    previewExtra.text.slice(0, 200),
  )

  // The restore progress the settings card polls while a restore runs. Its shape
  // is a contract with the client: six fixed stages in order, a state machine the
  // card renders as-is, and the outcome on `success` so it never collides with the
  // RPC envelope's own `ok`.
  const idle = await call(port, { body: JSON.stringify({ action: 'restoreProgress' }) })
  const idlePayload = JSON.parse(idle.text)
  check('POST restoreProgress is answered 200', idle.status === 200, `status ${idle.status} body ${idle.text.slice(0, 200)}`)
  check('an idle progress reports itself as finished', idlePayload?.active === false && idlePayload?.done === true, idle.text.slice(0, 200))
  check('the progress keeps the RPC envelope ok', idlePayload?.ok === true)
  check('the outcome rides on success, not on the envelope ok', idlePayload?.success === null, String(idlePayload?.success))
  check(
    'the progress carries the six ordered stages',
    JSON.stringify((idlePayload?.stages ?? []).map((s) => s.key)) === JSON.stringify(['fetch', 'validate', 'write', 'probe', 'install', 'boot']),
    JSON.stringify((idlePayload?.stages ?? []).map((s) => s.key)),
  )
  check(
    'every stage is labelled for the UI',
    (idlePayload?.stages ?? []).every((s) => typeof s.label === 'string' && s.label.length > 0),
    JSON.stringify((idlePayload?.stages ?? []).map((s) => s.label)),
  )

  // A restore that cannot even start has to come back with a finished progress
  // state, otherwise the card would spin forever and the 409 gate would stay shut.
  // This fixture has no token, so the restore dies in resolveToken before anything
  // touches the profile.
  const badRestore = await call(port, { body: JSON.stringify({ action: 'restore', gist: 'not-a-gist' }) })
  const badPayload = JSON.parse(badRestore.text)
  check('a restore that cannot start reports a failure', badPayload?.ok === false, badRestore.text.slice(0, 200))
  check('the failure still ships a progress the card can draw', badPayload?.progress !== undefined && badPayload?.progress?.active === false, badRestore.text.slice(0, 300))
  check('the failed restore is attributed to a stage', badPayload?.progress?.stages?.[0]?.status === 'fail', JSON.stringify(badPayload?.progress?.stages?.[0] ?? null))
  check('the failed restore carries its reason', badPayload?.progress?.success === false, String(badPayload?.progress?.success))
  check(
    'a failed restore leaves the profile manifest untouched',
    JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).name === 'compat-profile',
  )

  const cross = await call(port, { body: JSON.stringify({ action: 'getConfig' }), origin: 'https://evil.example' })
  check('a cross-site Origin is refused 403', cross.status === 403, `status ${cross.status}`)
  check('the refusal carries no config', !cross.text.includes('scheduleIntervalUnit'), cross.text.slice(0, 120))

  const wrongMethod = await call(port, { method: 'GET' })
  check('GET is refused 405', wrongMethod.status === 405, `status ${wrongMethod.status}`)
  check('the 405 advertises POST', String(wrongMethod.headers?.allow ?? '').toUpperCase().includes('POST'), String(wrongMethod.headers?.allow))

  await ctx.fiber.dispose()
  let closed = false
  try {
    await call(port, { body: JSON.stringify({ action: 'getConfig' }) })
  } catch {
    closed = true
  }
  check('disposing the context releases the listener', closed)
} catch (e) {
  failures++
  console.log(`  FAIL the boot sequence completed — ${e?.stack ?? e}`)
} finally {
  try {
    if (ctx) await ctx.fiber.dispose()
  } catch {
    /* already disposed */
  }
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nhost-compat: all checks passed' : `\nhost-compat: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
