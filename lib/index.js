import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync, } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import z from '@deepseek-ai/schemastery';
/**
 * dsh-market-gist-autosync — 把 DSH 配置定时备份到 GitHub Gist。
 *
 * Host half only for the first minimal version: gist token / gist id 配置、
 * 配置备份（带错误分类）、自持定时备份，全部在一个插件里完成。
 * Client 设置页在后续版本补上；当前通过 RPC + 一个模型工具暴露能力。
 */
const name = 'dsh-market-gist-autosync';
const inject = ['webServer'];
const Config = z.object({
    scheduleIntervalHours: z.number().step(1).min(1).max(24 * 30).default(24),
    gistApiHost: z.string().default('api.github.com'),
});
const CONFIG_DIR = 'gist-autosync';
const CONFIG_FILE = 'config.json';
const GIST_FILENAME = 'dsh-config-backup.json';
const GIST_MAX_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const GIST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NETWORK_ERROR_CODES = new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
    'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED',
]);
const DEFAULTS = {
    gistToken: '',
    gistId: '',
    fileNamePrefix: 'config',
    fileName: '',
    deviceName: '',
    scheduleEnabled: false,
    scheduleIntervalHours: 24,
    include: ['root-skin', 'root-skill-hub'],
};
const CATALOG = [
    { id: 'profile-core', label: '插件配置（当前 profile）', description: 'package.json 依赖清单 + cordis 补丁层 + workspace 配置 —— 换机重建插件的核心', required: true },
    { id: 'root-settings', label: '主设置 settings.yaml', description: 'DSH 全局设置（模型、界面、功能开关）', required: true },
    { id: 'root-credentials', label: '凭证 .credentials.yaml', description: 'API 密钥等凭证（敏感，gist 为私有）', required: true },
    { id: 'root-skin', label: '主题皮肤 dream-skin.json', description: '梦境皮肤配置（较大，约 300KB）', required: false },
    { id: 'root-skill-hub', label: '技能中枢配置', description: 'dsh-skill-hub 的分组/来源/统计', required: false },
    { id: 'root-misc', label: '其他根目录小配置', description: 'thinking-effort、anonymous-id 等', required: false },
    { id: 'skills-meta', label: '技能文档/配置', description: 'skills/ 下各技能的 .md/.json/.yaml（不含字体等资源）', required: false },
    { id: 'profile-lock', label: '依赖锁 pnpm-lock.yaml', description: '精确复现依赖版本（约 115KB）', required: false },
    { id: 'profile-web', label: 'web profile 配置', description: 'profiles/web/ 的配置文件', required: false },
];
function err(code, error) {
    return { ok: false, code, error };
}
function dshHome() {
    return process.env.DSH_HOME || homedir();
}
function configDirPath() {
    return join(dshHome(), CONFIG_DIR);
}
function configFilePath() {
    return join(configDirPath(), CONFIG_FILE);
}
function readBackupConfig() {
    try {
        const text = readFileSync(configFilePath(), 'utf8');
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            return { ...DEFAULTS, ...parsed };
        }
    }
    catch {
        // no config yet — defaults
    }
    return { ...DEFAULTS };
}
function writeBackupConfig(cfg) {
    mkdirSync(configDirPath(), { recursive: true });
    writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2), 'utf8');
}
function sanitizeName(s) {
    const c = String(s || '').replace(/[^A-Za-z0-9._-]/g, '_');
    return c === '' ? 'config' : c;
}
function nowTimestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function deviceName() {
    return process.env.COMPUTERNAME || process.env.HOSTNAME || hostname();
}
function fileNameOf(cfg) {
    if (cfg.fileName && cfg.fileName.trim() !== '') {
        return sanitizeName(cfg.fileName.trim()) + '.json';
    }
    const pre = sanitizeName(cfg.fileNamePrefix || 'config');
    const dev = sanitizeName(cfg.deviceName || deviceName());
    const t = nowTimestamp();
    return dev ? `${pre}-${t}-${dev}.json` : `${pre}-${t}.json`;
}
function parseGistId(input) {
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
function gistHttp(token, method, path, body, host = 'api.github.com') {
    return new Promise((resolve) => {
        const headers = {
            authorization: `Bearer ${token}`,
            'user-agent': 'dsh-market-gist-autosync',
            accept: 'application/vnd.github+json',
        };
        if (body !== undefined) {
            headers['content-type'] = 'application/json';
            headers['content-length'] = String(Buffer.byteLength(body));
        }
        const req = httpsRequest({ hostname: host, path, method, headers }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                chunks.push(chunk);
                if (size > GIST_MAX_BYTES + 16 * 1024)
                    res.destroy();
            });
            res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', (e) => resolve({ status: 0, body: '', netError: e.message }));
        req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
        if (body !== undefined)
            req.end(body);
        else
            req.end();
    });
}
function classify(status, body) {
    let msg = body;
    try {
        const p = JSON.parse(body);
        if (typeof p.message === 'string' && p.message)
            msg = p.message;
    }
    catch {
        // keep raw
    }
    if (status === 401)
        return err('invalid_token', 'GitHub token 无效或已撤销');
    if (status === 403)
        return err('rate_limit', `GitHub 拒绝：${msg}`);
    if (status === 404)
        return err('invalid_gist', 'Gist 不存在（请检查 id/URL）');
    if (status === 422)
        return err('invalid_gist', `GitHub 拒绝：${msg}`);
    return err('other', `HTTP ${status} ${msg}`);
}
async function createGist(token, content, host) {
    const body = JSON.stringify({
        description: 'dsh config backup',
        public: false,
        files: { [GIST_FILENAME]: { content } },
    });
    const r = await gistHttp(token, 'POST', '/gists', body, host);
    if (r.netError)
        return err('network', r.netError);
    if (r.status !== 201)
        return classify(r.status, r.body);
    const data = JSON.parse(r.body);
    return { ok: true, gistId: data.id, gistUrl: data.html_url || `https://gist.github.com/${data.id}` };
}
async function updateGist(token, gistId, content, host) {
    const body = JSON.stringify({
        files: { [GIST_FILENAME]: { content } },
    });
    const r = await gistHttp(token, 'PATCH', `/gists/${gistId}`, body, host);
    if (r.netError)
        return err('network', r.netError);
    if (r.status !== 200)
        return classify(r.status, r.body);
    const data = JSON.parse(r.body);
    return { ok: true, gistId: data.id || gistId, gistUrl: data.html_url || `https://gist.github.com/${gistId}` };
}
async function verifyToken(token, host) {
    const r = await gistHttp(token, 'GET', '/user', undefined, host);
    if (r.netError)
        return err('network', r.netError);
    if (r.status !== 200)
        return classify(r.status, r.body);
    return { ok: true, message: '连接正常' };
}
/**
 * Resolve the Gist token, env first. DSH_GITHUB_TOKEN wins over the saved
 * config value so a scheduled backup can run without a token ever touching
 * disk (aligned with dshmarket's posture); the saved form value is the
 * fallback for interactive use.
 */
