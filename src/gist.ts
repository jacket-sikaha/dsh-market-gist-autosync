/**
 * GitHub Gist HTTP layer + create/update/read operations.
 * Pure network + response shaping; no config or restore logic here.
 *
 * Error model (aligned with dsh-market's GistError/GistErrorCode):
 * - classify() maps HTTP status → {auth, rate_limit, not_found, invalid, other}
 * - classifyNetError() maps a thrown request error → {timeout, network, other}
 *   so the UI can distinguish "GitHub is unreachable" from "the request timed
 *   out" instead of collapsing both into a generic 'network' code.
 *
 * Request hardening (aligned with dsh-market's gistRequest):
 * - AbortSignal.any([caller signal, 30s hard ceiling]) so a wedged connection
 *   or a forgotten caller signal can never leave a request running forever.
 * - Response body capped by content-length pre-check + streaming byte count, so
 *   a hostile or malformed Gist cannot OOM the process while it is being read.
 */
import { request as httpsRequest } from 'node:https'
import { GIST_FILENAME, GIST_MAX_BYTES, REQUEST_TIMEOUT_MS, err, type Result } from './config.js'

/** Machine-readable error codes the UI maps to localized messages. */
export type GistErrorCode = 'auth' | 'not_found' | 'rate_limit' | 'invalid' | 'timeout' | 'network' | 'other'

/** Node network error codes that mean "GitHub is unreachable". */
const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED',
])

export interface GistHttpResult {
  status: number
  body: string
  /** Set when the request never reached a server: timeout or network failure. */
  netError?: string
  /** Stable code for the netError, when set; mirrors GistErrorCode for the UI. */
  netErrorCode?: GistErrorCode
}

/** Map a thrown request-level error to a stable code (timeout / network / other). */
export function classifyNetError(error: unknown): GistErrorCode {
  if (error instanceof Error) {
    // AbortSignal.timeout / AbortController.abort surface as these names.
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout'
    const raw = (error as { code?: unknown }).code ?? (error as { cause?: { code?: unknown } }).cause?.code
    if (typeof raw === 'string' && NETWORK_ERROR_CODES.has(raw)) return 'network'
  }
  return 'other'
}

/**
 * One HTTP round-trip to api.github.com. The 30s hard ceiling always applies
 * (AbortSignal.timeout); when a caller signal is given it is merged with
 * AbortSignal.any so the route-level ceiling wins first and the 30s is the
 * fallback that guarantees termination.
 */
export function gistHttp(token: string, method: string, path: string, body?: string, host = 'api.github.com', signal?: AbortSignal): Promise<GistHttpResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'user-agent': 'dsh-market-gist-autosync',
      accept: 'application/vnd.github+json',
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(body))
    }
    // Hard ceiling: even a forgotten caller signal cannot hang the server.
    const hardCeiling = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const effectiveSignal = signal !== undefined ? AbortSignal.any([signal, hardCeiling]) : hardCeiling
    const req = httpsRequest(
      { hostname: host, path, method, headers, signal: effectiveSignal },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        // GET returns the whole Gist including metadata; POST/PATCH echo the
        // file content back, so a large upload makes the response as large. Cap
        // all methods alike so a hostile Gist cannot OOM us.
        const maxBytes = GIST_MAX_BYTES + 16 * 1024
        // Pre-check a declared content-length so a multi-MB response is refused
        // before the first chunk is ever buffered.
        const declared = Number(res.headers['content-length'])
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy(new Error('GitHub response is too large'))
          return
        }
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          chunks.push(chunk)
          if (size > maxBytes) res.destroy(new Error('GitHub response is too large'))
        })
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', (e) => resolve({ status: 0, body: '', netError: e.message, netErrorCode: classifyNetError(e) }))
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

