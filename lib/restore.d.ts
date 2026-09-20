import type { FileEntry, ParsedBackup } from './backup.js';
export declare function entryContent(file: FileEntry): string;
/** Merge backup manifest into current: union bundles, overlay deps (current kept, backup wins conflicts). */
export declare function mergeManifests(backupJson: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown>;
export interface RestoreResult {
    ok: boolean;
    restored?: number;
    mergedManifest?: boolean;
    error?: string;
    /** Roll back every file written by this restore (call on install failure). */
    rollback?: () => void;
}
export declare function restoreBackup(root: string, backup: ParsedBackup): RestoreResult;
