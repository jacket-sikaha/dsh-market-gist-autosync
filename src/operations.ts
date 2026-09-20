/**
 * High-level operations the RPC handler exposes: test connection, backup now,
 * restore from a gist. These compose the config / gist / backup / restore /
 * install modules and own the cross-cutting concerns (token resolution,
 * gistId persistence, upload records, install-failure rollback).
 */
import {
  GIST_MAX_BYTES,
  activeProfile,
  err,
  parseGistId,
  readBackupConfig,
  resolveToken,
  writeBackupConfig,
  profileRoot,
  type GistBackupConfig,
  type Result,
  type UploadRecord,
  MAX_UPLOAD_RECORDS,
} from './config.js'
import { createGist, updateGist, verifyToken, readGistBackupContent, gistHttp, classify } from './gist.js'
import { collectProfileBackup, serializeBackup, buildBackupEnvelope, validateBackupStrict, type ParsedBackup } from './backup.js'
import { restoreBackup } from './restore.js'
import { installRestoredDeps, type InstallProgress } from './install.js'

export type ProgressFn = (p: InstallProgress) => void

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
    if (get.netError) return err('network', get.netError)
    if (get.status !== 200) return classify(get.status, get.body)
  }
  return { ok: true, message: `连接正常（token 来源：${resolved.source === 'env' ? '环境变量' : '已保存配置'}）` }
}

export async function doBackup(cfg: GistBackupConfig, host: string): Promise<Result> {
  const resolved = resolveToken(cfg)
  if (!resolved) return err('no_token', '未配置 Gist token（请在下方填写，或设置环境变量 DSH_GITHUB_TOKEN）')
  let gid: string
  try {
    gid = parseGistId(cfg.gistId)
  } catch (e) {
    return err('invalid_gist', e instanceof Error ? e.message : String(e))
  }
  const token = resolved.token
  let files
  let containsSecrets = false
  try {
    const collected = collectProfileBackup(cfg.includeLock)
    files = collected.files
    containsSecrets = collected.containsSecrets
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

  // Install the deps the merged manifest now references, so the next boot can
  // resolve every bundle (otherwise -> recovery mode). Report live progress.
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

  return {
    ok: true,
    restored: result.restored,
    mergedManifest: result.mergedManifest,
    installOk: install.installed,
    installedNames: install.installedNames,
    prunedNames: install.prunedNames,
    message: `已恢复 ${result.restored} 个文件到 profile「${activeProfile()}」${result.mergedManifest ? '（package.json 已合并，未覆盖现有插件）' : ''}。${install.summary}。重启 DSH 后生效。`,
  }
}
