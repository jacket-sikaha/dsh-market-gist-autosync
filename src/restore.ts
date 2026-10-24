/**
 * Restore: write a backup back into the active profile, merging package.json
 * (union bundles, overlay deps) so existing plugins survive. Atomic per-file
 * writes with a rollback handle the caller can invoke if the post-restore
 * dependency install fails entirely (mirrors dshmarket's restored.rollback()).
 */
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { resolve, dirname, sep, relative, isAbsolute } from 'node:path'
import { entryText, type FileEntry, type ParsedBackup } from './backup.js'
import { SESSION_LOCAL_RECORD } from './config.js'

/**
 * The text a file entry becomes on disk. Defined in backup.ts so the size
 * accounting there and the bytes written here can never drift apart.
 */
export function entryContent(file: FileEntry): string {
  return entryText(file)
}

/** Merge backup manifest into current: union bundles, overlay deps (current kept, backup wins conflicts). */
export function mergeManifests(backupJson: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
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

/**
 * Dependencies whose spec points at an absolute local path (link:C:/Users/...
 * or file:/home/...) — aligned with dshmarket's unportableDeps (#205).
 *
 * Defined in backup.ts and re-exported here, because the two halves of the
 * cross-machine story must agree on exactly which specs count: the backup half
 * strips them before upload, and the restore half reports any that arrived in a
 * backup written before stripping existed (or by another tool).
 */
export { unportableDeps, type UnportableDep } from './backup.js'

export interface RestoreResult {
  ok: boolean
  restored?: number
  mergedManifest?: boolean
  error?: string
  /** Roll back every file written by this restore (call on install failure). */
  rollback?: () => void
  /** Backup paths deliberately not written (session-local records). */
  skipped?: string[]
}

/**
 * Resolve a path the way the filesystem actually routes writes.
 *
 * `realpathSync` (the JavaScript implementation) does NOT resolve Windows
 * junctions; `realpathSync.native` does. A junction is exactly the case where
 * lstat misleads us, so the native resolution is the one that matters here.
 */
function realPath(p: string): string {
  const native = realpathSync.native as typeof realpathSync | undefined
  return typeof native === 'function' ? native(p) : realpathSync(p)
}

/**
 * Create the parent directories of a restore target one segment at a time,
 * refusing anything that is not a plain directory (aligned with dshmarket's
 * `ensureSafeParent`).
 *
 * `mkdirSync(dir, { recursive: true })` follows symlinks, and that is the one
 * escape the per-path `startsWith(root)` check cannot see: the backup only names
 * a relative path (`dsh/plugins/x.json`), while the escape happens on the disk
 * side — if `dsh` already exists as a link to somewhere else, a recursive mkdir
 * walks through it and the file lands outside the profile.
 */
function ensureSafeParent(root: string, parent: string, filePath: string): void {
  const rel = relative(root, parent)
  if (rel === '' || rel === '.') return
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`不安全的备份路径: ${filePath}`)
  let realRoot: string
  try {
    realRoot = realPath(root)
  } catch {
    realRoot = root
  }
  let current = root
  for (const part of rel.split(sep)) {
    if (part === '' || part === '.') continue
    current = resolve(current, part)
    let stat
    try {
      stat = lstatSync(current)
    } catch {
      // Missing — create exactly this level, so the next segment is checked too.
      mkdirSync(current)
      continue
    }
    if (stat.isSymbolicLink()) throw new Error(`恢复目标的上层是符号链接，拒绝穿过它写入: ${filePath}`)
    if (!stat.isDirectory()) throw new Error(`恢复目标的上层不是目录: ${filePath}`)
    // lstat does NOT report every redirecting filesystem object as a symlink:
    // Windows junctions and directory mounts come back as plain directories, yet
    // writes go through them. Only the real path proves where the bytes land.
    let real: string
    try {
      real = realPath(current)
    } catch {
      throw new Error(`恢复目标的上层无法解析: ${filePath}`)
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error(`恢复目标的上层指向 profile 之外（符号链接或联接点），拒绝写入: ${filePath}`)
    }
  }
}

export function restoreBackup(root: string, backup: ParsedBackup): RestoreResult {
  const previous = new Map<string, Buffer | null>()
  let rolledBack = false
  const rollback = () => {
    if (rolledBack) return
    rolledBack = true
    for (const [target, content] of previous) {
      try {
        if (content === null) rmSync(target, { force: true })
        else writeFileSync(target, content)
      } catch { /* best effort */ }
    }
  }
  let mergedManifest = false
  const skipped: string[] = []
  const resolvedRoot = resolve(root)
  try {
    // The profile may not exist yet (fresh install, restoring into a new
    // profile); create it here so every path below resolves under a root that
    // provably exists as a real directory.
    mkdirSync(resolvedRoot, { recursive: true })
    for (const file of backup.files) {
      // The plugin-manager's run record names a pid on the machine that WROTE
      // the backup. Writing it here would make this profile's next plugin
      // install refuse with "process N is still running in this profile", so it
      // is dropped on arrival — the one path a restore never writes, whatever
      // the backup contains.
      const normalizedPath = file.path.split('\\').join('/')
      if (normalizedPath === SESSION_LOCAL_RECORD) {
        skipped.push(normalizedPath)
        continue
      }
      const target = resolve(resolvedRoot, file.path)
      if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
        throw new Error(`不安全的备份路径: ${file.path}`)
      }
      if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`目标不是普通文件: ${file.path}`)
      ensureSafeParent(resolvedRoot, dirname(target), file.path)
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
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, restored: previous.size, mergedManifest, rollback, skipped }
}
