import { Context } from '@deepseek-ai/cordis'
import { name, inject, Config, apply } from '../lib/index.js'

// Capture the route the plugin registers, so we can drive its handler directly
// (bypassing the desktop webServer's browser-only auth gate).
let capturedRoute = null

const root = new Context()
root.provide('webServer', {
  register(route) {
    capturedRoute = route
    return () => {}
  },
})

await root.plugin({ name, inject, Config, apply }, {})

if (!capturedRoute) {
  console.error('FAIL: plugin did not register a route')
  process.exit(1)
}
console.log(`route registered: kind=${capturedRoute.kind} path=${capturedRoute.path}`)

// Minimal request/response doubles matching the plugin handler's usage.
function makeReq(method, action, extra) {
  const body = action === undefined ? null : JSON.stringify(Object.assign({ action }, extra || {}))
  return {
    method,
    headers: { origin: '' },
    on(ev, cb) {
      if (ev === 'data' && body !== null) cb(Buffer.from(body))
      if (ev === 'end') cb()
      return this
    },
  }
}

async function call(action, extra) {
  let status = 0
  let out = ''
  const res = {
    writeHead(s, _h) { status = s },
    end(b) { out = (b === undefined ? '' : String(b)) },
  }
  await capturedRoute.handler(makeReq('POST', action, extra), res)
  return { status, body: out ? JSON.parse(out) : null }
}

// 1) getConfig should return defaults + detected device name
const cfg = await call('getConfig')
console.log('getConfig ->', JSON.stringify(cfg))

// 2) backupNow WITHOUT token must return the failure prompt (requirement #3)
const backup = await call('backupNow')
console.log('backupNow (no token) ->', JSON.stringify(backup))

// 3) testConnection WITHOUT token must return the same failure prompt
const test = await call('testConnection')
console.log('testConnection (no token) ->', JSON.stringify(test))

// 4) saveConfig must persist the token to disk (write path)
const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const cfgPath = path.join(os.homedir(), '.dsh', 'gist-autosync', 'config.json')
// Save a fake token through the RPC, then read the file back
const save = await call('saveConfig', { config: {
  gistToken: 'ghp_SMOKE_TEST_TOKEN', gistId: '', fileNamePrefix: 'config',
  fileName: '', deviceName: 'SMOKEBOX', scheduleEnabled: false, scheduleIntervalHours: 24,
} })
console.log('saveConfig ->', JSON.stringify(save.body))
const persisted = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : null
console.log('persisted gistToken set:', !!(persisted && persisted.gistToken), '| deviceName:', persisted && persisted.deviceName)

const pass =
  cfg.status === 200 &&
  cfg.body &&
  cfg.body.ok === true &&
  typeof cfg.body.deviceNameDetected === 'string' &&
  backup.status === 200 &&
  backup.body &&
  backup.body.ok === false &&
  backup.body.code === 'no_token' &&
  typeof backup.body.error === 'string' &&
  test.status === 200 &&
  test.body &&
  test.body.ok === false &&
  test.body.code === 'no_token' &&
  save.status === 200 &&
  save.body &&
  save.body.ok === true &&
  persisted &&
  persisted.gistToken === 'ghp_SMOKE_TEST_TOKEN' &&
  persisted.deviceName === 'SMOKEBOX'

console.log(pass ? '\nPASS — 未配置 token 的失败提示验证通过' : '\nFAIL')
process.exit(pass ? 0 : 1)
