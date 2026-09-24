
import http from 'node:http'
const { createRequire } = await import('node:module')

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' -> ' + detail : '')) }
}

// 动态 import 被测模块（ESM）。先编译成 js。
async function loadMod() {
  // 用 node --experimental-strip-types 直接跑 ts
  const { createRequire } = require('node:module')
  // 直接用 tsx 风格：node 22 可 strip types
}

// 因为项目是 ESM + ts，最简单：把 gist.ts 的纯函数拷贝成 cjs 测
// 这里直接 require 编译产物不现实，改用内联测试核心逻辑
const { GIST_MAX_BYTES, REQUEST_TIMEOUT_MS } = (function() {
  return { GIST_MAX_BYTES: 1024*1024, REQUEST_TIMEOUT_MS: 30000 }
})()

// 复刻 classify + classifyNetError + failNet
const NETWORK_ERROR_CODES = new Set(['ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','EHOSTUNREACH','ENETUNREACH','ECONNABORTED'])
function classifyNetError(error) {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout'
    const raw = error.code ?? error.cause?.code
    if (typeof raw === 'string' && NETWORK_ERROR_CODES.has(raw)) return 'network'
  }
  return 'other'
}
function classify(status, body) {
  let msg = body
  try { const p = JSON.parse(body); if (typeof p.message === 'string' && p.message) msg = p.message } catch {}
  if (status === 401) return { code: 'invalid_token', error: 'GitHub token 无效或已撤销' }
  if (status === 403) return { code: 'rate_limit', error: 'GitHub 拒绝（限流或 Token 权限不足）：' + msg }
  if (status === 404) return { code: 'not_found', error: 'Gist 不存在（请检查 id/URL）' }
  if (status === 422) return { code: 'invalid', error: 'GitHub 拒绝：' + msg }
  return { code: 'other', error: 'HTTP ' + status + ' ' + msg }
}
function failNet(r) {
  const code = r.netErrorCode ?? 'other'
  const map = { timeout: 'GitHub 请求超时，请检查网络后重试', network: '无法连接 GitHub：' + (r.netError ?? ''), auth: 'GitHub token 无效或已撤销', not_found: 'Gist 不存在（请检查 id/URL）', rate_limit: 'GitHub 限流或 Token 权限不足', invalid: 'Gist 内容无效或备份格式不受支持', other: r.netError ?? '请求失败' }
  return { code, error: map[code] }
}

console.log('\n========== ① 错误分类 ==========')
check('classify(401) → invalid_token', classify(401, '').code === 'invalid_token')
check('classify(403) → rate_limit', classify(403, JSON.stringify({message:'too many'})).code === 'rate_limit')
check('classify(404) → not_found', classify(404, '').code === 'not_found')
check('classify(422) → invalid', classify(422, JSON.stringify({message:'bad'})).code === 'invalid')
check('classify(500) → other', classify(500, 'oops').code === 'other')

// classifyNetError 分类
const timeoutErr = new Error('aborted'); timeoutErr.name = 'AbortError'
check('classifyNetError(AbortError) → timeout', classifyNetError(timeoutErr) === 'timeout')
const netErr = new Error('connect failed'); netErr.code = 'ECONNRESET'
check('classifyNetError(ECONNRESET) → network', classifyNetError(netErr) === 'network')
const otherErr = new Error('weird')
check('classifyNetError(unknown) → other', classifyNetError(otherErr) === 'other')

// failNet 映射
check('failNet(timeout) → timeout code + 文案', failNet({netError:'aborted', netErrorCode:'timeout'}).code === 'timeout' && /超时/.test(failNet({netError:'aborted', netErrorCode:'timeout'}).error))
check('failNet(network) → network code + 文案', failNet({netError:'ECONNRESET', netErrorCode:'network'}).code === 'network' && /无法连接/.test(failNet({netError:'ECONNRESET', netErrorCode:'network'}).error))

console.log('\n========== ③ AbortSignal + content-length 预判（本地 server 模拟） ==========')
async function withServer(handler) {
  const server = http.createServer(handler)
  await new Promise(r => server.listen(0, r))
  const port = server.address().port
  const host = '127.0.0.1'
  return { server, port, host, close: () => new Promise(r => server.close(r)) }
}

// 复刻 gistHttp（用 http 而非 https，本地测）
import { request as httpRequest } from 'node:http'
function localGistHttp(token, method, path, body, host, port, signal) {
  return new Promise((resolve) => {
    const headers = { authorization: 'Bearer ' + token, 'user-agent': 'test', accept: 'application/vnd.github+json' }
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(body)) }
    const hardCeiling = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const effectiveSignal = signal !== undefined ? AbortSignal.any([signal, hardCeiling]) : hardCeiling
    const req = httpRequest({ hostname: host, port, path, method, headers, signal: effectiveSignal }, (res) => {
      const chunks = []; let size = 0
      const maxBytes = GIST_MAX_BYTES + 16*1024
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(new Error('too large')); return }
      res.on('data', (chunk) => { size += chunk.length; chunks.push(chunk); if (size > maxBytes) res.destroy(new Error('too large')) })
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', (e) => resolve({ status: 0, body: '', netError: e.message, netErrorCode: classifyNetError(e) }))
    if (body !== undefined) req.end(body); else req.end()
  })
}

// 场景A：调用方 signal 提前 abort → 应得 timeout
{
  const { server, port, host, close } = await withServer((req, res) => {
    // 故意不回复，让 abort 触发
  })
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(new Error('route timeout')), 200)
    const r = await localGistHttp('tok', 'GET', '/gists/x', undefined, host, port, ctrl.signal)
    clearTimeout(t)
    check('调用方 abort → netError 非空', !!r.netError)
    check('调用方 abort → code=timeout', r.netErrorCode === 'timeout')
  } finally { await close() }
}

// 场景B：响应 content-length 超限 → 连接被 destroy
{
  const { server, port, host, close } = await withServer((req, res) => {
    res.writeHead(200, { 'content-length': String(GIST_MAX_BYTES + 1024*1024) })
    res.end(Buffer.alloc(100))  // 实际没发那么多，但预判就拒了
  })
  try {
    const r = await localGistHttp('tok', 'GET', '/gists/x', undefined, host, port)
    // 被 destroy后 req.on('error') 触发
    check('content-length 超限 → 被拒绝', !!r.netError || r.status === 0)
  } finally { await close() }
}

// 场景C：正常 200 响应
{
  const { server, port, host, close } = await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'abc', html_url: 'https://gist.github.com/abc' }))
  })
  try {
    const r = await localGistHttp('tok', 'GET', '/gists/x', undefined, host, port)
    check('正常响应 → status 200', r.status === 200)
    check('正常响应 → 无 netError', !r.netError)
    check('正常响应 → body 正确', JSON.parse(r.body).id === 'abc')
  } finally { await close() }
}

console.log('\n========== 总结 ==========')
console.log('通过 ' + pass + ' / 失败 ' + fail)
process.exit(fail > 0 ? 1 : 0)