/** Map a GitHub HTTP failure to a typed Result. */
export function classify(status: number, body: string): Result {
  let msg = body
  try {
    const p = JSON.parse(body)
    if (typeof p.message === 'string' && p.message) msg = p.message
  } catch {
    // keep raw
  }
  if (status === 401) return err('invalid_token', 'GitHub token 无效或已撤销')
  if (status === 403) return err('rate_limit', `GitHub 拒绝（限流或 Token 权限不足）：${msg}`)
  if (status === 404) return err('not_found', 'Gist 不存在（请检查 id/URL）')
  if (status === 422) return err('invalid', `GitHub 拒绝：${msg}`)
  return err('other', `HTTP ${status} ${msg}`)
}

/** Turn a netError-bearing GistHttpResult into a typed Result. */
/** Turn a netError-bearing GistHttpResult into a typed Result. */
export function failNet(r: GistHttpResult): Result {
  const code = r.netErrorCode ?? 'other'
  const map: Record<GistErrorCode, string> = {
    timeout: 'GitHub 请求超时，请检查网络后重试',
    network: `无法连接 GitHub：${r.netError ?? ''}`,
    auth: 'GitHub token 无效或已撤销',
    not_found: 'Gist 不存在（请检查 id/URL）',
    rate_limit: 'GitHub 限流或 Token 权限不足',
    invalid: 'Gist 内容无效或备份格式不受支持',
    other: r.netError ?? '请求失败',
  }
  return err(code, map[code])
}

export async function createGist(token: string, content: string, host: string, signal?: AbortSignal): Promise<Result> {
  const body = JSON.stringify({
    description: 'dsh profile backup (dsh-market-gist-autosync)',
    public: false,
    files: { [GIST_FILENAME]: { content } },
  })
  const r = await gistHttp(token, 'POST', '/gists', body, host, signal)
  if (r.netError) return failNet(r)
  if (r.status !== 201) return classify(r.status, r.body)
  const data = JSON.parse(r.body)
  return { ok: true, gistId: data.id, gistUrl: data.html_url || `https://gist.github.com/${data.id}`, createdAt: data.created_at, updatedAt: data.updated_at }
}

export async function updateGist(token: string, gistId: string, content: string, host: string, signal?: AbortSignal): Promise<Result> {
  const body = JSON.stringify({
    files: { [GIST_FILENAME]: { content } },
  })
  const r = await gistHttp(token, 'PATCH', `/gists/${gistId}`, body, host, signal)
  if (r.netError) return failNet(r)
  if (r.status !== 200) return classify(r.status, r.body)
  const data = JSON.parse(r.body)
  return { ok: true, gistId: data.id || gistId, gistUrl: data.html_url || `https://gist.github.com/${gistId}`, createdAt: data.created_at, updatedAt: data.updated_at }
}

export async function verifyToken(token: string, host: string, signal?: AbortSignal): Promise<Result> {
  const r = await gistHttp(token, 'GET', '/user', undefined, host, signal)
  if (r.netError) return failNet(r)
  if (r.status !== 200) return classify(r.status, r.body)
  return { ok: true, message: '连接正常' }
}

/** Fetch the raw text of the backup file inside a gist. Accepts our filename,
 * dshmarket's filename, or any single file whose content looks like a backup. */
export async function readGistBackupContent(token: string, gistId: string, host: string, signal?: AbortSignal): Promise<{ ok: true; content: string } | { ok: false; code: string; error: string }> {
  const r = await gistHttp(token, 'GET', `/gists/${gistId}`, undefined, host, signal)
  if (r.netError) return failNet(r) as { ok: false; code: string; error: string }
  if (r.status !== 200) return classify(r.status, r.body) as { ok: false; code: string; error: string }
  let data: { files?: Record<string, { content?: string }> }
  try {
    data = JSON.parse(r.body)
  } catch {
    return err('invalid', 'Gist 响应不是有效 JSON') as { ok: false; code: string; error: string }
  }
  const filesObj = data.files ?? {}
  const candidate = filesObj[GIST_FILENAME]?.content
    ?? filesObj['dsh-config-backup.json']?.content
    ?? (Object.values(filesObj).find((f) => typeof f?.content === 'string' && f.content.includes('"dsh-profile-backup"'))?.content)
  if (typeof candidate !== 'string') return err('invalid', 'Gist 中找不到 dsh 备份文件') as { ok: false; code: string; error: string }
  return { ok: true, content: candidate }
}
