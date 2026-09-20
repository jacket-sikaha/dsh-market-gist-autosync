/**
 * dsh-market-gist-autosync — 把当前 DSH profile 的配置定时备份到 GitHub Gist。
 *
 * Host 半（Cordis 插件）：
 * - 备份格式完全对齐 dshmarket 的 `dsh-profile-backup` v0.2 —— 导出的 gist 可被
 *   dshmarket 的恢复功能直接读取，恢复路径也兼容 dshmarket 产出的备份。
 * - 上传内容用 2 空格缩进美化，GitHub 网页上可读。
 * - 新建 gist 成功后把 gistId 写回本地配置，省去手动查找。
 * - 自持定时（分钟粒度），通过 ctx.effect 注册、随 fiber 回收。
 * - 通过 ctx.webServer.register 暴露 RPC：getConfig / saveConfig / testConnection
 *   / backupNow / restore / listUploads。Client 设置页走这条 RPC。
 */
import { homedir, hostname } from 'node:os'
import { join, dirname, resolve, isAbsolute, sep } from 'node:path'
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  statSync,
  lstatSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { request as httpsRequest } from 'node:https'
import z from '@deepseek-ai/schemastery'

const name = 'dsh-market-gist-autosync'

const inject = ['webServer']

const Config = z.object({
  gistApiHost: z.string().default('api.github.com'),
})

const CONFIG_DIR = 'gist-autosync'
const CONFIG_FILE = 'config.json'
const GIST_FILENAME = 'dsh-profile-backup.json'
const GIST_MAX_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const GIST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const GIST_TOKEN_ENV = 'DSH_GITHUB_TOKEN'

/** dshmarket backup format constants — kept identical so backups interoperate. */
const BACKUP_FORMAT = 'dsh-profile-backup'
const BACKUP_VERSION = 0.2
const MAX_BACKUP_FILES = 256
const PROFILE_SKIP = new Set(['node_modules', '.dsh-market', '.git'])
const MAX_UPLOAD_RECORDS = 20

/** The active profile this backup covers (matches the desktop profile dir). */
function activeProfile(): string {
  return process.env.DSH_PROFILE || 'desktop'
}

interface UploadRecord {
  gistId: string
  gistUrl: string
  bytes: number
  createdAt: string
  updatedAt: string
}

interface GistBackupConfig {
  gistToken: string
  gistId: string
  deviceName: string
  scheduleEnabled: boolean
  /** Schedule interval magnitude + unit (minute-granularity). */
  scheduleIntervalValue: number
  scheduleIntervalUnit: 'minute' | 'hour'
  /** Optional extras to fold into the backup beyond the dshmarket core set. */
  includeLock: boolean
  uploads: UploadRecord[]
}

const DEFAULTS: GistBackupConfig = {
  gistToken: '',
  gistId: '',
  deviceName: '',
  scheduleEnabled: false,
  scheduleIntervalValue: 24,
  scheduleIntervalUnit: 'hour',
  includeLock: false,
  uploads: [],
}

type Result = { ok: true; [k: string]: unknown } | { ok: false; code: string; error: string }

function err(code: string, error: string): Result {
  return { ok: false, code, error }
}

function dshHome(): string {
  return process.env.DSH_HOME || homedir()
}

