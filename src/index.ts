import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { request as httpsRequest } from 'node:https'
import z from '@deepseek-ai/schemastery'

/**
 * dsh-market-gist-autosync — 把 DSH 配置定时备份到 GitHub Gist。
 *
 * Host half only for the first minimal version: gist token / gist id 配置、
 * 配置备份（带错误分类）、自持定时备份，全部在一个插件里完成。
 * Client 设置页在后续版本补上；当前通过 RPC + 一个模型工具暴露能力。
 */

const name = 'dsh-market-gist-autosync'

const inject = ['webServer']

const Config = z.object({
  scheduleIntervalHours: z.number().step(1).min(1).max(24 * 30).default(24),
  gistApiHost: z.string().default('api.github.com'),
})

const CONFIG_DIR = 'gist-autosync'
const CONFIG_FILE = 'config.json'
const GIST_FILENAME = 'dsh-config-backup.json'
const GIST_MAX_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const GIST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED',
])

interface GistBackupConfig {
  gistToken: string
  gistId: string
  fileNamePrefix: string
  fileName: string
  deviceName: string
  scheduleEnabled: boolean
  scheduleIntervalHours: number
}

const DEFAULTS: GistBackupConfig = {
  gistToken: '',
  gistId: '',
  fileNamePrefix: 'config',
  fileName: '',
  deviceName: '',
  scheduleEnabled: false,
  scheduleIntervalHours: 24,
}

type Result = { ok: true; [k: string]: unknown } | { ok: false; code: string; error: string }

function err(code: string, error: string): Result {
  return { ok: false, code, error }
}

function dshHome(): string {
  return process.env.DSH_HOME || homedir()
}

function configDirPath(): string {
  return join(dshHome(), CONFIG_DIR)
}

function configFilePath(): string {
  return join(configDirPath(), CONFIG_FILE)
}

function readBackupConfig(): GistBackupConfig {
  try {
    const text = readFileSync(configFilePath(), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      return { ...DEFAULTS, ...parsed }
    }
  } catch {
    // no config yet — defaults
  }
  return { ...DEFAULTS }
}

function writeBackupConfig(cfg: GistBackupConfig): void {
  mkdirSync(configDirPath(), { recursive: true })
  writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2), 'utf8')
}

function sanitizeName(s: string): string {
  const c = String(s || '').replace(/[^A-Za-z0-9._-]/g, '_')
  return c === '' ? 'config' : c
}

function nowTimestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function deviceName(): string {
  return process.env.COMPUTERNAME || process.env.HOSTNAME || hostname()
}

function fileNameOf(cfg: GistBackupConfig): string {
  if (cfg.fileName && cfg.fileName.trim() !== '') {
    return sanitizeName(cfg.fileName.trim()) + '.json'
  }
  const pre = sanitizeName(cfg.fileNamePrefix || 'config')
  const dev = sanitizeName(cfg.deviceName || deviceName())
  const t = nowTimestamp()
  return dev ? `${pre}-${t}-${dev}.json` : `${pre}-${t}.json`
}

function parseGistId(input: string): string {
  const trimmed = String(input || '').trim()
  if (trimmed === '') return ''
  let candidate = trimmed
  try {
    const u = new URL(trimmed)
    if (u.protocol === 'https:' && (u.hostname === 'gist.github.com' || u.hostname.endsWith('.gist.github.com'))) {
      const parts = u.pathname.split('/').filter(Boolean)
      // A gist URL is gist.github.com/<user>/<id>; a single path segment is the
      // user's gist home page, not a gist — reject it explicitly instead of
      // mistaking the username for an id (which would 404 as invalid_gist).
      if (parts.length < 2) throw new Error('gist url 缺少 gist id（这是 gist 主页，不是某个具体 gist；留空则每次自动新建）')
      candidate = parts[parts.length - 1] || ''
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('gist url')) throw e
    // not a URL — treat as a bare id below
  }
  if (!GIST_ID_RE.test(candidate)) throw new Error('invalid gist id/url')
  return candidate
}

interface GistHttpResult {
  status: number
  body: string
  netError?: string
}

