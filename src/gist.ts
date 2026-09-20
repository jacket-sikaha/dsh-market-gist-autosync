/**
 * GitHub Gist HTTP layer + create/update/read operations.
 * Pure network + response shaping; no config or restore logic here.
 */
import { request as httpsRequest } from 'node:https'
import { GIST_FILENAME, GIST_MAX_BYTES, REQUEST_TIMEOUT_MS, err, type Result } from './config.js'

export interface GistHttpResult {
  status: number
  body: string
  netError?: string
}

export function gistHttp(token: string, method: string, path: string, body?: string, host = 'api.github.com'): Promise<GistHttpResult> {
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
    const req = httpsRequest(
      { hostname: host, path, method, headers },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          chunks.push(chunk)
          if (size > GIST_MAX_BYTES + 16 * 1024) res.destroy()
        })
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', (e) => resolve({ status: 0, body: '', netError: e.message }))
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')))
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

export function classify(status: number, body: string): Result {
  let msg = body
  try {
    const p = JSON.parse(body)
    if (typeof p.message === 'string' && p.message) msg = p.message
  } catch {
    // keep raw
  }
  if (status === 401) return err('invalid_token', 'GitHub token 无效或已撤销')
  if (status === 403) return err('rate_limit', `GitHub 拒绝：${msg}`)
  if (status === 404) return err('invalid_gist', 'Gist 不存在（请检查 id/URL）')
  if (status === 422) return err('invalid_gist', `GitHub 拒绝：${msg}`)
  return err('other', `HTTP ${status} ${msg}`)
}

export async function createGist(token: string, content: string, host: string): Promise<Result> {
  const body = JSON.stringify({
    description: 'dsh profile backup (dsh-market-gist-autosync)',
    public: false,
    files: { [GIST_FILENAME]: { content } },
  })
  const r = await gistHttp(token, 'POST', '/gists', body, host)
  if (r.netError) return err('network', r.netError)
  if (r.status !== 201) return classify(r.status, r.body)
  const data = JSON.parse(r.body)
  return { ok: true, gistId: data.id, gistUrl: data.html_url || `https://gist.github.com/${data.id}`, createdAt: data.created_at, updatedAt: data.updated_at }
}

export async function updateGist(token: string, gistId: string, content: string, host: string): Promise<Result> {
  const body = JSON.stringify({
    files: { [GIST_FILENAME]: { content } },
  })
  const r = await gistHttp(token, 'PATCH', `/gists/${gistId}`, body, host)
  if (r.netError) return err('network', r.netError)
  if (r.status !== 200) return classify(r.status, r.body)
  const data = JSON.parse(r.body)
  return { ok: true, gistId: data.id || gistId, gistUrl: data.html_url || `https://gist.github.com/${gistId}`, createdAt: data.created_at, updatedAt: data.updated_at }
}

export async function verifyToken(token: string, host: string): Promise<Result> {
  const r = await gistHttp(token, 'GET', '/user', undefined, host)
  if (r.netError) return err('network', r.netError)
  if (r.status !== 200) return classify(r.status, r.body)
  return { ok: true, message: '连接正常' }
}

/** Fetch the raw text of the backup file inside a gist. Accepts our filename,
 * dshmarket's filename, or any single file whose content looks like a backup. */
export async function readGistBackupContent(token: string, gistId: string, host: string): Promise<{ ok: true; content: string } | { ok: false; code: string; error: string }> {
  const r = await gistHttp(token, 'GET', `/gists/${gistId}`, undefined, host)
  if (r.netError) return err('network', r.netError) as { ok: false; code: string; error: string }
  if (r.status !== 200) return classify(r.status, r.body) as { ok: false; code: string; error: string }
  let data: { files?: Record<string, { content?: string }> }
  try {
    data = JSON.parse(r.body)
  } catch {
    return err('invalid_gist', 'Gist 响应不是有效 JSON') as { ok: false; code: string; error: string }
  }
  const filesObj = data.files ?? {}
  const candidate = filesObj[GIST_FILENAME]?.content
    ?? filesObj['dsh-config-backup.json']?.content
    ?? (Object.values(filesObj).find((f) => typeof f?.content === 'string' && f.content.includes('"dsh-profile-backup"'))?.content)
  if (typeof candidate !== 'string') return err('invalid_gist', 'Gist 中找不到 dsh 备份文件') as { ok: false; code: string; error: string }
  return { ok: true, content: candidate }
}