function profileRoot(): string {
  return join(dshHome(), 'profiles', activeProfile())
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
      const cfg = { ...DEFAULTS, ...parsed } as GistBackupConfig
      if (!Array.isArray(cfg.uploads)) cfg.uploads = []
      return cfg
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

function deviceName(): string {
  return process.env.COMPUTERNAME || process.env.HOSTNAME || hostname()
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

async function updateGist(token: string, gistId: string, content: string, host: string): Promise<Result> {
  const body = JSON.stringify({
    files: { [GIST_FILENAME]: { content } },
  })
  const r = await gistHttp(token, 'PATCH', `/gists/${gistId}`, body, host)
  if (r.netError) return err('network', r.netError)
  if (r.status !== 200) return classify(r.status, r.body)
  const data = JSON.parse(r.body)
  return { ok: true, gistId: data.id || gistId, gistUrl: data.html_url || `https://gist.github.com/${gistId}`, createdAt: data.created_at, updatedAt: data.updated_at }
}

async function verifyToken(token: string, host: string): Promise<Result> {
  const r = await gistHttp(token, 'GET', '/user', undefined, host)
  if (r.netError) return err('network', r.netError)
  if (r.status !== 200) return classify(r.status, r.body)
  return { ok: true, message: '连接正常' }
}

/** Resolve the Gist token, env first (DSH_GITHUB_TOKEN), config value as fallback. */
function resolveToken(cfg: GistBackupConfig): { token: string; source: 'env' | 'config' } | null {
  const env = process.env[GIST_TOKEN_ENV]
  if (typeof env === 'string' && env.trim() !== '') return { token: env.trim(), source: 'env' }
  const saved = cfg.gistToken.trim()
  if (saved !== '') return { token: saved, source: 'config' }
  return null
}

// ---------------------------------------------------------------------------
// Backup: collect the active profile exactly like dshmarket (single profile,
// paths relative to the profile root), so the resulting gist is restorable by
// dshmarket's own restore. package.json is stored as parsed json; other files
// as line arrays.
// ---------------------------------------------------------------------------

interface FileEntry {
  path: string
  json?: unknown
  lines?: string[]
}

function profileFiles(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (PROFILE_SKIP.has(entry.name) || /\.bak\b/.test(entry.name)) continue
    if (entry.name === 'pnpm-lock.yaml') continue
    const abs = resolve(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) profileFiles(root, abs, out)
    else if (entry.isFile()) out.push(resolve(abs).slice(root.length + 1).split(sep).join('/'))
    if (out.length > MAX_BACKUP_FILES) throw new Error(`profile has more than ${MAX_BACKUP_FILES} configuration files`)
  }
}

function collectProfileBackup(includeLock: boolean): { files: FileEntry[]; containsSecrets: boolean } {
  const root = resolve(profileRoot())
  const manifestFile = resolve(root, 'package.json')
  if (!existsSync(manifestFile)) throw new Error('profile package.json is missing')
  const relPaths: string[] = []
  profileFiles(root, root, relPaths)
  if (includeLock && existsSync(resolve(root, 'pnpm-lock.yaml'))) relPaths.push('pnpm-lock.yaml')
  const files: FileEntry[] = relPaths.sort().map((path) => {
    const content = readFileSync(resolve(root, path), 'utf8')
    return path === 'package.json' ? { path, json: JSON.parse(content) } : { path, lines: content.split(/\r?\n/) }
  })
  if (!files.some((f) => f.path === 'package.json')) throw new Error('profile package.json is missing')
  const containsSecrets = files.some((f) => /\.credentials|\.env|secrets?/i.test(f.path))
  return { files, containsSecrets }
}

/** Serialize the backup with 2-space indent so it reads well on the Gist web UI. */
function serializeBackup(backup: unknown): string {
  return JSON.stringify(backup, null, 2)
}

async function doTest(cfg: GistBackupConfig, host: string): Promise<Result> {
  const resolved = resolveToken(cfg)
  if (!resolved) return err('no_token', '未配置 Gist token（请在下方填写，或设置环境变量 DSH_GITHUB_TOKEN）')
  const token = resolved.token
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
  return { ok: true, message: `连接正常（token 来源：${resolved.source === 'env' ? '环境变量' : '已保存配置'}）` }
}

async function doBackup(cfg: GistBackupConfig, host: string): Promise<Result> {
  const resolved = resolveToken(cfg)
  if (!resolved) return err('no_token', '未配置 Gist token（请在下方填写，或设置环境变量 DSH_GITHUB_TOKEN）')
  let gid: string
  try {
    gid = parseGistId(cfg.gistId)
  } catch (e) {
    return err('invalid_gist', e instanceof Error ? e.message : String(e))
  }
  const token = resolved.token
  let files: FileEntry[]
  let containsSecrets = false
  try {
    const collected = collectProfileBackup(cfg.includeLock)
    files = collected.files
    containsSecrets = collected.containsSecrets
  } catch (e) {
    return err('other', e instanceof Error ? e.message : String(e))
  }
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    profile: activeProfile(),
    files,
  }
  const content = serializeBackup(backup)
  const bytes = Buffer.byteLength(content)
  if (bytes > GIST_MAX_BYTES) {
    return err('too_large', `备份 ${(bytes / 1024).toFixed(0)}KB 超过 GitHub Gist 1MB 限制`)
  }
  const isNew = gid === ''
  const ref = isNew ? await createGist(token, content, host) : await updateGist(token, gid, content, host)
  if (!ref.ok) return ref
  // Persist the gist id so the user never has to look it up, and record the upload.
  const newGistId = String(ref.gistId || gid)
  const gistUrl = String(ref.gistUrl || `https://gist.github.com/${newGistId}`)
  const record: UploadRecord = {
    gistId: newGistId,
    gistUrl,
    bytes,
    createdAt: String(ref.createdAt || new Date().toISOString()),
    updatedAt: String(ref.updatedAt || new Date().toISOString()),
  }
  const next = { ...cfg, gistId: newGistId, uploads: [record, ...(cfg.uploads || [])].slice(0, MAX_UPLOAD_RECORDS) }
  writeBackupConfig(next)
  return { ok: true, gistId: newGistId, gistUrl, bytes, isNew, createdAt: record.createdAt, updatedAt: record.updatedAt, containsSecrets }
}

