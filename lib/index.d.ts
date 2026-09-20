import z from '@deepseek-ai/schemastery';
declare const name = "dsh-market-gist-autosync";
declare const inject: string[];
declare const Config: z<Schemastery.ObjectS<{
    gistApiHost: z<string, string>;
}>, Schemastery.ObjectT<{
    gistApiHost: z<string, string>;
}>>;
interface FileEntry {
    path: string;
    json?: unknown;
    lines?: string[];
}
declare function collectProfileBackup(includeLock: boolean): {
    files: FileEntry[];
    containsSecrets: boolean;
};
/** Serialize the backup with 2-space indent so it reads well on the Gist web UI. */
declare function serializeBackup(backup: unknown): string;
interface ParsedBackup {
    format: string;
    version: number;
    files: FileEntry[];
}
/** Loose structural validation accepting both our and dshmarket's backups. */
declare function validateBackupShape(value: unknown): string | null;
/** Merge backup manifest into current: union bundles, overlay deps (current kept, backup wins conflicts). */
declare function mergeManifests(backupJson: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown>;
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
export { mergeManifests, restoreBackup, validateBackupShape, collectProfileBackup, serializeBackup };
