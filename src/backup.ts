/**
 * Backup collection: gather the active profile's config files exactly like
 * dshmarket (single profile, paths relative to the profile root), build the
 * backup envelope, and validate it strictly (aligned with dshmarket's
 * validatedBackup).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, isAbsolute, sep } from 'node:path'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MAX_BACKUP_FILES,
  PROFILE_SKIP,
  activeProfile,
  profileRoot,
} from './config.js'

export interface FileEntry {
  path: string
  json?: unknown
  lines?: string[]
}

export interface UnportableDep {
  name: string
  spec: string
}

/**
 * Dependencies whose spec points at an absolute local path — `link:/Users/…`
 * or `file:C:\…` (aligned with dshmarket's unportableDeps, #205).
 *
 * These are perfectly valid on the machine that wrote them and meaningless
 * anywhere else, so a backup carrying one restores a manifest that `pnpm
 * install` cannot satisfy: the path does not exist on the new machine.
 *
 * Only POSIX-absolute, Windows drive-letter and UNC shapes count. Relative
 * `file:./vendor/x` specs are deliberately excluded: they resolve against the
 * profile directory, which the backup recreates, so they travel fine.
 */
export function unportableDeps(dependencies: unknown): UnportableDep[] {
  if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return []
  const found: UnportableDep[] = []
  for (const [name, raw] of Object.entries(dependencies as Record<string, unknown>)) {
    if (typeof raw !== 'string') continue
    const match = /^(?:link|file):(.+)$/i.exec(raw)
    if (match === null) continue
    let p = match[1]
    try { p = decodeURIComponent(p) } catch { /* keep the literal spec */ }
    // POSIX absolute, Windows drive-letter, or UNC — every shape that names
    // a location outside this profile.
    if (/^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)) {
      found.push({ name, spec: raw })
    }
  }
  return found
}

/**
 * Strip machine-local dependencies out of a manifest before it is backed up.
 *
 * This is the root-cause fix for cross-machine sync. `link:C:/Users/me/dev/x`
 * is a statement about ONE machine's disk layout, and a shared Gist is read by
 * every machine: leaving it in the backup makes the peer's restore inherit a
 * dependency nothing there can satisfy. The peer's only options are then to
 * fail the install or to prune the dep and drop the bundle row — a local
 * limitation rewritten into shared state, which the next backup carries back.
 *
 * Removing it HERE keeps the Gist a description of the portable composition.
 * The machine that owns the path is not harmed: restore merges manifests as a
 * union (deps overlay, bundles union), so a peer's backup can never take away
 * a dependency the local profile still declares.
 *
 * The bundle rows naming a stripped dep go with it — a row whose package can
 * never be installed fails the boot, which is the failure the pre-check exists
 * to prevent. Stripping both here means the peer never has to clean up after us.
 *
 * @returns the sanitized manifest plus what was removed, for reporting.
 */
export function stripMachineLocalDeps(manifest: unknown): {
  json: Record<string, unknown>
  strippedDeps: UnportableDep[]
  strippedBundles: string[]
} {
  const json = (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
    ? manifest
    : {}) as Record<string, unknown>
  const strippedDeps = unportableDeps(json.dependencies)
  if (strippedDeps.length === 0) return { json, strippedDeps, strippedBundles: [] }

  const drop = new Set(strippedDeps.map((d) => d.name))
  const dependencies: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(json.dependencies as Record<string, unknown>)) {
    if (!drop.has(name)) dependencies[name] = spec
  }

  const dsh = (json.dsh !== null && typeof json.dsh === 'object' && !Array.isArray(json.dsh)
    ? json.dsh
    : {}) as Record<string, unknown>
  const profile = (dsh.profile !== null && typeof dsh.profile === 'object' && !Array.isArray(dsh.profile)
    ? dsh.profile
    : {}) as Record<string, unknown>
  const declared = Array.isArray(profile.bundles) ? profile.bundles : []
  const strippedBundles = declared.filter((n): n is string => typeof n === 'string' && drop.has(n))

  return {
    json: {
      ...json,
      dependencies,
      dsh: { ...dsh, profile: { ...profile, bundles: declared.filter((n) => typeof n !== 'string' || !drop.has(n)) } },
    },
    strippedDeps,
    strippedBundles,
  }
}

