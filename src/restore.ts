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
  renameSync,
  rmSync,
} from 'node:fs'
import { resolve, dirname, sep } from 'node:path'
import type { FileEntry, ParsedBackup } from './backup.js'

export function entryContent(file: FileEntry): string {
  if (file.json !== undefined) return JSON.stringify(file.json, null, 2) + "\n"
  return (file.lines ?? []).join("\n")
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
 * Valid on the machine that wrote them, meaningless anywhere else: the path
 * does not exist on the target, so pnpm install cannot satisfy it and the
 * whole restore can fail on it. Reported, NOT rewritten: deciding where
 * those files should live is a design question the operator must answer,
 * not the restore. Relative file:./vendor/x specs are left alone because they
 * resolve against the profile directory, which the restore recreates.
 */
export interface UnportableDep {
  name: string
  spec: string
}

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

export interface RestoreResult {
  ok: boolean
  restored?: number
  mergedManifest?: boolean
  error?: string
  /** Roll back every file written by this restore (call on install failure). */
  rollback?: () => void
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
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, restored: backup.files.length, mergedManifest, rollback }
}
