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
function makeReq(method, action) {
  const body = action === undefined ? null : JSON.stringify({ action })
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

async function call(action) {
  let status = 0
  let out = ''
  const res = {
    writeHead(s, _h) { status = s },
    end(b) { out = (b === undefined ? '' : String(b)) },
  }
  await capturedRoute.handler(makeReq('POST', action), res)
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
  test.body.code === 'no_token'

console.log(pass ? '\nPASS — 未配置 token 的失败提示验证通过' : '\nFAIL')
process.exit(pass ? 0 : 1)
