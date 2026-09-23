/**
 * Profile boot analysis: can the boot loader actually resolve every bundle the
 * profile declares?
 *
 * Ported from dshmarket's analyzeProfile / buildBundleLayers (#339). The boot
 * loader reads dsh.profile.bundles and dies on the FIRST name it cannot
 * resolve - the whole profile, not just that plugin. A restore that leaves such
 * a name behind therefore does not fail where the user can see it: it fails at
 * the NEXT restart, as a Loader error with nothing tying it back to the restore
 * that caused it. Checking here is what lets the restore report it instead.
 *
 * Resolution mirrors the boot exactly: the dsh installation anchor first
 * (in-box bundles always come from the running dsh, never a profile-local
 * copy), then Node's own module search from the profile directory (which
 * covers community bundles and pnpm's workspace-root hoisting).
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The in-box bundles a profile template installs. They are supplied by the dsh
 * INSTALLATION, not by the profile, so failing to find one says this process
 * could not locate the installation - not that the profile is broken. Judging
 * those fatal once turned a working composition into a fatal verdict (#369),
 * so they are reported as unknown rather than missing.
 */
export const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

const DSH_PACKAGE = '@deepseek-ai/dsh'

/** The host package's own manifest, or null when this directory is not it. */
function readDshManifest(directory: string): { name: string; version?: string } | null {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (manifest === null || typeof manifest !== 'object' || manifest.name !== DSH_PACKAGE) return null
    return { name: DSH_PACKAGE, version: typeof manifest.version === 'string' ? manifest.version : undefined }
  } catch {
    return null
  }
}

/**
 * Locate the DSH host installation: walk up from the CLI entry first, then
 * inspect Electron's resources directory (Desktop may keep node_modules outside
 * the ASAR, expose them through ASAR's virtual filesystem, or disable ASAR).
 */
