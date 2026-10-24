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
  MAX_BACKUP_BYTES,
  MAX_BACKUP_FILES,
  PROFILE_SKIP,
  SESSION_LOCAL_DIR,
  SESSION_LOCAL_LOGS,
  SESSION_LOCAL_RECORD,
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

/**
 * Collect the profile's files, relative and '/'-separated.
 *
 * The host plugin-manager's scratch area is handled here rather than through
 * PROFILE_SKIP (which also gates what a RESTORE accepts): its install logs
 * travel only when `includePluginLogs` is on, and its run record — a pid
 * belonging to THIS machine — never travels at all.
 */
function profileFiles(root: string, dir: string, out: string[], includePluginLogs: boolean): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (PROFILE_SKIP.has(entry.name) || /\.bak\b/.test(entry.name)) continue
    const abs = resolve(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    const rel = abs.slice(root.length + 1).split(sep).join('/')
    if (rel === SESSION_LOCAL_RECORD) continue
    if (rel === SESSION_LOCAL_DIR) {
      if (entry.isDirectory() && includePluginLogs) profileFiles(root, abs, out, includePluginLogs)
      continue
    }
    if (entry.isDirectory()) profileFiles(root, abs, out, includePluginLogs)
    else if (entry.isFile()) out.push(rel)
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
  /** Bytes the plugin-manager's install logs contribute to the serialized backup. */
  pluginLogBytes: number
}

/**
 * @param options.includePluginLogs Also collect the host plugin-manager's pnpm
 * install logs (`.plugin-manager/logs`). Off by default: they are this machine's
 * install output, and a busy profile carries hundreds of KB of them.
 */
export function collectProfileBackup(options?: { includePluginLogs?: boolean }): CollectResult {
  const includePluginLogs = options?.includePluginLogs === true
  const root = resolve(profileRoot())
  const manifestFile = resolve(root, 'package.json')
  if (!existsSync(manifestFile)) throw new Error('profile package.json is missing')
  const relPaths: string[] = []
  profileFiles(root, root, relPaths, includePluginLogs)
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
  const pluginLogBytes = files.reduce((sum, f) => (f.path.startsWith(`${SESSION_LOCAL_LOGS}/`) ? sum + Buffer.byteLength(entryText(f)) : sum), 0)
  return { files, containsSecrets, strippedDeps, strippedBundles, pluginLogBytes }
}

/** The exact text a file entry becomes in the serialized backup (and on disk). */
export function entryText(file: FileEntry): string {
  if (file.json !== undefined) return JSON.stringify(file.json, null, 2) + '\n'
  return (file.lines ?? []).join('\n')
}

/**
 * The largest entries in a serialized backup, so a size error can name what to
 * drop instead of only stating the total.
 */
