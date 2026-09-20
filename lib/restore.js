/**
 * Restore: write a backup back into the active profile, merging package.json
 * (union bundles, overlay deps) so existing plugins survive. Atomic per-file
 * writes with a rollback handle the caller can invoke if the post-restore
 * dependency install fails entirely (mirrors dshmarket's restored.rollback()).
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, lstatSync, renameSync, rmSync, } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
export function entryContent(file) {
    if (file.json !== undefined)
        return JSON.stringify(file.json, null, 2) + '\n';
    return (file.lines ?? []).join('\n');
}
/** Merge backup manifest into current: union bundles, overlay deps (current kept, backup wins conflicts). */
export function mergeManifests(backupJson, current) {
    const asObj = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {});
    const backupDeps = asObj(backupJson.dependencies);
    const currentDeps = asObj(current.dependencies);
    const deps = { ...currentDeps };
    for (const [k, spec] of Object.entries(backupDeps)) {
        if (typeof spec === 'string')
            deps[k] = spec;
    }
    const backupBundles = asObj(asObj(backupJson.dsh).profile).bundles;
    const currentBundles = asObj(asObj(current.dsh).profile).bundles;
    const bundleSet = new Set();
    for (const b of Array.isArray(currentBundles) ? currentBundles : [])
        if (typeof b === 'string')
            bundleSet.add(b);
    for (const b of Array.isArray(backupBundles) ? backupBundles : [])
        if (typeof b === 'string')
            bundleSet.add(b);
    const merged = { ...backupJson, ...current, dependencies: deps };
    const curDsh = asObj(current.dsh);
    const curProfile = asObj(curDsh.profile);
    merged.dsh = { ...asObj(backupJson.dsh), ...curDsh, profile: { ...asObj(asObj(backupJson.dsh).profile), ...curProfile, bundles: [...bundleSet] } };
    return merged;
}
export function restoreBackup(root, backup) {
    const previous = new Map();
    let rolledBack = false;
    const rollback = () => {
        if (rolledBack)
            return;
        rolledBack = true;
        for (const [target, content] of previous) {
            try {
                if (content === null)
                    rmSync(target, { force: true });
                else
                    writeFileSync(target, content);
            }
            catch { /* best effort */ }
        }
    };
    let mergedManifest = false;
    const resolvedRoot = resolve(root);
    try {
        for (const file of backup.files) {
            const target = resolve(resolvedRoot, file.path);
            if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
                throw new Error(`不安全的备份路径: ${file.path}`);
            }
            if (existsSync(target) && !lstatSync(target).isFile())
                throw new Error(`目标不是普通文件: ${file.path}`);
            mkdirSync(dirname(target), { recursive: true });
            previous.set(target, existsSync(target) ? readFileSync(target) : null);
            let content;
            if (file.json !== undefined && /(^|\/)package\.json$/.test(file.path) && existsSync(target)) {
                const current = JSON.parse(readFileSync(target, 'utf8'));
                content = JSON.stringify(mergeManifests(file.json, current), null, 2) + '\n';
                mergedManifest = true;
            }
            else {
                content = entryContent(file);
            }
            const temp = `${target}.gist-restore-${process.pid}`;
            writeFileSync(temp, content, 'utf8');
            renameSync(temp, target);
        }
    }
    catch (e) {
        rollback();
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, restored: backup.files.length, mergedManifest, rollback };
}
