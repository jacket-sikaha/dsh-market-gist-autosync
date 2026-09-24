export interface FileEntry {
    path: string;
    json?: unknown;
    lines?: string[];
}
export interface UnportableDep {
    name: string;
    spec: string;
}
/**
 * Dependencies whose spec points at an absolute local path — `link:/Users/…`
 * or `file:C:\…` (aligned with dshmarket's unportableDeps, #205).
 *
 * These are perfectly valid on the machine that wrote them and meaningless
 * anywhere else, so a backup carrying one restores a manifest that `pnpm
 * install` cannot satisfy: the path does not exist on the new machine.
 *
 * Only POSIX-absolute, Windows drive-letter and UNC shapes count. Relative
 * `file:./vendor/x` specs are deliberately excluded: they resolve against the
 * profile directory, which the backup recreates, so they travel fine.
 */
export declare function unportableDeps(dependencies: unknown): UnportableDep[];
/**
 * Strip machine-local dependencies out of a manifest before it is backed up.
 *
 * This is the root-cause fix for cross-machine sync. `link:C:/Users/me/dev/x`
 * is a statement about ONE machine's disk layout, and a shared Gist is read by
 * every machine: leaving it in the backup makes the peer's restore inherit a
 * dependency nothing there can satisfy. The peer's only options are then to
 * fail the install or to prune the dep and drop the bundle row — a local
 * limitation rewritten into shared state, which the next backup carries back.
 *
 * Removing it HERE keeps the Gist a description of the portable composition.
 * The machine that owns the path is not harmed: restore merges manifests as a
 * union (deps overlay, bundles union), so a peer's backup can never take away
 * a dependency the local profile still declares.
 *
 * The bundle rows naming a stripped dep go with it — a row whose package can
 * never be installed fails the boot, which is the failure the pre-check exists
 * to prevent. Stripping both here means the peer never has to clean up after us.
 *
 * @returns the sanitized manifest plus what was removed, for reporting.
 */
export declare function stripMachineLocalDeps(manifest: unknown): {
    json: Record<string, unknown>;
    strippedDeps: UnportableDep[];
    strippedBundles: string[];
};
export interface ParsedBackup {
    format: string;
    version: number;
    createdAt?: string;
    profile?: string;
    files: FileEntry[];
}
export interface CollectResult {
    files: FileEntry[];
    containsSecrets: boolean;
    /** Machine-local deps stripped from the backed-up manifest, for reporting. */
    strippedDeps: UnportableDep[];
    /** Bundle rows dropped with them (a row with no installable package). */
    strippedBundles: string[];
}
export declare function collectProfileBackup(includeLock: boolean): CollectResult;
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