export function largestBackupEntries(files: FileEntry[], limit = 3): { path: string; bytes: number }[] {
  return files
    .map((file) => ({ path: file.path, bytes: Buffer.byteLength(entryText(file)) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit)
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
 * Files that decide what a restore actually installs and how the profile boots.
 * Everything else is optional config: restoring it changes no behaviour, which is
 * why the UI can list it separately instead of pushing one flat 100-line list.
 */
const PRIMARY_BACKUP_PATHS = new Set([
  'package.json',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-workspace.yaml',
])

export type BackupFileTier = 'primary' | 'secondary'

export function backupFileTier(path: string): BackupFileTier {
  return PRIMARY_BACKUP_PATHS.has(path) ? 'primary' : 'secondary'
}

export interface BackupPreviewEntry {
  path: string
  bytes: number
  tier: BackupFileTier
  /** Host install log rather than profile config — droppable via the toggle. */
  pluginLog: boolean
}

export interface BackupPreview {
  profileName: string
  fileCount: number
  /** Serialized bytes, i.e. what the Gist upload would actually weigh. */
  totalBytes: number
  includePluginLogs: boolean
  pluginLogBytes: number
  entries: BackupPreviewEntry[]
}

/**
 * What the next backup would contain, without uploading anything. Same collection
 * path as doBackup, so the sizes shown are the sizes that would be sent.
 */
export function previewProfileBackup(options?: { includePluginLogs?: boolean }): BackupPreview {
  const collected = collectProfileBackup(options)
  const entries: BackupPreviewEntry[] = collected.files.map((file) => ({
    path: file.path,
    bytes: Buffer.byteLength(entryText(file)),
    tier: backupFileTier(file.path),
    pluginLog: file.path.startsWith(`${SESSION_LOCAL_LOGS}/`),
  }))
  return {
    profileName: activeProfile(),
    fileCount: entries.length,
    totalBytes: Buffer.byteLength(serializeBackup(buildBackupEnvelope(collected.files)), 'utf8'),
    includePluginLogs: options?.includePluginLogs === true,
    pluginLogBytes: collected.pluginLogBytes,
    entries,
  }
}

/**
 * Strict structural validation aligned with dshmarket's validatedBackup:
 * - format is exactly BACKUP_FORMAT and version exactly BACKUP_VERSION
 * - files is an array of at most MAX_BACKUP_FILES entries
 * - path is non-empty, not absolute, no `..` segments, no PROFILE_SKIP segments,
 *   no duplicates
 * - package.json is REQUIRED and must be a json object; every other entry must
 *   be `lines` of strings
 * - the whole backup stays under MAX_BACKUP_BYTES
 * Returns an error message phrased as what happened / why / what to do next, or
 * null when valid.
 */
export function validateBackupStrict(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return '备份不是对象'
  const b = value as { format?: unknown; version?: unknown; files?: unknown }
  // Identity first: a backup from another tool (or another plugin version) can
  // satisfy every structural rule below while meaning something else entirely.
  if (b.format !== BACKUP_FORMAT)
    return `这不是本插件的备份：format 是 ${JSON.stringify(b.format) ?? '缺失'}，应为 "${BACKUP_FORMAT}"。请确认这个 Gist 里存的是 profile 备份。`
  if (b.version !== BACKUP_VERSION)
    return `备份版本不受支持：version 是 ${JSON.stringify(b.version) ?? '缺失'}，本版只认 ${BACKUP_VERSION}。请把插件升级到写下这份备份的版本再恢复。`
  if (!Array.isArray(b.files)) return '缺少 files 数组'
  if (b.files.length > MAX_BACKUP_FILES) return `备份文件过多（>${MAX_BACKUP_FILES}）`

  const paths = new Set<string>()
  let hasManifest = false
  for (const f of b.files) {
    if (f === null || typeof f !== 'object') return 'files 含非对象项'
    const file = f as { path?: unknown; json?: unknown; lines?: unknown }
    if (typeof file.path !== 'string' || file.path === '') return 'files 含无 path 项'
    if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) return `不安全的备份路径: ${file.path}`
    const normalized = file.path.replaceAll('\\', '/')
    if (normalized.split('/').some((part) => PROFILE_SKIP.has(part)))
      return `备份里含不该出现的路径 ${file.path}（node_modules、.dsh-market、.git、pnpm-lock.yaml 都不参与备份）。请用新版重新备份一份再恢复。`
    if (paths.has(normalized)) return `重复的备份路径: ${file.path}`
    paths.add(normalized)
    if (normalized === 'package.json') {
      hasManifest = true
      // The manifest decides what gets installed, so it must be a real object —
      // a line array would be written verbatim and produce an unparseable file.
      if (file.json === null || typeof file.json !== 'object' || Array.isArray(file.json))
        return 'package.json 必须是 json 对象（不是行数组）'
      continue
    }
    if (!Array.isArray(file.lines)) return `${file.path} 必须是行数组（只有 package.json 用 json）`
    if (!(file.lines as unknown[]).every((l) => typeof l === 'string')) return `lines 含非字符串: ${file.path}`
  }
  // Without a manifest there is nothing to merge and nothing to install from:
  // such a backup would restore stray files and change no plugin at all.
  if (!hasManifest)
    return '备份里没有 package.json —— 恢复要靠它决定装哪些插件，请用能导出清单的版本重新备份。'
  let bytes = 0
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return '备份无法序列化，内容可能损坏'
  }
  if (bytes > MAX_BACKUP_BYTES)
    return `备份过大（${(bytes / 1024 / 1024).toFixed(1)} MB，上限 ${MAX_BACKUP_BYTES / 1024 / 1024} MB）：恢复会先把它整个读进内存，超过上限一律拒绝。`
  return null
}
