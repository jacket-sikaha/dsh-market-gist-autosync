import z from '@deepseek-ai/schemastery';
/**
 * dsh-market-gist-autosync — 把 DSH 配置定时备份到 GitHub Gist。
 *
 * Host half only for the first minimal version: gist token / gist id 配置、
 * 配置备份（带错误分类）、自持定时备份，全部在一个插件里完成。
 * Client 设置页在后续版本补上；当前通过 RPC + 一个模型工具暴露能力。
 */
declare const name = "dsh-market-gist-autosync";
declare const inject: string[];
declare const Config: z<Schemastery.ObjectS<{
    scheduleIntervalHours: z<number, number>;
    gistApiHost: z<string, string>;
}>, Schemastery.ObjectT<{
    scheduleIntervalHours: z<number, number>;
    gistApiHost: z<string, string>;
}>>;
/**
 * Backup file entry, aligned with dshmarket's `dsh-profile-backup` format:
 * `.json` files carry a parsed `json` object (so a restore can merge
 * dependencies/bundles instead of overwriting); every other text file carries
 * `lines` (content split on newlines). This makes our backups readable and
 * restorable by dshmarket's `validatedBackup` / `restoreProfileBackup`.
 */
interface FileEntry {
    path: string;
    json?: unknown;
    lines?: string[];
}
interface ParsedBackup {
    format: string;
    version: number;
    files: FileEntry[];
}
/** Loose structural validation: accepts our multi-dir backups AND dshmarket's single-profile ones. */
declare function validateBackupShape(value: unknown): string | null;
/** Merge backup manifest into current: union bundles, overlay deps (current kept, backup wins conflicts). */
declare function mergeManifests(backupJson: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown>;
/**
 * Restore a backup into $DSH_HOME with merge semantics + atomic writes + rollback.
 * The current profile's package.json is MERGED (deps overlaid, bundles unioned),
 * never replaced — so existing plugins survive. All other files are overwritten.
 */
declare function restoreBackup(root: string, backup: ParsedBackup): {
    ok: true;
    restored: number;
    mergedManifest: boolean;
} | {
    ok: false;
    code: string;
    error: string;
};
declare function apply(ctx: any, rawConfig: any): Promise<void>;
export { name, inject, Config, apply };
export { mergeManifests, restoreBackup, validateBackupShape };
