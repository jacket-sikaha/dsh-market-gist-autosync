/**
 * Post-restore dependency install via pnpm, with live progress reporting.
 *
 * Two distinct failure modes are handled differently:
 * - pnpm itself cannot run here (spawn EPERM / not found): we do NOT touch the
 *   manifest — pruning deps we merely failed to *probe* would wrongly uninstall
 *   plugins that are already present. Reported as installed:false instead.
 * - pnpm runs but a specific package fails to install (404 / network): only
 *   those packages are pruned, so the profile still boots without them.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** Spawn a command. Windows `.cmd` shims (pnpm) cannot start without a shell,
 * so route through cmd.exe /d /s /c with an explicitly quoted command line. */
export function spawnCmd(file, args, cwd) {
    return new Promise((resolvePromise) => {
        const quote = (a) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
        const isWin = process.platform === 'win32';
        const cmd = isWin ? (process.env.ComSpec ?? 'cmd.exe') : file;
        const argv = isWin ? ['/d', '/s', '/c', [file, ...args].map(quote).join(' ')] : args;
        let child;
        try {
            child = spawn(cmd, argv, { cwd, shell: false, windowsHide: true, env: { ...process.env, CI: 'true' } });
        }
        catch (e) {
            resolvePromise({ exitCode: 1, stderr: '', spawnError: e instanceof Error ? e.message : String(e) });
            return;
        }
        let stderr = '';
        child.stderr?.on('data', (c) => { stderr += c.toString('utf8'); });
        child.on('error', (e) => resolvePromise({ exitCode: 1, stderr, spawnError: e.message }));
        child.on('close', (code) => resolvePromise({ exitCode: code ?? 1, stderr }));
    });
}
function pruneDependency(manifestFile, name) {
    try {
        const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
        if (m.dependencies)
            delete m.dependencies[name];
        if (Array.isArray(m.dsh?.profile?.bundles)) {
            m.dsh.profile.bundles = m.dsh.profile.bundles.filter((b) => b !== name);
        }
        writeFileSync(manifestFile, JSON.stringify(m, null, 2) + '\n', 'utf8');
    }
    catch { /* best effort */ }
}
export async function installRestoredDeps(root, onProgress) {
    const manifestFile = join(root, 'package.json');
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    }
    catch {
        return { ok: false, installed: false, summary: '无法读取恢复后的 package.json', installedNames: [], prunedNames: [] };
    }
    const deps = Object.entries(manifest.dependencies ?? {});
    if (deps.length === 0)
        return { ok: true, installed: true, summary: '无依赖需要安装', installedNames: [], prunedNames: [] };
    // Which deps are actually missing from node_modules right now? Only those
    // need installing — the ones already present boot fine either way.
    const missing = deps.filter(([name, spec]) => {
        if (typeof spec !== 'string')
            return false;
        if (/^(?:link|file):/.test(spec))
            return false; // machine-local path, not installable here
        return !existsSync(join(root, 'node_modules', name, 'package.json'));
    }).map(([name, spec]) => [name, spec]);
    onProgress?.({ phase: 'probe', missing: missing.map(([n]) => n) });
    if (missing.length === 0)
        return { ok: true, installed: true, summary: '依赖均已安装', installedNames: [], prunedNames: [] };
    // Fast path: one `pnpm install` for everything.
    onProgress?.({ phase: 'install-all' });
    const install = await spawnCmd('pnpm', ['install', '--config.auto-install-peers=false'], root);
    if (install.exitCode === 0) {
        return { ok: true, installed: true, summary: `依赖安装完成（新装 ${missing.length} 个）`, installedNames: missing.map(([n]) => n), prunedNames: [] };
    }
    // pnpm could not even run (spawn EPERM / not found / no PATH): leave the
    // manifest untouched and ask the user to reinstall via the market — pruning
    // here would wrongly drop already-installed plugins.
    if (install.spawnError) {
        return {
            ok: true,
            installed: false,
            summary: `恢复完成，但此环境无法自动安装依赖（${install.spawnError}）。${missing.length} 个插件需在重启后于插件市场确认/重装：${missing.map(([n]) => n).join('、')}`,
            installedNames: [],
            prunedNames: [],
        };
    }
    // Slow path (aligns with dshmarket): one bad dep aborts the whole install, so
    // retry each missing dep individually and prune only those that truly fail.
    const failed = [];
    const installedNames = [];
    for (let i = 0; i < missing.length; i++) {
        const [name, spec] = missing[i];
        onProgress?.({ phase: 'install-one', name, index: i + 1, total: missing.length });
        const target = /^(?:github|git\+|https?):/.test(spec) ? spec : `${name}@${spec}`;
        const r = await spawnCmd('pnpm', ['add', target, '--config.auto-install-peers=false'], root);
        const present = r.exitCode === 0 && existsSync(join(root, 'node_modules', name, 'package.json'));
        if (present) {
            installedNames.push(name);
            onProgress?.({ phase: 'done-one', name, ok: true });
        }
        else if (r.spawnError) {
            // spawn broke mid-way — stop pruning, report and bail
            return { ok: true, installed: false, summary: `安装中断（${r.spawnError}）。请在重启后于插件市场确认依赖。`, installedNames, prunedNames: failed };
        }
        else {
            failed.push(name);
            pruneDependency(manifestFile, name);
            onProgress?.({ phase: 'done-one', name, ok: false });
        }
    }
    if (failed.length === 0)
        return { ok: true, installed: true, summary: `依赖安装完成（新装 ${installedNames.length} 个）`, installedNames, prunedNames: [] };
    if (installedNames.length > 0) {
        return { ok: true, installed: true, summary: `已装 ${installedNames.length} 个，剔除装不上的：${failed.join('、')}（可在插件市场重装）`, installedNames, prunedNames: failed };
    }
    return { ok: true, installed: false, summary: `依赖安装失败，已剔除装不上的：${failed.join('、')}。请在插件市场手动重装。`, installedNames, prunedNames: failed };
}
