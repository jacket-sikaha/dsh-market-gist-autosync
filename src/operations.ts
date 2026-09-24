/**
 * High-level operations the RPC handler exposes: test connection, backup now,
 * restore from a gist. These compose the config / gist / backup / restore /
 * install modules and own the cross-cutting concerns (token resolution,
 * gistId persistence, upload records, install-failure rollback).
 */
import {
  GIST_MAX_BYTES,
  activeProfile,
  deviceName,
  err,
  parseGistId,
  readBackupConfig,
  resolveToken,
  writeBackupConfig,
  profileRoot,
  type GistBackupConfig,
  type Result,
  type UploadRecord,
} from './config.js'
import { createGist, updateGist, verifyToken, readGistBackupContent, gistHttp, classify, failNet } from './gist.js'
import { collectProfileBackup, serializeBackup, buildBackupEnvelope, validateBackupStrict, unportableDeps, type ParsedBackup, type UnportableDep } from './backup.js'
import { restoreBackup } from './restore.js'
import { installRestoredDeps, type InstallProgress } from './install.js'
import { orphanBundles, removeBundles, findDshInstallDir } from './analyze.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type ProgressFn = (p: InstallProgress) => void

/** Dependencies of the profile's manifest as it currently stands on disk. */
function readManifestDeps(profileDirectory: string): unknown {
  try {
    const manifest = JSON.parse(readFileSync(resolve(profileDirectory, 'package.json'), 'utf8'))
    return manifest?.dependencies
  } catch {
    return undefined
  }
}

export async function doTest(cfg: GistBackupConfig, host: string): Promise<Result> {
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
    if (get.netError) return failNet(get)
    if (get.status !== 200) return classify(get.status, get.body)
  }
  return { ok: true, message: `连接正常（token 来源：${resolved.source === 'env' ? '环境变量' : '已保存配置'}）` }
}

/**
 * gistOverride: when provided (including the empty string), it is the source of
 * truth for which gist to update — the UI field value, so "clear the field and
 * back up" really creates a fresh gist. undefined = use cfg.gistId (scheduled
 * backups, which have no UI context).
 */
export async function doBackup(cfg: GistBackupConfig, host: string, gistOverride?: string): Promise<Result> {
  const resolved = resolveToken(cfg)
  if (!resolved) return err('no_token', '未配置 Gist token（请在下方填写，或设置环境变量 DSH_GITHUB_TOKEN）')
  let gid: string
  try {
    gid = parseGistId(gistOverride !== undefined ? gistOverride : cfg.gistId)
  } catch (e) {
    return err('invalid_gist', e instanceof Error ? e.message : String(e))
  }
  const token = resolved.token
  let files
  let containsSecrets = false
  let strippedDeps: UnportableDep[] = []
  let strippedBundles: string[] = []
  try {
    const collected = collectProfileBackup(cfg.includeLock)
    files = collected.files
    containsSecrets = collected.containsSecrets
    strippedDeps = collected.strippedDeps
    strippedBundles = collected.strippedBundles
  } catch (e) {
    return err('other', e instanceof Error ? e.message : String(e))
  }
  const backup = buildBackupEnvelope(files)
  const content = serializeBackup(backup)
  const bytes = Buffer.byteLength(content)
  if (bytes > GIST_MAX_BYTES) {
    return err('too_large', `备份 ${(bytes / 1024).toFixed(0)}KB 超过 GitHub Gist 1MB 限制`)
  }
  const isNew = gid === ''
  const ref = isNew ? await createGist(token, content, host) : await updateGist(token, gid, content, host)
  if (!ref.ok) return ref
  // Persist the gist id so the user never has to look it up. The upload record
  // itself is returned to the caller, which stores it in the storage domain
  // (history does not belong in the settings file).
  const newGistId = String(ref.gistId || gid)
  const gistUrl = String(ref.gistUrl || `https://gist.github.com/${newGistId}`)
  const record: UploadRecord = {
    gistId: newGistId,
    deviceName: cfg.deviceName.trim() || deviceName(),
    uploadedAt: new Date().toISOString(),
    status: isNew ? 'new' : 'update',
    bytes,
  }
  writeBackupConfig({ ...cfg, gistId: newGistId })
  // Tell the user what did not travel, rather than silently dropping it: this
  // backup is read by their other machines, and a plugin that vanishes there
  // with no explanation looks like data loss.
  const stripNote = strippedDeps.length > 0
    ? `；已排除 ${strippedDeps.length} 个指向本机路径的本地依赖（换机器后路径不存在，同步过去也无法安装）：${strippedDeps.map((d) => `${d.name}（${d.spec}）`).join('、')}${strippedBundles.length > 0 ? `，并同时移除了对应的 bundle 记录：${strippedBundles.join('、')}` : ''}`
    : ''
  return { ok: true, gistId: newGistId, gistUrl, bytes, isNew, record, containsSecrets, strippedDeps, strippedBundles, message: stripNote === '' ? undefined : `备份完成${stripNote}` }
}