function gistHttp(token: string, method: string, path: string, body?: string, host = 'api.github.com'): Promise<GistHttpResult> {
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

function classify(status: number, body: string): Result {
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

async function createGist(token: string, content: string, host: string): Promise<Result> {
  const body = JSON.stringify({
    description: 'dsh config backup',
    public: false,
    files: { [GIST_FILENAME]: { content } },
  })
  const r = await gistHttp(token, 'POST', '/gists', body, host)
  if (r.netError) return err('network', r.netError)
  if (r.status !== 201) return classify(r.status, r.body)
  const data = JSON.parse(r.body)
  return { ok: true, gistId: data.id, gistUrl: data.html_url || `https://gist.github.com/${data.id}` }
}

async function updateGist(token: string, gistId: string, content: string, host: string): Promise<Result> {
  const body = JSON.stringify({
    files: { [GIST_FILENAME]: { content } },
  })
  const r = await gistHttp(token, 'PATCH', `/gists/${gistId}`, body, host)
  if (r.netError) return err('network', r.netError)
  if (r.status !== 200) return classify(r.status, r.body)
  const data = JSON.parse(r.body)
  return { ok: true, gistId: data.id || gistId, gistUrl: data.html_url || `https://gist.github.com/${gistId}` }
}

async function verifyToken(token: string, host: string): Promise<Result> {
  const r = await gistHttp(token, 'GET', '/user', undefined, host)
  if (r.netError) return err('network', r.netError)
  if (r.status !== 200) return classify(r.status, r.body)
  return { ok: true, message: '连接正常' }
}

const SKIP_NAMES = new Set(['node_modules', '.git', 'sessions'])
const SECRET_HINT = /\.credentials|\.env|secrets?/i

function isConfigFile(n: string): boolean {
  return (
    n === 'settings.yaml' ||
    n === 'dream-skin.json' ||
    n === 'dsh-skill-hub.json' ||
    n === 'thinking-effort-loaded.json' ||
    n === '.anonymous-user-id' ||
    n.endsWith('.json') ||
    n.endsWith('.yaml') ||
    n.endsWith('.yml') ||
    n.endsWith('.toml')
  )
}

interface FileEntry {
  path: string
  content: string
}

function collectFiles(root: string): { files: FileEntry[]; containsSecrets: boolean } {
  const files: FileEntry[] = []
  let containsSecrets = false
  const rootEntries = readdirSync(root, { withFileTypes: true })

  for (const e of rootEntries) {
    if (!e.isFile() || !isConfigFile(e.name)) continue
    try {
      const content = readFileSync(join(root, e.name), 'utf8')
      files.push({ path: e.name, content })
      if (SECRET_HINT.test(e.name)) containsSecrets = true
    } catch {
      // skip unreadable
    }
  }

  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 4) return
    let kids
    try {
      kids = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const k of kids) {
      if (SKIP_NAMES.has(k.name)) continue
      const rel = prefix ? `${prefix}/${k.name}` : k.name
      if (k.isDirectory()) walk(join(dir, k.name), rel, depth + 1)
      else if (k.isFile()) {
        if (files.length > 250) return
        try {
          files.push({ path: rel, content: readFileSync(join(dir, k.name), 'utf8') })
          if (SECRET_HINT.test(rel)) containsSecrets = true
        } catch {
          // skip
        }
      }
    }
  }

  for (const dirname of ['profiles', 'skills', '.agent-presets']) {
    const d = join(root, dirname)
    if (existsSync(d)) walk(d, dirname, 0)
  }

  return { files, containsSecrets }
}

async function doTest(cfg: GistBackupConfig, host: string): Promise<Result> {
  if (!cfg.gistToken.trim()) return err('no_token', '未配置 Gist token')
  const token = cfg.gistToken.trim()
  const r = await verifyToken(token, host)
  if (!r.ok) return r
  if (cfg.gistId.trim() !== '') {
    let gid: string
    try {
      gid = parseGistId(cfg.gistId)
    } catch (e) {
      return err('invalid_gist', e instanceof Error ? e.message : String(e))
    }
    const get = await gistHttp(token, 'GET', `/gists/${gid}`, undefined, host)
    if (get.netError) return err('network', get.netError)
    if (get.status !== 200) return classify(get.status, get.body)
  }
  return { ok: true, message: '连接正常' }
}

