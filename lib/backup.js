/**
 * Backup collection: gather the active profile's config files exactly like
 * dshmarket (single profile, paths relative to the profile root), build the
 * backup envelope, and validate it strictly (aligned with dshmarket's
 * validatedBackup).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, isAbsolute, sep } from 'node:path';
import { BACKUP_FORMAT, BACKUP_VERSION, MAX_BACKUP_FILES, PROFILE_SKIP, activeProfile, profileRoot, } from './config.js';
function profileFiles(root, dir, out) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (PROFILE_SKIP.has(entry.name) || /\.bak\b/.test(entry.name))
            continue;
        if (entry.name === 'pnpm-lock.yaml')
            continue;
        const abs = resolve(dir, entry.name);
        if (entry.isSymbolicLink())
            continue;
        if (entry.isDirectory())
            profileFiles(root, abs, out);
        else if (entry.isFile())
            out.push(resolve(abs).slice(root.length + 1).split(sep).join('/'));
        if (out.length > MAX_BACKUP_FILES)
            throw new Error(`profile has more than ${MAX_BACKUP_FILES} configuration files`);
    }
}
export function collectProfileBackup(includeLock) {
    const root = resolve(profileRoot());
    const manifestFile = resolve(root, 'package.json');
    if (!existsSync(manifestFile))
        throw new Error('profile package.json is missing');
    const relPaths = [];
    profileFiles(root, root, relPaths);
    if (includeLock && existsSync(resolve(root, 'pnpm-lock.yaml')))
        relPaths.push('pnpm-lock.yaml');
    const files = relPaths.sort().map((path) => {
        const content = readFileSync(resolve(root, path), 'utf8');
        return path === 'package.json' ? { path, json: JSON.parse(content) } : { path, lines: content.split(/\r?\n/) };
    });
    if (!files.some((f) => f.path === 'package.json'))
        throw new Error('profile package.json is missing');
    const containsSecrets = files.some((f) => /\.credentials|\.env|secrets?/i.test(f.path));
    return { files, containsSecrets };
}
/** Serialize the backup with 2-space indent so it reads well on the Gist web UI. */
export function serializeBackup(backup) {
    return JSON.stringify(backup, null, 2);
}
export function buildBackupEnvelope(files) {
    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: new Date().toISOString(),
        profile: activeProfile(),
        files,
    };
}
/**
 * Strict structural validation aligned with dshmarket's validatedBackup:
 * - format is a string, files is an array
 * - path is non-empty, not absolute, no `..` segments
 * - no SKIP_NAMES segments, no duplicate paths
 * - package.json (if present as json) must be a plain object; lines must be strings
 * Returns an error message, or null when valid.
 */
export function validateBackupStrict(value) {
    if (value === null || typeof value !== 'object')
        return '备份不是对象';
    const b = value;
    if (typeof b.format !== 'string' || b.format === '')
        return '缺少 format 字段';
    if (!Array.isArray(b.files))
        return '缺少 files 数组';
    if (b.files.length > MAX_BACKUP_FILES)
        return `备份文件过多（>${MAX_BACKUP_FILES}）`;
    const paths = new Set();
    for (const f of b.files) {
        if (f === null || typeof f !== 'object')
            return 'files 含非对象项';
        const file = f;
        if (typeof file.path !== 'string' || file.path === '')
            return 'files 含无 path 项';
        if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..'))
            return `不安全的备份路径: ${file.path}`;
        const normalized = file.path.replaceAll('\\', '/');
        if (normalized.split('/').some((part) => PROFILE_SKIP.has(part)))
            return `含被排除的路径: ${file.path}`;
        if (paths.has(normalized))
            return `重复的备份路径: ${file.path}`;
        paths.add(normalized);
        const hasJson = file.json !== undefined;
        const hasLines = Array.isArray(file.lines);
        if (!hasJson && !hasLines)
            return `文件既无 json 也无 lines: ${file.path}`;
        if (file.path === 'package.json' && hasJson) {
            if (file.json === null || typeof file.json !== 'object' || Array.isArray(file.json))
                return 'package.json 的 json 不是对象';
        }
        if (hasLines && !file.lines.every((l) => typeof l === 'string'))
            return `lines 含非字符串: ${file.path}`;
    }
    return null;
}
