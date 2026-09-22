import type { FileEntry, ParsedBackup } from './backup.js';
export declare function entryContent(file: FileEntry): string;
/** Merge backup manifest into current: union bundles, overlay deps (current kept, backup wins conflicts). */
export declare function mergeManifests(backupJson: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown>;
/**
 * Dependencies whose spec points at an absolute local path (link:C:/Users/...
 * or file:/home/...) — aligned with dshmarket's unportableDeps (#205).
 *
 * Valid on the machine that wrote them, meaningless anywhere else: the path
 * does not exist on the target, so pnpm install cannot satisfy it and the
 * whole restore can fail on it. Reported, NOT rewritten: deciding where
 * those files should live is a design question the operator must answer,
 * not the restore. Relative file:./vendor/x specs are left alone because they
 * resolve against the profile directory, which the restore recreates.
 */
export interface UnportableDep {
    name: string;
    spec: string;
}
export declare function unportableDeps(dependencies: unknown): UnportableDep[];
export interface RestoreResult {
    ok: boolean;
    restored?: number;
    mergedManifest?: boolean;
    error?: string;
    /** Roll back every file written by this restore (call on install failure). */
    rollback?: () => void;
}
export declare function restoreBackup(root: string, backup: ParsedBackup): RestoreResult;