const GIST_TOKEN_ENV = 'DSH_GITHUB_TOKEN';
function resolveToken(cfg) {
    const env = process.env[GIST_TOKEN_ENV];
    if (typeof env === 'string' && env.trim() !== '')
        return { token: env.trim(), source: 'env' };
    const saved = cfg.gistToken.trim();
    if (saved !== '')
        return { token: saved, source: 'config' };
    return null;
}
const SKIP_NAMES = new Set(['node_modules', '.git', 'sessions', '.dsh-market', '.cache', '__pycache__', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);
const SECRET_HINT = /\.credentials|\.env|secrets?/i;
// Backups carry configuration, not skill resources/caches/logs. Only these
// text extensions are collected from walked subtrees; binary assets (fonts,
// schemas, pdfs, archives) and logs (.ndjson/.txt) are excluded — otherwise a
// skills/ tree with fonts alone blows past the 1 MB Gist limit.
const WALK_INCLUDE_EXT = new Set(['.json', '.yaml', '.yml', '.toml', '.md']);
const WALK_MAX_FILE_BYTES = 256 * 1024;
/** Read one file as a FileEntry, tolerating read failures (skipped). The size
 *  cap applies only to walked subtrees (skill resources); explicitly-selected
 *  root files like the skin are collected at full size. */
function readEntry(root, rel, enforceCap) {
    try {
        const abs = join(root, rel);
        if (enforceCap && statSync(abs).size > WALK_MAX_FILE_BYTES)
            return null;
        return { path: rel, content: readFileSync(abs, 'utf8') };
    }
    catch {
        return null;
    }
}
/** Recursively collect config-like text files under a subtree. */
function walkConfig(root, prefix, out, depth) {
    if (depth > 4 || out.length > 250)
        return;
    let kids;
    try {
        kids = readdirSync(join(root, prefix), { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const k of kids) {
        if (SKIP_NAMES.has(k.name) || /\.bak\b/.test(k.name))
            continue;
        const rel = prefix ? `${prefix}/${k.name}` : k.name;
        if (k.isDirectory()) {
            walkConfig(root, rel, out, depth + 1);
        }
        else if (k.isFile()) {
            const dot = k.name.lastIndexOf('.');
            const ext = dot === -1 ? '' : k.name.slice(dot).toLowerCase();
            if (!WALK_INCLUDE_EXT.has(ext))
                continue;
            const e = readEntry(root, rel, true);
            if (e)
                out.push(e);
        }
    }
}
/**
 * Collect backup files according to the catalog selection. Required units are
 * always included; optional units only when their id is in cfg.include.
 */
function collectFiles(root, cfg) {
    const files = [];
    const include = new Set(cfg.include || []);
    const want = (id) => {
        const unit = CATALOG.find((u) => u.id === id);
        return unit !== undefined && (unit.required || include.has(id));
    };
    const push = (rel) => {
        const e = readEntry(root, rel, false);
        if (e)
            files.push(e);
    };
    // profile-core: the current profile's minimal rebuild recipe (dshmarket's set)
    if (want('profile-core')) {
        for (const f of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml']) {
            push(`profiles/desktop/${f}`);
        }
    }
    // root-level single files
    if (want('root-settings'))
        push('settings.yaml');
    if (want('root-credentials'))
        push('.credentials.yaml');
    if (want('root-skin'))
        push('dream-skin.json');
    if (want('root-skill-hub'))
        push('dsh-skill-hub.json');
    if (want('root-misc')) {
        push('thinking-effort-loaded.json');
        push('.anonymous-user-id');
    }
    // optional subtrees
    if (want('profile-lock'))
        push('profiles/desktop/pnpm-lock.yaml');
    if (want('skills-meta'))
        walkConfig(root, 'skills', files, 0);
    if (want('profile-web'))
        walkConfig(root, 'profiles/web', files, 0);
    if (want('agent-presets'))
        walkConfig(root, '.agent-presets', files, 0);
    const containsSecrets = files.some((f) => SECRET_HINT.test(f.path));
    return { files, containsSecrets };
}
async function doTest(cfg, host) {
    const resolved = resolveToken(cfg);
    if (!resolved)
        return err('no_token', '未配置 Gist token（请在下方填写，或设置环境变量 DSH_GITHUB_TOKEN）');
    const token = resolved.token;
    const r = await verifyToken(token, host);
    if (!r.ok)
        return r;
    if (cfg.gistId.trim() !== '') {
        let gid;
        try {
            gid = parseGistId(cfg.gistId);
        }
        catch (e) {
            return err('invalid_gist', e instanceof Error ? e.message : String(e));
        }
        const get = await gistHttp(token, 'GET', `/gists/${gid}`, undefined, host);
        if (get.netError)
            return err('network', get.netError);
        if (get.status !== 200)
            return classify(get.status, get.body);
    }
    return { ok: true, message: `连接正常（token 来源：${resolved.source === 'env' ? '环境变量' : '已保存配置'}）` };
}
async function doBackup(cfg, host) {
    const resolved = resolveToken(cfg);
    if (!resolved)
        return err('no_token', '未配置 Gist token（请在下方填写，或设置环境变量 DSH_GITHUB_TOKEN）');
    let gid;
    try {
        gid = parseGistId(cfg.gistId);
    }
    catch (e) {
        return err('invalid_gist', e instanceof Error ? e.message : String(e));
    }
    const token = resolved.token;
    const { files, containsSecrets } = collectFiles(dshHome(), cfg);
    const envelope = {
        format: 'dsh-config-gist-backup',
        version: 1,
        createdAt: new Date().toISOString(),
        fileName: fileNameOf(cfg),
        files,
    };
    const content = JSON.stringify(envelope);
    if (Buffer.byteLength(content) > GIST_MAX_BYTES) {
        return err('too_large', '备份超过 GitHub Gist 1MB 限制');
    }
    const ref = gid === '' ? await createGist(token, content, host) : await updateGist(token, gid, content, host);
    if (!ref.ok)
        return ref;
    return { ...ref, fileName: fileNameOf(cfg), at: new Date().toISOString(), containsSecrets };
}
function sendJson(response, status, value) {
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    response.end(JSON.stringify(value));
}
function sameOrigin(request) {
    // Minimal loopback guard, matching dshmarket's posture. The webServer sits
    // on loopback; treat requests without a disallowed Origin as same-origin.
    const origin = request.headers?.['origin'] ?? request.headers?.['Origin'];
    if (origin === undefined)
        return true;
    const value = Array.isArray(origin) ? origin[0] : origin;
    if (value === '')
        return true;
    try {
        const u = new URL(value);
        return ['localhost', '127.0.0.1', '::1'].includes(u.hostname) || u.hostname.startsWith('127.');
    }
    catch {
        return false;
    }
}
async function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', (c) => chunks.push(c));
        request.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            }
            catch (e) {
                reject(e);
            }
        });
    });
}
async function apply(ctx, rawConfig) {
    const apiHost = rawConfig?.gistApiHost ?? 'api.github.com';
    let interval;
    const schedule = (cfg) => {
        if (interval) {
            clearInterval(interval);
            interval = undefined;
        }
        if (cfg.scheduleEnabled) {
            const hours = Math.max(1, cfg.scheduleIntervalHours || 24);
            interval = setInterval(() => {
                doBackup(cfg, apiHost)
                    .then((r) => {
                    if (!r.ok)
                        console.error(`[gist-autosync] scheduled backup failed: ${r.error}`);
                })
                    .catch((e) => console.error(`[gist-autosync] scheduled backup error: ${e instanceof Error ? e.message : String(e)}`));
            }, hours * 60 * 60 * 1000);
            // do not keep the process alive solely for the timer
            interval.unref?.();
        }
    };
    ctx.effect(() => {
        const stop = () => {
            if (interval) {
                clearInterval(interval);
                interval = undefined;
            }
        };
        // initial schedule from persisted config
        schedule(readBackupConfig());
        return stop;
    });
    ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-market-gist-autosync/rpc',
        handler: async (request, response) => {
            if (request.method !== 'POST') {
                response.writeHead(405, { allow: 'POST' });
                response.end();
                return;
            }
            if (!sameOrigin(request))
                return sendJson(response, 403, { error: 'untrusted origin' });
            try {
                const body = await readJsonBody(request);
                const action = body.action;
                if (action === 'getConfig') {
                    const envToken = typeof process.env[GIST_TOKEN_ENV] === 'string' && process.env[GIST_TOKEN_ENV].trim() !== '';
                    sendJson(response, 200, { ok: true, config: readBackupConfig(), deviceNameDetected: deviceName(), catalog: CATALOG, envTokenSet: envToken });
                }
                else if (action === 'saveConfig') {
                    const cfg = { ...DEFAULTS, ...(body.config || {}) };
                    cfg.scheduleEnabled = Boolean(cfg.scheduleEnabled);
                    cfg.scheduleIntervalHours = Math.max(1, Number(cfg.scheduleIntervalHours) || 24);
                    cfg.include = Array.isArray(cfg.include) ? cfg.include.filter((x) => typeof x === 'string') : [];
                    writeBackupConfig(cfg);
                    schedule(cfg);
                    sendJson(response, 200, { ok: true, config: cfg });
                }
                else if (action === 'testConnection') {
                    sendJson(response, 200, await doTest(readBackupConfig(), apiHost));
                }
                else if (action === 'backupNow') {
                    sendJson(response, 200, await doBackup(readBackupConfig(), apiHost));
                }
                else {
                    sendJson(response, 400, { ok: false, code: 'invalid_action', error: 'invalid action' });
                }
            }
            catch (e) {
                sendJson(response, 400, { ok: false, code: 'other', error: e instanceof Error ? e.message : String(e) });
            }
        },
    });
    // Note: no model tool here. Registering a tool requires the @deepseek-ai/dsh-tools
    // defineTool contract (output { schema, render }) which is easy to get wrong and
    // will abort host boot; the core capability is fully covered by the RPC endpoint
    // above plus self-scheduling. A tool can be added later once the host half is stable.
}
export { name, inject, Config, apply };
