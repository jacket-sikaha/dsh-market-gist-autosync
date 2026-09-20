export interface FileEntry {
    path: string;
    json?: unknown;
    lines?: string[];
}
export interface ParsedBackup {
    format: string;
    version: number;
    createdAt?: string;
    profile?: string;
    files: FileEntry[];
}
export declare function collectProfileBackup(includeLock: boolean): {
    files: FileEntry[];
    containsSecrets: boolean;
};
/** Serialize the backup with 2-space indent so it reads well on the Gist web UI. */
export declare function serializeBackup(backup: unknown): string;
export declare function buildBackupEnvelope(files: FileEntry[]): ParsedBackup;
/**
 * Strict structural validation aligned with dshmarket's validatedBackup:
 * - format is a string, files is an array
 * - path is non-empty, not absolute, no `..` segments
 * - no SKIP_NAMES segments, no duplicate paths
 * - package.json (if present as json) must be a plain object; lines must be strings
 * Returns an error message, or null when valid.
 */
export declare function validateBackupStrict(value: unknown): string | null;
