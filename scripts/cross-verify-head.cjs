
// ============ 工作区插件 (gist-autosync) 的核心逻辑 ============
const WS_BACKUP_FORMAT = 'dsh-profile-backup'
const WS_BACKUP_VERSION = 0.2
const WS_MAX_BACKUP_FILES = 256
const WS_PROFILE_SKIP = new Set(['node_modules', '.dsh-market', '.git'])
const WS_GIST_FILENAME = 'dsh-profile-backup.json'
const WS_GIST_MAX_BYTES = 1024 * 1024

function ws_validateBackupStrict(value) {
  if (value === null || typeof value !== 'object') return '备份不是对象'
  const b = value
  if (typeof b.format !== 'string' || b.format === '') return '缺少 format 字段'
  if (!Array.isArray(b.files)) return '缺少 files 数组'
  if (b.files.length > WS_MAX_BACKUP_FILES) return '备份文件过多（>' + WS_MAX_BACKUP_FILES + '）'
  const { isAbsolute } = require('node:path')
  const paths = new Set()
  for (const f of b.files) {
    if (f === null || typeof f !== 'object') return 'files 含非对象项'
    const file = f
    if (typeof file.path !== 'string' || file.path === '') return 'files 含无 path 项'
    if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) return '不安全的备份路径: ' + file.path
    const normalized = file.path.replaceAll('\\', '/')
    if (normalized.split('/').some((part) => WS_PROFILE_SKIP.has(part))) return '含被排除的路径: ' + file.path
    if (paths.has(normalized)) return '重复的备份路径: ' + file.path
    paths.add(normalized)
    const hasJson = file.json !== undefined
    const hasLines = Array.isArray(file.lines)
    if (!hasJson && !hasLines) return '文件既无 json 也无 lines: ' + file.path
    if (file.path === 'package.json' && hasJson) {
      if (file.json === null || typeof file.json !== 'object' || Array.isArray(file.json)) return 'package.json 的 json 不是对象'
    }
    if (hasLines && !(file.lines).every((l) => typeof l === 'string')) return 'lines 含非字符串: ' + file.path
  }
  return null  // null = 校验通过
}

// 工作区 readGistBackupContent 的文件名探测逻辑（模拟从 Gist JSON 取 content）
function ws_findBackupContent(gistFilesObj) {
  const candidate = gistFilesObj[WS_GIST_FILENAME]?.content
    ?? gistFilesObj['dsh-config-backup.json']?.content
    ?? (Object.values(gistFilesObj).find((f) => typeof f?.content === 'string' && f.content.includes('"dsh-profile-backup"'))?.content)
  return typeof candidate === 'string' ? candidate : null
}

// 工作区 buildBackupEnvelope + serializeBackup
function ws_buildBackupEnvelope(files, profileName) {
  return { format: WS_BACKUP_FORMAT, version: WS_BACKUP_VERSION, createdAt: new Date().toISOString(), profile: profileName, files }
}
function ws_serializeBackup(backup) { return JSON.stringify(backup, null, 2) }


// ============ dsh-market 的核心逻辑 ============
const DM_BACKUP_FORMAT = 'dsh-profile-backup'
const DM_MAX_BACKUP_BYTES = 2 * 1024 * 1024
const DM_MAX_FILES = 256
const DM_SKIP_NAMES = new Set(['node_modules', '.dsh-market', '.git', 'pnpm-lock.yaml'])
const DM_GIST_FILENAME = 'dsh-profile-backup.json'
const DM_GIST_MAX_BYTES = 1024 * 1024

function dm_validatedBackup(value) {
  if (value === null || typeof value !== 'object') throw new Error('invalid backup')
  const backup = value
  if (backup.format !== DM_BACKUP_FORMAT || backup.version !== 0.2 || !Array.isArray(backup.files)) {
    throw new Error('unsupported backup format')
  }
  if (backup.files.length > DM_MAX_FILES) throw new Error('invalid backup contents')
  const { isAbsolute } = require('node:path')
  const files = []
  const paths = new Set()
  for (const value of backup.files) {
    if (value === null || typeof value !== 'object') throw new Error('invalid backup contents')
    const file = value
    const path = file.path
    if (typeof path !== 'string') throw new Error('invalid backup contents')
    if (path === '' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('unsafe backup path: ' + path)
    const normalized = path.replaceAll('\\', '/')
    if (normalized.split('/').some(part => DM_SKIP_NAMES.has(part))) throw new Error('excluded backup path: ' + path)
    if (paths.has(normalized)) throw new Error('duplicate backup path: ' + path)
    paths.add(normalized)
    if (path === 'package.json') {
      if (file.json === null || typeof file.json !== 'object' || Array.isArray(file.json)) throw new Error('backup package.json is invalid')
      files.push({ path, json: file.json })
    } else {
      if (!Array.isArray(file.lines) || !file.lines.every(line => typeof line === 'string')) throw new Error('invalid file content: ' + path)
      files.push({ path, lines: file.lines })
    }
  }
  if (!files.some(file => file.path === 'package.json')) throw new Error('invalid backup contents')
  return { ...backup, files }
}

// dsh-market readGist 只认 GIST_FILENAME
function dm_findBackupContent(gistFilesObj) {
  const file = gistFilesObj[DM_GIST_FILENAME]
  const content = file !== null && typeof file === 'object' && !Array.isArray(file) ? file.content : undefined
  return typeof content === 'string' ? content : null
}

// dsh-market createProfileBackup 的输出（模拟完整备份，非 partial）
function dm_createProfileBackup(profileName, files) {
  const backup = { format: DM_BACKUP_FORMAT, version: 0.2, createdAt: new Date().toISOString(), profile: profileName, files }
  return backup
}

module.exports = {
  WS_BACKUP_FORMAT, WS_BACKUP_VERSION, WS_MAX_BACKUP_FILES, WS_PROFILE_SKIP,
  WS_GIST_FILENAME, WS_GIST_MAX_BYTES,
  ws_validateBackupStrict, ws_findBackupContent, ws_buildBackupEnvelope, ws_serializeBackup,
  DM_BACKUP_FORMAT, DM_MAX_BACKUP_BYTES, DM_MAX_FILES, DM_SKIP_NAMES,
  DM_GIST_FILENAME, DM_GIST_MAX_BYTES,
  dm_validatedBackup, dm_findBackupContent, dm_createProfileBackup,
}
