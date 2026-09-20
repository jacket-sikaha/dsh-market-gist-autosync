/**
 * Config, paths, and shared constants for the gist-autosync host plugin.
 */
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
export const name = 'dsh-market-gist-autosync';
export const CONFIG_DIR = 'gist-autosync';
export const CONFIG_FILE = 'config.json';
export const GIST_FILENAME = 'dsh-profile-backup.json';
export const GIST_MAX_BYTES = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
export const GIST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const GIST_TOKEN_ENV = 'DSH_GITHUB_TOKEN';
/** dshmarket backup format constants — kept identical so backups interoperate. */
export const BACKUP_FORMAT = 'dsh-profile-backup';
export const BACKUP_VERSION = 0.2;
export const MAX_BACKUP_FILES = 256;
export const PROFILE_SKIP = new Set(['node_modules', '.dsh-market', '.git']);
export const MAX_UPLOAD_RECORDS = 20;
/** The active profile this backup covers (matches the desktop profile dir). */
export function activeProfile() {
    return process.env.DSH_PROFILE || 'desktop';
}
export const DEFAULTS = {
    gistToken: '',
    gistId: '',
    deviceName: '',
    scheduleEnabled: false,
    scheduleIntervalValue: 24,
    scheduleIntervalUnit: 'hour',
    includeLock: false,
    uploads: [],
};
export function err(code, error) {
    return { ok: false, code, error };
}
export function dshHome() {
    return process.env.DSH_HOME || homedir();
}
export function profileRoot() {
    return join(dshHome(), 'profiles', activeProfile());
}
export function configDirPath() {
    return join(dshHome(), CONFIG_DIR);
}
export function configFilePath() {
    return join(configDirPath(), CONFIG_FILE);
}
export function readBackupConfig() {
    try {
        const text = readFileSync(configFilePath(), 'utf8');
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            const cfg = { ...DEFAULTS, ...parsed };
            if (!Array.isArray(cfg.uploads))
                cfg.uploads = [];
            return cfg;
        }
    }
    catch {
        // no config yet — defaults
    }
    return { ...DEFAULTS };
}
export function writeBackupConfig(cfg) {
    mkdirSync(configDirPath(), { recursive: true });
    writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2), 'utf8');
}
export function deviceName() {
    return process.env.COMPUTERNAME || process.env.HOSTNAME || hostname();
}
export function parseGistId(input) {
    const trimmed = String(input || '').trim();
    if (trimmed === '')
        return '';
    let candidate = trimmed;
    try {
        const u = new URL(trimmed);
        if (u.protocol === 'https:' && (u.hostname === 'gist.github.com' || u.hostname.endsWith('.gist.github.com'))) {
            const parts = u.pathname.split('/').filter(Boolean);
            // A gist URL is gist.github.com/<user>/<id>; a single path segment is the
            // user's gist home page, not a gist — reject it explicitly instead of
            // mistaking the username for an id (which would 404 as invalid_gist).
            if (parts.length < 2)
                throw new Error('gist url 缺少 gist id（这是 gist 主页，不是某个具体 gist；留空则每次自动新建）');
            candidate = parts[parts.length - 1] || '';
        }
    }
    catch (e) {
        if (e instanceof Error && e.message.startsWith('gist url'))
            throw e;
        // not a URL — treat as a bare id below
    }
    if (!GIST_ID_RE.test(candidate))
        throw new Error('invalid gist id/url');
    return candidate;
}
/** Resolve the Gist token, env first (DSH_GITHUB_TOKEN), config value as fallback. */
export function resolveToken(cfg) {
    const env = process.env[GIST_TOKEN_ENV];
    if (typeof env === 'string' && env.trim() !== '')
        return { token: env.trim(), source: 'env' };
    const saved = cfg.gistToken.trim();
    if (saved !== '')
        return { token: saved, source: 'config' };
    return null;
}
/** Schedule interval in ms (minute-granularity). */
export function scheduleIntervalMs(cfg) {
    const v = Math.max(1, Number(cfg.scheduleIntervalValue) || 24);
    return cfg.scheduleIntervalUnit === 'minute' ? v * 60 * 1000 : v * 60 * 60 * 1000;
}
