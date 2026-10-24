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
/** Collect this profile's configuration. Nothing about it is configurable: the
 * exclusion list matches dshmarket's, so both tools back up the same files. */
export declare function collectProfileBackup(): CollectResult;
/** The exact text a file entry becomes in the serialized backup (and on disk). */
export declare function entryText(file: FileEntry): string;
/**
 * The largest entries in a serialized backup, so a size error can name what to
 * drop instead of only stating the total.
 */
export declare function largestBackupEntries(files: FileEntry[], limit?: number): {
    path: string;
    bytes: number;
}[];
/** Serialize the backup with 2-space indent so it reads well on the Gist web UI. */
export declare function serializeBackup(backup: unknown): string;
export declare function buildBackupEnvelope(files: FileEntry[]): ParsedBackup;
export type BackupFileTier = 'primary' | 'secondary';
export declare function backupFileTier(path: string): BackupFileTier;
export interface BackupPreviewEntry {
    path: string;
    bytes: number;
    tier: BackupFileTier;
}
export interface BackupPlugin {
    name: string;
    /**
     * The spec the manifest declares — exactly what `pnpm install` resolves on
     * restore, so `^1.70.1` stays a range rather than being flattened to a
     * version. Empty when the bundle is provided by the host and not listed in
     * `dependencies`.
     */
    version: string;
}
/**
 * The plugins this backup actually carries: the declared bundles (what the
 * profile boots) joined with their dependency specs. Dependencies that are not
 * bundles are left out on purpose — those are the plugins' own dependencies,
 * not plugins, and listing them would turn a 30-line answer into a 200-line one.
 */
export declare function backupPlugins(files: FileEntry[]): BackupPlugin[];
export interface BackupPreview {
    profileName: string;
    fileCount: number;
    /** Serialized bytes, i.e. what the Gist upload would actually weigh. */
    totalBytes: number;
    entries: BackupPreviewEntry[];
    /** Plugins a restore would reinstall, name + declared spec. */
    plugins: BackupPlugin[];
}
/**
 * What the next backup would contain, without uploading anything. Same collection
 * path as doBackup, so the sizes shown are the sizes that would be sent.
 */
export declare function previewProfileBackup(): BackupPreview;
/**
 * Strict structural validation aligned with dshmarket's validatedBackup:
 * - format is exactly BACKUP_FORMAT and version exactly BACKUP_VERSION
 * - files is an array of at most MAX_BACKUP_FILES entries
 * - path is non-empty, not absolute, no `..` segments, no PROFILE_SKIP segments,
 *   no duplicates
 * - package.json is REQUIRED and must be a json object; every other entry must
 *   be `lines` of strings
 * - the whole backup stays under MAX_BACKUP_BYTES
 * Returns an error message phrased as what happened / why / what to do next, or
 * null when valid.
 */
export declare function validateBackupStrict(value: unknown): string | null;