// ---------------------------------------------------------------------------
// Restore: read a backup (ours or dshmarket's) from a Gist and write it back
// into the active profile, merging package.json (union bundles, overlay deps)
// so existing plugins survive. Atomic per-file writes + rollback on failure.
// ---------------------------------------------------------------------------

interface ParsedBackup {
  format: string
  version: number
  files: FileEntry[]
}

async function readGistBackup(token: string, gistId: string, host: string): Promise<{ ok: true; backup: ParsedBackup } | { ok: false; code: string; error: string }> {
  const r = await gistHttp(token, 'GET', `/gists/${gistId}`, undefined, host)
  if (r.netError) return err('network', r.netError) as { ok: false; code: string; error: string }
  if (r.status !== 200) return classify(r.status, r.body) as { ok: false; code: string; error: string }
  let data: { files?: Record<string, { content?: string }> }
  try {
    data = JSON.parse(r.body)
  } catch {
    return err('invalid_gist', 'Gist 响应不是有效 JSON') as { ok: false; code: string; error: string }
  }
  // Accept our filename, dshmarket's filename, or the gist's single json file.
  const filesObj = data.files ?? {}
  const candidate = filesObj[GIST_FILENAME]?.content
    ?? filesObj['dsh-config-backup.json']?.content
    ?? (Object.values(filesObj).find((f) => typeof f?.content === 'string' && f.content.includes('"dsh-profile-backup"'))?.content)
  if (typeof candidate !== 'string') return err('invalid_gist', 'Gist 中找不到 dsh 备份文件') as { ok: false; code: string; error: string }
  let parsed: ParsedBackup
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return err('invalid_gist', '备份文件内容不是有效 JSON') as { ok: false; code: string; error: string }
  }
  const vErr = validateBackupShape(parsed)
  if (vErr) return err('invalid_gist', vErr) as { ok: false; code: string; error: string }
  return { ok: true, backup: parsed }
}