export function findDshInstallDir(entry: string | undefined = process.argv[1]): string | null {
  if (entry !== undefined) {
    let directory = resolve(dirname(entry))
    for (let depth = 0; depth < 10; depth += 1) {
      if (readDshManifest(directory) !== null) return directory
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  const resourcesPath = (process as unknown as { resourcesPath?: unknown }).resourcesPath
  if (typeof resourcesPath !== 'string' || resourcesPath === '') return null
  for (const applicationRoot of ['app.asar.unpacked', 'app.asar', 'app']) {
    const candidate = join(resourcesPath, applicationRoot, 'node_modules', DSH_PACKAGE)
    if (readDshManifest(candidate) !== null) return candidate
  }
  return null
}

/**
 * Resolve one package's directory the way the dsh boot does: probe Node's own
 * node_modules search paths from the anchor. Node resolution walks upward, so
 * this also finds pnpm's workspace-root hoisting
 * (profiles/node_modules when the profile lives under profiles/<name>).
 */
function resolvePackageDir(anchorPackageJson: string, name: string, ignoredPackageDirectory?: string): string | null | undefined {
  let paths: string[]
  try {
    // createRequire requires an ABSOLUTE path; a relative anchor throws. Resolve
    // first so a caller that hands us a relative directory still gets a real
    // search instead of a spurious "not installed" verdict.
    paths = createRequire(resolve(anchorPackageJson)).resolve.paths(name) ?? []
  } catch {
    // The probe itself failed (unreadable anchor). "I could not look" is NOT
    // "it is not there": conflating the two would report every bundle as
    // missing and then delete them all. Undefined carries that distinction.
    return undefined
  }
  const ignored = ignoredPackageDirectory === undefined ? null : resolve(ignoredPackageDirectory)
  for (const searchPath of paths) {
    const candidate = join(searchPath, name)
    if (ignored !== null) {
      const resolvedCandidate = resolve(candidate)
      const matchesIgnored = process.platform === 'win32'
        ? resolvedCandidate.toLowerCase() === ignored.toLowerCase()
        : resolvedCandidate === ignored
      if (matchesIgnored) continue
    }
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

export interface BundleLayer {
  name: string
  /** Resolved directory, or null when neither anchor provides it. */
  directory: string | null
  /** Why this bundle will fail to boot; null when it resolves or is unknown. */
  error: string | null
  /**
   * True when this bundle's fate is UNKNOWN rather than known-bad: an in-box
   * bundle this process could not locate (#369), or a bundle whose resolution
   * probe itself failed. Never treated as fatal — an unknown must not be
   * allowed to delete a working bundle.
   */
  unresolvedInbox: boolean
}

/** Analyze every declared bundle's resolvability, in manifest order. */
export function analyzeBundles(profileDirectory: string, dshInstallDir: string | null = findDshInstallDir()): BundleLayer[] {
  let names: string[] = []
  try {
    const manifest = JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8'))
    const declared = manifest?.dsh?.profile?.bundles
    if (Array.isArray(declared)) names = declared.filter((n: unknown): n is string => typeof n === 'string')
  } catch {
    return []
  }
  return names.map((name) => {
    // The real loader gives the dsh installation first refusal for in-box
    // bundles; a direct profile-local copy with the same official name is only
    // a stale shadow, never evidence for the layer the running host loaded.
    const ignoredProfilePackage = dshInstallDir === null && INBOX_BUNDLES.has(name)
      ? join(profileDirectory, 'node_modules', name)
      : undefined
    const anchors = [
      dshInstallDir === null ? null : join(dshInstallDir, 'package.json'),
      join(profileDirectory, 'package.json'),
    ]
    let probeFailed = false
    for (const anchor of anchors) {
      if (anchor === null) continue
      const directory = resolvePackageDir(anchor, name, ignoredProfilePackage)
      if (typeof directory === 'string') return { name, directory, error: null, unresolvedInbox: false }
      if (directory === undefined) probeFailed = true
    }
    // A failed probe is reported as unknown, never as a fatal verdict: acting
    // on it would delete a working bundle over a bug in this check.
    if (probeFailed) return { name, directory: null, error: null, unresolvedInbox: true }
    if (INBOX_BUNDLES.has(name)) return { name, directory: null, error: null, unresolvedInbox: true }
    return { name, directory: null, error: 'bundle package is not installed - the profile will fail to boot', unresolvedInbox: false }
  })
}

/**
 * Declared bundles that will not resolve at boot (#339). Bundles whose fate is
 * merely UNKNOWN are excluded, because an unknown is not evidence of a broken
 * profile:
 * - an in-box bundle this process could not locate is supplied by the dsh
 *   installation, so failing to find it is a gap in what this process sees;
 * - a bundle whose resolution probe failed (unreadable anchor) was never
 *   actually looked for.
 * Both would otherwise delete a working bundle over a limitation of the check.
 */
export function orphanBundles(profileDirectory: string, dshInstallDir: string | null = findDshInstallDir()): string[] {
  try {
    return analyzeBundles(profileDirectory, dshInstallDir)
      .filter((layer) => layer.directory === null && !layer.unresolvedInbox)
      .map((layer) => layer.name)
  } catch {
    return []
  }
}

/**
 * Drop the named bundles from the profile manifest, returning the names that
 * were actually present. Best effort: an unreadable or unwritable manifest is
 * left exactly as it was.
 *
 * Removing rather than only reporting is deliberate. The boot loader dies on
 * the first unresolvable name, so leaving one in place means the very next
 * restart lands in recovery mode - a state the user cannot climb out of from
 * inside the plugin that caused it. The plugin is unloadable either way;
 * dropping the row is what lets the rest of the profile boot.
 */
export function removeBundles(profileDirectory: string, names: string[]): string[] {
  if (names.length === 0) return []
  const manifestFile = join(profileDirectory, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return []
    const drop = new Set(names)
    const removed = bundles.filter((n: unknown): n is string => typeof n === 'string' && drop.has(n))
    if (removed.length === 0) return []
    manifest.dsh.profile.bundles = bundles.filter((n: unknown) => typeof n !== 'string' || !drop.has(n))
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    return removed
  } catch {
    return []
  }
}