export interface ParsedBackup {
  format: string
  version: number
  createdAt?: string
  profile?: string
  files: FileEntry[]
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

export interface CollectResult {
  files: FileEntry[]
  containsSecrets: boolean
  /** Machine-local deps stripped from the backed-up manifest, for reporting. */
  strippedDeps: UnportableDep[]
  /** Bundle rows dropped with them (a row with no installable package). */
  strippedBundles: string[]
}

export function collectProfileBackup(includeLock: boolean): CollectResult {
  const root = resolve(profileRoot())
  const manifestFile = resolve(root, 'package.json')
  if (!existsSync(manifestFile)) throw new Error('profile package.json is missing')
  const relPaths: string[] = []
  profileFiles(root, root, relPaths)
  if (includeLock && existsSync(resolve(root, 'pnpm-lock.yaml'))) relPaths.push('pnpm-lock.yaml')
  let strippedDeps: UnportableDep[] = []
  let strippedBundles: string[] = []
  const files: FileEntry[] = relPaths.sort().map((path) => {
    const content = readFileSync(resolve(root, path), 'utf8')
    if (path !== 'package.json') return { path, lines: content.split(/\r?\n/) }
    // Strip machine-local deps BEFORE the manifest is serialized: the backup
    // describes the portable composition, not this machine's disk layout.
    const stripped = stripMachineLocalDeps(JSON.parse(content))
    strippedDeps = stripped.strippedDeps
    strippedBundles = stripped.strippedBundles
    return { path, json: stripped.json }
  })
  if (!files.some((f) => f.path === 'package.json')) throw new Error('profile package.json is missing')
  const containsSecrets = files.some((f) => /\.credentials|\.env|secrets?/i.test(f.path))
  return { files, containsSecrets, strippedDeps, strippedBundles }
}

/** Serialize the backup with 2-space indent so it reads well on the Gist web UI. */
export function serializeBackup(backup: unknown): string {
  return JSON.stringify(backup, null, 2)
}

export function buildBackupEnvelope(files: FileEntry[]): ParsedBackup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    profile: activeProfile(),
    files,
  }
}

/**
 * Strict structural validation aligned with dshmarket's validatedBackup:
 * - format is a string, files is an array
 * - path is non-empty, not absolute, no `..` segments
 * - no SKIP_NAMES segments, no duplicate paths
 * - package.json (if present as json) must be a plain object; lines must be strings
 * Returns an error message, or null when valid.
 */
export function validateBackupStrict(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return '备份不是对象'
  const b = value as { format?: unknown; version?: unknown; files?: unknown }
  if (typeof b.format !== 'string' || b.format === '') return '缺少 format 字段'
  if (!Array.isArray(b.files)) return '缺少 files 数组'
  if (b.files.length > MAX_BACKUP_FILES) return `备份文件过多（>${MAX_BACKUP_FILES}）`

  const paths = new Set<string>()
  for (const f of b.files) {
    if (f === null || typeof f !== 'object') return 'files 含非对象项'
    const file = f as { path?: unknown; json?: unknown; lines?: unknown }
    if (typeof file.path !== 'string' || file.path === '') return 'files 含无 path 项'
    if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) return `不安全的备份路径: ${file.path}`
    const normalized = file.path.replaceAll('\\', '/')
    if (normalized.split('/').some((part) => PROFILE_SKIP.has(part))) return `含被排除的路径: ${file.path}`
    if (paths.has(normalized)) return `重复的备份路径: ${file.path}`
    paths.add(normalized)
    const hasJson = file.json !== undefined
    const hasLines = Array.isArray(file.lines)
    if (!hasJson && !hasLines) return `文件既无 json 也无 lines: ${file.path}`
    if (file.path === 'package.json' && hasJson) {
      if (file.json === null || typeof file.json !== 'object' || Array.isArray(file.json)) return 'package.json 的 json 不是对象'
    }
    if (hasLines && !(file.lines as unknown[]).every((l) => typeof l === 'string')) return `lines 含非字符串: ${file.path}`
  }
  return null
}
