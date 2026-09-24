/**
 * Config, paths, and shared constants for the gist-autosync host plugin.
 */
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'

export const name = 'dsh-market-gist-autosync'

/**
 * Write a file atomically: stage a sibling temp file, then rename it over the
 * target.
 *
 * The rename is the only step that touches the real path, so a crash, a kill,
 * or a full disk mid-write leaves the ORIGINAL file intact rather than a
 * truncated one. That matters most for `package.json`: it is the file the boot
 * loader parses, and a half-written manifest is not a smaller profile — it is a
 * profile that cannot boot at all, with the user's plugin list lost.
 *
 * The temp name carries pid + a counter so concurrent writers (a scheduled
 * backup, a restore, an install) cannot stage over each other. It is removed on
 * failure so a rejected write leaves no debris behind.
 */
let atomicCounter = 0
export function writeFileAtomic(file: string, content: string | Buffer): void {
  const temp = `${file}.gist-tmp-${process.pid}-${(atomicCounter += 1)}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temp, content)
    renameSync(temp, file)
  } catch (e) {
    try { rmSync(temp, { force: true }) } catch { /* nothing left to clean */ }
    throw e
  }
}

export const CONFIG_DIR = 'gist-autosync'
export const CONFIG_FILE = 'config.json'
export const GIST_FILENAME = 'dsh-profile-backup.json'
export const GIST_MAX_BYTES = 1024 * 1024
export const REQUEST_TIMEOUT_MS = 30_000
export const GIST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const GIST_TOKEN_ENV = 'DSH_GITHUB_TOKEN'

/** dshmarket backup format constants — kept identical so backups interoperate. */
export const BACKUP_FORMAT = 'dsh-profile-backup'
export const BACKUP_VERSION = 0.2
export const MAX_BACKUP_FILES = 256
export const PROFILE_SKIP = new Set(['node_modules', '.dsh-market', '.git'])
export const MAX_UPLOAD_RECORDS = 20

/**
 * The profile this host process actually booted, resolved once in apply() via
 * initProfileContext() and consumed by the pure functions below.
 *
 * Detection order (mirrors dshmarket's src/index.ts):
 *   1. DSH Desktop's `desktopProfiles` service (`current.name`/`current.dir`) —
 *      authoritative on Desktop, present before Loader entries mount.
 *   2. `--profile <name>` in process.argv — how plain `dsh web` is launched.
 *   3. DSH_PROFILE env — test/escape hatch (the runtime itself never sets it).
 *   4. 'desktop' — historical default.
 */
let detectedProfile: { name: string; dir?: string } | undefined

export function initProfileContext(ctx: { get?: (key: string) => unknown }): void {
  // Re-resolve from scratch on every call: a fresh init must not inherit a
  // profile detected by an earlier one.
  detectedProfile = undefined
  const dp = ctx?.get?.('desktopProfiles') as { current?: { name?: unknown; dir?: unknown } } | undefined
  const current = dp?.current
  if (current && typeof current.name === 'string' && current.name !== '') {
    detectedProfile = {
      name: current.name,
      dir: typeof current.dir === 'string' && current.dir !== '' ? current.dir : undefined,
    }
    return
  }
  const argv = process.argv
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length) {
    const value = argv[flag + 1]
    if (!value.startsWith('-')) {
      detectedProfile = { name: value }
      return
    }
  }
  const env = process.env.DSH_PROFILE
  if (typeof env === 'string' && env.trim() !== '') detectedProfile = { name: env.trim() }
}

/** The active profile this backup covers (the profile this host booted). */
export function activeProfile(): string {
  return detectedProfile?.name ?? process.env.DSH_PROFILE ?? 'desktop'
}

export interface UploadRecord {
  gistId: string
  deviceName: string
  uploadedAt: string
  /** 'new' = created a fresh gist; 'update' = overwrote an existing one. */
  status: 'new' | 'update'
  bytes: number
  /** Legacy fields kept optional so pre-domain config.json still parses. */
  gistUrl?: string
  createdAt?: string
  updatedAt?: string
}

export interface GistBackupConfig {
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

export const DEFAULTS: GistBackupConfig = {
  gistToken: '',
  gistId: '',
  deviceName: '',
  scheduleEnabled: false,
  scheduleIntervalValue: 24,
  scheduleIntervalUnit: 'hour',
  includeLock: false,
  uploads: [],
}

export type Result = { ok: true; [k: string]: unknown } | { ok: false; code: string; error: string }

export function err(code: string, error: string): Result {
  return { ok: false, code, error }
}

export function dshHome(): string {
  return process.env.DSH_HOME || homedir()
}

export function profileRoot(): string {
  // Prefer the dir the host reported (Desktop owns the active profile location
  // and it may not sit under $DSH_HOME/profiles).
  return detectedProfile?.dir ?? join(dshHome(), 'profiles', activeProfile())
}

export function configDirPath(): string {
  return join(dshHome(), CONFIG_DIR)
}

export function configFilePath(): string {
  return join(configDirPath(), CONFIG_FILE)
}

export function readBackupConfig(): GistBackupConfig {
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

export function writeBackupConfig(cfg: GistBackupConfig): void {
  mkdirSync(configDirPath(), { recursive: true })
  writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2), 'utf8')
}

export function deviceName(): string {
  return process.env.COMPUTERNAME || process.env.HOSTNAME || hostname()
}

export function parseGistId(input: string): string {
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

/** Resolve the Gist token, env first (DSH_GITHUB_TOKEN), config value as fallback. */
export function resolveToken(cfg: GistBackupConfig): { token: string; source: 'env' | 'config' } | null {
  const env = process.env[GIST_TOKEN_ENV]
  if (typeof env === 'string' && env.trim() !== '') return { token: env.trim(), source: 'env' }
  const saved = cfg.gistToken.trim()
  if (saved !== '') return { token: saved, source: 'config' }
  return null
}

/** Schedule interval in ms (minute-granularity). */
export function scheduleIntervalMs(cfg: GistBackupConfig): number {
  const v = Math.max(1, Number(cfg.scheduleIntervalValue) || 24)
  return cfg.scheduleIntervalUnit === 'minute' ? v * 60 * 1000 : v * 60 * 60 * 1000
}