/** Loose structural validation accepting both our and dshmarket's backups. */
function validateBackupShape(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return '备份不是对象'
  const b = value as { format?: unknown; files?: unknown }
  if (typeof b.format !== 'string') return '缺少 format 字段'
  if (!Array.isArray(b.files)) return '缺少 files 数组'
  for (const f of b.files) {
    if (f === null || typeof f !== 'object') return 'files 含非对象项'
    const file = f as { path?: unknown; json?: unknown; lines?: unknown }
    if (typeof file.path !== 'string' || file.path === '') return 'files 含无 path 项'
    if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) return `不安全的备份路径: ${file.path}`
    const hasJson = file.json !== undefined
    const hasLines = Array.isArray(file.lines)
    if (!hasJson && !hasLines) return `文件既无 json 也无 lines: ${file.path}`
  }
  return null
}

function entryContent(file: FileEntry): string {
  if (file.json !== undefined) return JSON.stringify(file.json, null, 2) + '\n'
  return (file.lines ?? []).join('\n')
}

/** Merge backup manifest into current: union bundles, overlay deps (current kept, backup wins conflicts). */
function mergeManifests(backupJson: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const asObj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
  const backupDeps = asObj(backupJson.dependencies)
  const currentDeps = asObj(current.dependencies)
  const deps = { ...currentDeps }
  for (const [k, spec] of Object.entries(backupDeps)) {
    if (typeof spec === 'string') deps[k] = spec
  }
  const backupBundles = asObj(asObj(backupJson.dsh).profile).bundles
  const currentBundles = asObj(asObj(current.dsh).profile).bundles
  const bundleSet = new Set<string>()
  for (const b of Array.isArray(currentBundles) ? currentBundles : []) if (typeof b === 'string') bundleSet.add(b)
  for (const b of Array.isArray(backupBundles) ? backupBundles : []) if (typeof b === 'string') bundleSet.add(b)
  const merged: Record<string, unknown> = { ...backupJson, ...current, dependencies: deps }
  const curDsh = asObj(current.dsh)
  const curProfile = asObj(curDsh.profile)
  merged.dsh = { ...asObj(backupJson.dsh), ...curDsh, profile: { ...asObj(asObj(backupJson.dsh).profile), ...curProfile, bundles: [...bundleSet] } }
  return merged
}

function restoreBackup(root: string, backup: ParsedBackup): { ok: true; restored: number; mergedManifest: boolean } | { ok: false; code: string; error: string } {
  const previous = new Map<string, Buffer | null>()
  const rollback = () => {
    for (const [target, content] of previous) {
      try {
        if (content === null) rmSync(target, { force: true })
        else writeFileSync(target, content)
      } catch { /* best effort */ }
    }
  }
  let mergedManifest = false
  const resolvedRoot = resolve(root)
  try {
    for (const file of backup.files) {
      const target = resolve(resolvedRoot, file.path)
      if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
        throw new Error(`不安全的备份路径: ${file.path}`)
      }
      if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`目标不是普通文件: ${file.path}`)
      mkdirSync(dirname(target), { recursive: true })
      previous.set(target, existsSync(target) ? readFileSync(target) : null)

      let content: string
      if (file.json !== undefined && /(^|\/)package\.json$/.test(file.path) && existsSync(target)) {
        const current = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>
        content = JSON.stringify(mergeManifests(file.json as Record<string, unknown>, current), null, 2) + '\n'
        mergedManifest = true
      } else {
        content = entryContent(file)
      }
      const temp = `${target}.gist-restore-${process.pid}`
      writeFileSync(temp, content, 'utf8')
      renameSync(temp, target)
    }
  } catch (e) {
    rollback()
    return err('restore_failed', e instanceof Error ? e.message : String(e)) as { ok: false; code: string; error: string }
  }
  return { ok: true, restored: backup.files.length, mergedManifest }
}

