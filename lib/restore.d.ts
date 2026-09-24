import type { FileEntry, ParsedBackup } from './backup.js';
export declare function entryContent(file: FileEntry): string;
/** Merge backup manifest into current: union bundles, overlay deps (current kept, backup wins conflicts). */
export declare function mergeManifests(backupJson: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown>;
/**
 * Dependencies whose spec points at an absolute local path (link:C:/Users/...
 * or file:/home/...) — aligned with dshmarket's unportableDeps (#205).
 *
 * Defined in backup.ts and re-exported here, because the two halves of the
 * cross-machine story must agree on exactly which specs count: the backup half
 * strips them before upload, and the restore half reports any that arrived in a
 * backup written before stripping existed (or by another tool).
 */
export { unportableDeps, type UnportableDep } from './backup.js';
export interface RestoreResult {
    ok: boolean;
    restored?: number;
    mergedManifest?: boolean;
    error?: string;
    /** Roll back every file written by this restore (call on install failure). */
    rollback?: () => void;
}
export declare function restoreBackup(root: string, backup: ParsedBackup): RestoreResult;
