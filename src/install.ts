/**
 * Post-restore dependency install via pnpm, with live progress reporting.
 *
 * Two distinct failure modes are handled differently:
 * - pnpm itself cannot run here (spawn EPERM / not found): we do NOT touch the
 *   manifest — pruning deps we merely failed to *probe* would wrongly uninstall
 *   plugins that are already present. Reported as installed:false instead.
 * - pnpm runs but a specific package fails to install (404 / network): only
 *   those packages are pruned, so the profile still boots without them.
 * - A link:/file: dep names a path that does not exist here (a backup from
 *   another machine, #205): pruned up front, because nothing can ever satisfy
 *   it and any bundle naming it would then be unresolvable at boot.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { writeFileAtomic } from './config.js'

export interface PnpmResult {
  exitCode: number
  stderr: string
  spawnError?: string
}

/** Per-line stderr streaming, so callers can turn pnpm's progress reporter into
 * UI counters while the install is still running. */
export interface SpawnHooks {
  /** Called once per complete stderr line, in arrival order. */
  onStderrLine?: (line: string) => void
}

/** Spawn a command. Windows `.cmd` shims (pnpm) cannot start without a shell,
 * so route through cmd.exe /d /s /c with an explicitly quoted command line. */
export function spawnCmd(file: string, args: string[], cwd: string, hooks?: SpawnHooks): Promise<PnpmResult> {
  return new Promise((resolvePromise) => {
    const quote = (a: string) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)
    const isWin = process.platform === 'win32'
    const cmd = isWin ? (process.env.ComSpec ?? 'cmd.exe') : file
    const argv = isWin ? ['/d', '/s', '/c', [file, ...args].map(quote).join(' ')] : args
    let child
    try {
      child = spawn(cmd, argv, { cwd, shell: false, windowsHide: true, env: { ...process.env, CI: 'true' } })
    } catch (e) {
      resolvePromise({ exitCode: 1, stderr: '', spawnError: e instanceof Error ? e.message : String(e) })
      return
    }
    let stderr = ''
    let pending = ''
    const feed = (chunk: string): void => {
      const onLine = hooks?.onStderrLine
      if (!onLine) return
      pending += chunk
      let breakAt = pending.indexOf('\n')
      while (breakAt >= 0) {
        const line = pending.slice(0, breakAt).replace(/\r$/, '')
        pending = pending.slice(breakAt + 1)
        if (line.trim() !== '') {
          try {
            onLine(line)
          } catch {
            // A progress parser must never take the install down with it.
          }
        }
        breakAt = pending.indexOf('\n')
      }
      // pnpm's in-place reporter can go a long time without a newline; do not
      // let that grow without bound.
      if (pending.length > 8192) pending = pending.slice(-2048)
    }
    // Which stream carries the reporter varies by pnpm version and reporter
    // choice, so parse both; only stderr is kept as the failure text.
    child.stdout?.on('data', (c: Buffer) => feed(c.toString('utf8')))
    child.stderr?.on('data', (c: Buffer) => {
      const chunk = c.toString('utf8')
      stderr += chunk
      feed(chunk)
    })
    child.on('error', (e) => resolvePromise({ exitCode: 1, stderr, spawnError: e.message }))
    child.on('close', (code) => resolvePromise({ exitCode: code ?? 1, stderr }))
  })
}

/** pnpm's `Progress:` reporter line, e.g.
 *  `Progress: resolved 390, reused 17, downloaded 0, added 1, done`. */
const PROGRESS_LINE = /resolved (\d+), reused (\d+), downloaded \d+, added (\d+)/

/** Package counts lifted out of that line. The unit is packages, NOT plugins —
 *  one plugin can pull dozens — so the UI shows them as counters instead of
 *  turning them into a percentage. */
export interface InstallCounters {
  resolved: number
  reused: number
  added: number
}

/** Last meaningful stderr lines, for showing why an install failed. */
function tailLines(stderr: string, limit = 12): string[] {
  const kept = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^Progress:/.test(line) && !/^Packages:/.test(line))
  return kept.slice(-limit)
}

/**
 * Remove one dependency — and any bundle row naming it — from the manifest.
 *
 * Written atomically: this rewrites the file the boot loader parses, so a
 * partial write would cost the user their whole plugin list, not just this
 * entry.
 *
 * @returns true when the manifest now lacks the dependency, false when the
 *          rewrite failed. The caller reports failures instead of assuming the
 *          prune happened, because "reported as pruned but still installed" and
 *          "actually pruned" look identical to the user otherwise.
 */