async function doRestore(cfg: GistBackupConfig, host: string, gistInput: string): Promise<Result> {
  const resolved = resolveToken(cfg)
  if (!resolved) return err('no_token', '未配置 Gist token（请在下方填写，或设置环境变量 DSH_GITHUB_TOKEN）')
  let gid: string
  try {
    gid = parseGistId(gistInput || cfg.gistId)
  } catch (e) {
    return err('invalid_gist', e instanceof Error ? e.message : String(e))
  }
  if (gid === '') return err('invalid_gist', '请提供要恢复的 Gist id 或 URL')
  const got = await readGistBackup(resolved.token, gid, host)
  if (!got.ok) return got
  const result = restoreBackup(profileRoot(), got.backup)
  if (!result.ok) return result
  return { ok: true, restored: result.restored, mergedManifest: result.mergedManifest, message: `已恢复 ${result.restored} 个文件到 profile「${activeProfile()}」${result.mergedManifest ? '（package.json 已合并，未覆盖现有插件）' : ''}。重启 DSH 后生效。` }
}

// ---------------------------------------------------------------------------
// RPC plumbing
// ---------------------------------------------------------------------------

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
    request.on('error', reject)
  })
}

function scheduleIntervalMs(cfg: GistBackupConfig): number {
  const v = Math.max(1, Number(cfg.scheduleIntervalValue) || 24)
  return cfg.scheduleIntervalUnit === 'minute' ? v * 60 * 1000 : v * 60 * 60 * 1000
}

async function apply(ctx: any, rawConfig: any) {
  const apiHost: string = rawConfig?.gistApiHost ?? 'api.github.com'

  let interval: ReturnType<typeof setInterval> | undefined

  const schedule = (cfg: GistBackupConfig) => {
    if (interval) {
      clearInterval(interval)
      interval = undefined
    }
    if (cfg.scheduleEnabled) {
      interval = setInterval(() => {
        doBackup(readBackupConfig(), apiHost)
          .then((r) => {
            if (!r.ok) console.error(`[gist-autosync] scheduled backup failed: ${r.error}`)
          })
          .catch((e) => console.error(`[gist-autosync] scheduled backup error: ${e instanceof Error ? e.message : String(e)}`))
      }, scheduleIntervalMs(cfg))
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
          const envToken = typeof process.env[GIST_TOKEN_ENV] === 'string' && process.env[GIST_TOKEN_ENV].trim() !== ''
          sendJson(response, 200, { ok: true, config: readBackupConfig(), deviceNameDetected: deviceName(), activeProfile: activeProfile(), envTokenSet: envToken })
        } else if (action === 'saveConfig') {
          const incoming = (body.config as Partial<GistBackupConfig>) || {}
          const cfg = { ...readBackupConfig(), ...incoming }
          cfg.scheduleEnabled = Boolean(cfg.scheduleEnabled)
          cfg.scheduleIntervalValue = Math.max(1, Number(cfg.scheduleIntervalValue) || 24)
          cfg.scheduleIntervalUnit = cfg.scheduleIntervalUnit === 'minute' ? 'minute' : 'hour'
          cfg.includeLock = Boolean(cfg.includeLock)
          writeBackupConfig(cfg)
          schedule(cfg)
          sendJson(response, 200, { ok: true, config: cfg })
        } else if (action === 'testConnection') {
          sendJson(response, 200, await doTest(readBackupConfig(), apiHost))
        } else if (action === 'backupNow') {
          sendJson(response, 200, await doBackup(readBackupConfig(), apiHost))
        } else if (action === 'restore') {
          const gistInput = typeof body.gist === 'string' ? body.gist : ''
          sendJson(response, 200, await doRestore(readBackupConfig(), apiHost, gistInput))
        } else if (action === 'listUploads') {
          sendJson(response, 200, { ok: true, uploads: readBackupConfig().uploads || [] })
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
// Exported for tests: merge/restore primitives (verify merge keeps existing plugins).
export { mergeManifests, restoreBackup, validateBackupShape, collectProfileBackup, serializeBackup }