async function doBackup(cfg: GistBackupConfig, host: string): Promise<Result> {
  if (!cfg.gistToken.trim()) return err('no_token', '未配置 Gist token')
  let gid: string
  try {
    gid = parseGistId(cfg.gistId)
  } catch (e) {
    return err('invalid_gist', e instanceof Error ? e.message : String(e))
  }
  const token = cfg.gistToken.trim()
  const { files, containsSecrets } = collectFiles(dshHome())
  const envelope = {
    format: 'dsh-config-gist-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    fileName: fileNameOf(cfg),
    files,
  }
  const content = JSON.stringify(envelope)
  if (Buffer.byteLength(content) > GIST_MAX_BYTES) {
    return err('too_large', '备份超过 GitHub Gist 1MB 限制')
  }
  const ref = gid === '' ? await createGist(token, content, host) : await updateGist(token, gid, content, host)
  if (!ref.ok) return ref
  return { ...ref, fileName: fileNameOf(cfg), at: new Date().toISOString(), containsSecrets }
}

function sendJson(response: { writeHead: (s: number, h: Record<string, string>) => void; end: (b?: string) => void }, status: number, value: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

function sameOrigin(request: { headers?: Record<string, string | string[] | undefined> }): boolean {
  // Minimal loopback guard, matching dshmarket's posture. The webServer sits
  // on loopback; treat requests without a disallowed Origin as same-origin.
  const origin = request.headers?.['origin'] ?? request.headers?.['Origin']
  if (origin === undefined) return true
  const value = Array.isArray(origin) ? origin[0] : origin
  if (value === '') return true
  try {
    const u = new URL(value)
    return ['localhost', '127.0.0.1', '::1'].includes(u.hostname) || u.hostname.startsWith('127.')
  } catch {
    return false
  }
}

async function readJsonBody(request: { on: (ev: string, cb: (c: Buffer) => void) => void }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (c: Buffer) => chunks.push(c))
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
  })
}

async function apply(ctx: any, rawConfig: any) {
  const apiHost: string = rawConfig?.gistApiHost ?? 'api.github.com'

  let interval: NodeJS.Timeout | undefined

  const schedule = (cfg: GistBackupConfig) => {
    if (interval) {
      clearInterval(interval)
      interval = undefined
    }
    if (cfg.scheduleEnabled) {
      const hours = Math.max(1, cfg.scheduleIntervalHours || 24)
      interval = setInterval(() => {
        doBackup(cfg, apiHost)
          .then((r) => {
            if (!r.ok) console.error(`[gist-autosync] scheduled backup failed: ${r.error}`)
          })
          .catch((e) => console.error(`[gist-autosync] scheduled backup error: ${e instanceof Error ? e.message : String(e)}`))
      }, hours * 60 * 60 * 1000)
      // do not keep the process alive solely for the timer
      interval.unref?.()
    }
  }

  ctx.effect(() => {
    const stop = () => {
      if (interval) {
        clearInterval(interval)
        interval = undefined
      }
    }
    // initial schedule from persisted config
    schedule(readBackupConfig())
    return stop
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-market-gist-autosync/rpc',
    handler: async (request: any, response: any) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin' })
      try {
        const body = await readJsonBody(request)
        const action = body.action
        if (action === 'getConfig') {
          sendJson(response, 200, { ok: true, config: readBackupConfig(), deviceNameDetected: deviceName() })
        } else if (action === 'saveConfig') {
          const cfg = { ...DEFAULTS, ...(body.config as Partial<GistBackupConfig> || {}) }
          cfg.scheduleEnabled = Boolean(cfg.scheduleEnabled)
          cfg.scheduleIntervalHours = Math.max(1, Number(cfg.scheduleIntervalHours) || 24)
          writeBackupConfig(cfg)
          schedule(cfg)
          sendJson(response, 200, { ok: true, config: cfg })
        } else if (action === 'testConnection') {
          sendJson(response, 200, await doTest(readBackupConfig(), apiHost))
        } else if (action === 'backupNow') {
          sendJson(response, 200, await doBackup(readBackupConfig(), apiHost))
        } else {
          sendJson(response, 400, { ok: false, code: 'invalid_action', error: 'invalid action' })
        }
      } catch (e) {
        sendJson(response, 400, { ok: false, code: 'other', error: e instanceof Error ? e.message : String(e) })
      }
    },
  })
  // Note: no model tool here. Registering a tool requires the @deepseek-ai/dsh-tools
  // defineTool contract (output { schema, render }) which is easy to get wrong and
  // will abort host boot; the core capability is fully covered by the RPC endpoint
  // above plus self-scheduling. A tool can be added later once the host half is stable.
}

export { name, inject, Config, apply }