export async function doRestore(
  cfg: GistBackupConfig,
  host: string,
  gistInput: string,
  onProgress?: ProgressFn,
): Promise<Result> {
  const resolved = resolveToken(cfg)
  if (!resolved) return err('no_token', '未配置 Gist token（请在下方填写，或设置环境变量 DSH_GITHUB_TOKEN）')
  let gid: string
  try {
    gid = parseGistId(gistInput || cfg.gistId)
  } catch (e) {
    return err('invalid_gist', e instanceof Error ? e.message : String(e))
  }
  if (gid === '') return err('invalid_gist', '请提供要恢复的 Gist id 或 URL')

  const got = await readGistBackupContent(resolved.token, gid, host)
  if (!got.ok) return got
  let parsed: ParsedBackup
  try {
    parsed = JSON.parse(got.content)
  } catch {
    return err('invalid_gist', '备份文件内容不是有效 JSON')
  }
  // Strict validation, aligned with dshmarket's validatedBackup.
  const vErr = validateBackupStrict(parsed)
  if (vErr) return err('invalid_gist', vErr)

  const result = restoreBackup(profileRoot(), parsed)
  if (!result.ok) return err('restore_failed', result.error || '恢复失败')

  // Detect link:/file: dependencies pointing at absolute paths on another
  // machine (aligned with dshmarket unportableDeps #205). New backups no longer
  // carry these — the backup half strips them (stripMachineLocalDeps) — but a
  // backup written by an older version, or by another tool, still can, so the
  // restore half reports what it sees.
  //
  // Reported from the manifest as it stands AFTER the install ran, not from the
  // incoming backup: install.ts prunes a machine-local dep whose path is gone,
  // and reporting the pre-install list would announce the same dependency twice
  // with contradictory advice — "pruned" in one sentence and "install it by
  // hand" in the next. Re-read the file so the message describes the profile
  // the user actually has.
  const install = await installRestoredDeps(profileRoot(), onProgress)

  // If pnpm could not run at all AND nothing was installed AND we pruned
  // nothing (manifest untouched), the files are still valid — no rollback.
  // Roll back files ONLY when we pruned every single dependency (install ran,
  // everything failed): the manifest is now empty of plugins and the restore
  // achieved nothing, so mirror dshmarket and undo the file writes.
  if (!install.installed && install.prunedNames.length > 0 && install.installedNames.length === 0) {
    result.rollback?.()
    return err('restore_failed', `依赖全部安装失败，已回滚恢复。${install.summary}`)
  }

  const warnings = unportableDeps(readManifestDeps(profileRoot()))

  // Boot pre-check (#339, aligned with dshmarket's restoredBootErrors /
  // orphanBundles). The loader reads dsh.profile.bundles and dies on the FIRST
  // name it cannot resolve — the whole profile, not just that plugin — and it
  // does so at the NEXT restart, with nothing tying that failure back to the
  // restore that caused it. The offending plugin is unloadable either way, so
  // drop the row and report it: that is what lets the rest of the profile boot
  // instead of landing the user in recovery mode.
  const orphans = orphanBundles(profileRoot(), findDshInstallDir())
  const droppedBundles = removeBundles(profileRoot(), orphans)

  // Wording matters here: `warnings` is the POST-install manifest, so any dep
  // still listed is one that survived pruning — typically its local path exists
  // on this machine too, or the spec was relative. Saying "won't auto-install,
  // reinstall by hand" would contradict the "pruned" sentence above and send
  // the user to fix something that is already fine. The honest statement is
  // that these specs are machine-specific and travel badly.
  const warnNote = warnings.length > 0
    ? `；另有 ${warnings.length} 个依赖指向本机绝对路径，${warnings.map((w) => `${w.name}（${w.spec}）`).join('、')}——本机可用，但换机器后路径不存在，建议改为可移植的来源或在本机插件市场重装`
    : ''
  const bootNote = droppedBundles.length > 0
    ? `；启动预检发现 ${droppedBundles.length} 个无法解析的 bundle，已从 profile 移除（保留的话下次重启会直接进恢复模式）：${droppedBundles.join('、')}`
    : ''
  return {
    ok: true,
    restored: result.restored,
    mergedManifest: result.mergedManifest,
    installOk: install.installed,
    installedNames: install.installedNames,
    prunedNames: install.prunedNames,
    unportableDepsWarnings: warnings,
    bootErrors: droppedBundles,
    message: `已恢复 ${result.restored} 个文件到 profile「${activeProfile()}」${result.mergedManifest ? '（package.json 已合并，未覆盖现有插件）' : ''}。${install.summary}${warnNote}${bootNote}。重启 DSH 后生效。`,
  }
}