function pruneDependency(manifestFile: string, name: string): boolean {
  try {
    const m = JSON.parse(readFileSync(manifestFile, 'utf8'))
    if (m.dependencies) delete m.dependencies[name]
    if (Array.isArray(m.dsh?.profile?.bundles)) {
      m.dsh.profile.bundles = m.dsh.profile.bundles.filter((b: string) => b !== name)
    }
    writeFileAtomic(manifestFile, JSON.stringify(m, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

/** Progress phases reported to the caller for live UI display. */
export type InstallProgress =
  | { phase: 'probe'; missing: string[] }
  | { phase: 'install-all' }
  | { phase: 'install-count'; resolved: number; reused: number; added: number }
  | { phase: 'install-one'; name: string; index: number; total: number }
  | { phase: 'done-one'; name: string; ok: boolean }

export interface InstallOutcome {
  ok: boolean
  /** true when deps were actually installed (or already present); false when
   *  pnpm could not run and the manifest was left for manual reinstall. */
  installed: boolean
  summary: string
  /** Names newly installed this run. */
  installedNames: string[]
  /** Names that failed and were pruned from the manifest. */
  prunedNames: string[]
  /** Tail of pnpm's own output when the install failed; empty on success. */
  stderrTail?: string[]
}

export async function installRestoredDeps(
  root: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<InstallOutcome> {
  const manifestFile = join(root, 'package.json')
  let manifest: { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  } catch {
    return { ok: false, installed: false, summary: '无法读取恢复后的 package.json', installedNames: [], prunedNames: [] }
  }
  const deps = Object.entries(manifest.dependencies ?? {})
  if (deps.length === 0) return { ok: true, installed: true, summary: '无依赖需要安装', installedNames: [], prunedNames: [] }

  // Machine-local specs (link:/file:) cannot be fetched, so the question is
  // whether the path they name still exists here. A backup from another
  // machine routinely carries one that does not (#205): left in the manifest
  // it is a dependency nothing can satisfy, and any bundle naming it then
  // cannot resolve at boot. Drop exactly those — and the bundles that named
  // them — so the rest of the profile still starts.
  const deadLocal: string[] = []
  for (const [name, spec] of deps) {
    if (typeof spec !== 'string' || !/^(?:link|file):/i.test(spec)) continue
    let target = spec.replace(/^(?:link|file):/i, '')
    try { target = decodeURIComponent(target) } catch { /* keep the literal path */ }
    const absolute = isAbsolute(target) ? target : join(root, target)
    if (!existsSync(absolute)) deadLocal.push(name)
  }
  // Only names the manifest actually lost count as pruned: if the rewrite
  // failed the dependency is still declared, and claiming otherwise would tell
  // the user a plugin is gone while it sits in the file.
  const prunedDead: string[] = []
  const failedPrune: string[] = []
  for (const name of deadLocal) {
    if (pruneDependency(manifestFile, name)) prunedDead.push(name)
    else failedPrune.push(name)
  }
  if (failedPrune.length > 0) {
    // The manifest could not be rewritten, so these deps remain and the boot
    // pre-check will have to drop any bundle naming them. Stop here rather than
    // running pnpm against a manifest we know is in an unexpected state.
    return {
      ok: false,
      installed: false,
      summary: `无法改写 profile 的 package.json，${failedPrune.length} 个指向本机不存在路径的本地依赖仍留在清单里：${failedPrune.join('、')}。请检查该文件是否可写后重试。`,
      installedNames: [],
      prunedNames: [],
    }
  }

  // Which deps are actually missing from node_modules right now? Only those
  // need installing — the ones already present boot fine either way.
  const missing = Object.entries(
    (JSON.parse(readFileSync(manifestFile, 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {},
  ).filter(([name, spec]) => {
    if (typeof spec !== 'string') return false
    if (/^(?:link|file):/i.test(spec)) return false // local path that DOES exist here — pnpm links it
    return !existsSync(join(root, 'node_modules', name, 'package.json'))
  }).map(([name, spec]) => [name, spec] as [string, string])

  onProgress?.({ phase: 'probe', missing: missing.map(([n]) => n) })
  if (missing.length === 0 && prunedDead.length === 0) {
    return { ok: true, installed: true, summary: '依赖均已安装', installedNames: [], prunedNames: [] }
  }
  if (missing.length === 0) {
    return {
      ok: true,
      installed: true,
      summary: `已剔除 ${prunedDead.length} 个指向本机不存在路径的本地依赖：${prunedDead.join('、')}`,
      installedNames: [],
      prunedNames: prunedDead,
    }
  }

  // Fast path: one `pnpm install` for everything.
  // `--no-frozen-lockfile` is required, not cosmetic: `spawnCmd` sets CI=true
  // (see the env above), and in CI pnpm defaults to --frozen-lockfile. A backup
  // never carries pnpm-lock.yaml (PROFILE_SKIP drops it), so the profile's
  // existing lockfile always describes the OLD dependency set and every restore
  // would abort here with ERR_PNPM_OUTDATED_LOCKFILE before installing anything.
  // Live package counts: pnpm prints `Progress: resolved N, reused N, ...` on
  // its reporter stream while it works. Piped through at most every 200 ms —
  // and always for the final `done` line — so the RPC state does not churn.
  let lastCountEmit = 0
  const counterFeed = (line: string): void => {
    const match = PROGRESS_LINE.exec(line)
    if (!match) return
    const now = Date.now()
    if (now - lastCountEmit < 200 && !/\bdone\b/.test(line)) return
    lastCountEmit = now
    onProgress?.({
      phase: 'install-count',
      resolved: Number(match[1]),
      reused: Number(match[2]),
      added: Number(match[3]),
    })
  }

  onProgress?.({ phase: 'install-all' })
  const install = await spawnCmd(
    'pnpm',
    ['install', '--no-frozen-lockfile', '--config.auto-install-peers=false', '--reporter=append-only'],
    root,
    { onStderrLine: counterFeed },
  )
  if (install.exitCode === 0) {
    return { ok: true, installed: true, summary: `依赖安装完成（新装 ${missing.length} 个）`, installedNames: missing.map(([n]) => n), prunedNames: [] }
  }
  // pnpm could not even run (spawn EPERM / not found / no PATH): leave the
  // manifest untouched and ask the user to reinstall via the market — pruning
  // here would wrongly drop already-installed plugins.
  if (install.spawnError) {
    // deadLocal pruning already happened above, so the manifest on disk has
    // changed even though the install could not run. Say so: otherwise the user
    // is told about the deps that need reinstalling but never told that some
    // were already removed. `prunedNames` stays empty on purpose — it drives the
    // caller's all-failed rollback, and a spawn failure is not an install
    // failure, so the restored files must stand.
    const removedNote = prunedDead.length > 0
      ? `另有 ${prunedDead.length} 个指向本机不存在路径的本地依赖已从 profile 移除：${prunedDead.join('、')}。`
      : ''
    return {
      ok: true,
      installed: false,
      summary: `恢复完成，但此环境无法自动安装依赖（${install.spawnError}）。${missing.length} 个插件需在重启后于插件市场确认/重装：${missing.map(([n]) => n).join('、')}。${removedNote}`,
      installedNames: [],
      prunedNames: [],
      stderrTail: tailLines(install.stderr),
    }
  }

  // Slow path (aligns with dshmarket): one bad dep aborts the whole install, so
  // retry each missing dep individually and prune only those that truly fail.
  const failed: string[] = []
  const stuck: string[] = []
  const installedNames: string[] = []
  // Only the last failure's output is worth showing; earlier ones are drowned.
  let slowStderr = tailLines(install.stderr).join('\n')
  for (let i = 0; i < missing.length; i++) {
    const [name, spec] = missing[i]
    onProgress?.({ phase: 'install-one', name, index: i + 1, total: missing.length })
    const target = /^(?:github|git\+|https?):/.test(spec) ? spec : `${name}@${spec}`
    const r = await spawnCmd('pnpm', ['add', target, '--config.auto-install-peers=false'], root, {
      onStderrLine: counterFeed,
    })
    const present = r.exitCode === 0 && existsSync(join(root, 'node_modules', name, 'package.json'))
    if (present) {
      installedNames.push(name)
      onProgress?.({ phase: 'done-one', name, ok: true })
    } else if (r.spawnError) {
      // spawn broke mid-way — stop pruning, report and bail
      return {
        ok: true,
        installed: false,
        summary: `安装中断（${r.spawnError}）。请在重启后于插件市场确认依赖。`,
        installedNames,
        prunedNames: failed,
        stderrTail: [...tailLines(r.stderr), ...tailLines(slowStderr)].slice(-12),
      }
    } else {
      slowStderr = tailLines(r.stderr).join('\n')
      // Only a name the manifest actually lost is "pruned"; one that resisted
      // the rewrite stays declared and is reported separately, because the boot
      // pre-check will still find its bundle unresolvable.
      if (pruneDependency(manifestFile, name)) failed.push(name)
      else stuck.push(name)
      onProgress?.({ phase: 'done-one', name, ok: false })
    }
  }
  const stuckNote = stuck.length > 0
    ? `；${stuck.length} 个依赖装不上且无法从 package.json 移除（文件可能不可写）：${stuck.join('、')}`
    : ''
  if (failed.length === 0 && stuck.length === 0) {
    return { ok: true, installed: true, summary: `依赖安装完成（新装 ${installedNames.length} 个）`, installedNames, prunedNames: [] }
  }
  if (installedNames.length > 0) {
    return {
      ok: true,
      installed: true,
      summary: `已装 ${installedNames.length} 个${failed.length > 0 ? `，剔除装不上的：${failed.join('、')}（可在插件市场重装）` : ''}${stuckNote}`,
      installedNames,
      prunedNames: failed,
      stderrTail: failed.length > 0 ? tailLines(slowStderr) : [],
    }
  }
  return {
    ok: true,
    installed: false,
    summary: failed.length > 0
      ? `依赖安装失败，已剔除装不上的：${failed.join('、')}。请在插件市场手动重装。${stuckNote}`
      : `依赖安装失败${stuckNote}。请在插件市场手动重装。`,
    installedNames,
    prunedNames: failed,
    stderrTail: tailLines(slowStderr),
  }
}
