export declare const name = "dsh-market-gist-autosync";
export declare function writeFileAtomic(file: string, content: string | Buffer): void;
export declare const CONFIG_DIR = "gist-autosync";
export declare const CONFIG_FILE = "config.json";
export declare const GIST_FILENAME = "dsh-profile-backup.json";
export declare const GIST_MAX_BYTES: number;
export declare const REQUEST_TIMEOUT_MS = 30000;
export declare const GIST_ID_RE: RegExp;
export declare const GIST_TOKEN_ENV = "DSH_GITHUB_TOKEN";
/** dshmarket backup format constants — kept identical so backups interoperate. */
export declare const BACKUP_FORMAT = "dsh-profile-backup";
export declare const BACKUP_VERSION = 0.2;
export declare const MAX_BACKUP_FILES = 256;
export declare const PROFILE_SKIP: Set<string>;
export declare const MAX_UPLOAD_RECORDS = 20;
export declare function initProfileContext(ctx: {
    get?: (key: string) => unknown;
}): void;
/** The active profile this backup covers (the profile this host booted). */
export declare function activeProfile(): string;
export interface UploadRecord {
    gistId: string;
    deviceName: string;
    uploadedAt: string;
    /**
     * 'new' = created a fresh gist; 'update' = overwrote an existing one;
     * 'failed' = the backup attempt failed (see `error`). Recording failures is
     * what makes a broken backup chain visible in the UI instead of silent.
     */
    status: 'new' | 'update' | 'failed';
    bytes: number;
    /** Failure message when status is 'failed'. */
    error?: string;
    /**
     * Who triggered this backup: the schedule timer or a manual click.
     *
     * Deliberately `string`, NOT a `'scheduled' | 'manual'` union. This field is
     * stored in the storage domain, whose put() writes verbatim and only
     * re-validates on reopen — a literal union would make any FUTURE value (e.g.
     * "api") unparseable by THIS version, and one unparseable row fails the whole
     * domain's loadAll(), dropping every record from the UI. So reading stays
     * lenient, and the UI renders unknown values as "-". Writers remain
     * type-safe: doBackup() still accepts only 'scheduled' | 'manual'.
     *
     * Optional for backward compatibility with records written before the field
     * existed — the UI renders those as "-" too.
     */
    source?: string;
    /** Legacy fields kept optional so pre-domain config.json still parses. */
    gistUrl?: string;
    createdAt?: string;
    updatedAt?: string;
}
export interface GistBackupConfig {
    gistToken: string;
    gistId: string;
    deviceName: string;
    scheduleEnabled: boolean;
    /** Schedule interval magnitude + unit (minute-granularity). */
    scheduleIntervalValue: number;
    scheduleIntervalUnit: 'minute' | 'hour';
    /** Optional extras to fold into the backup beyond the dshmarket core set. */
    includeLock: boolean;
    uploads: UploadRecord[];
}
export declare const DEFAULTS: GistBackupConfig;
export type Result = {
    ok: true;
    [k: string]: unknown;
} | {
    ok: false;
    code: string;
    error: string;
};
export declare function err(code: string, error: string): Result;
export declare function dshHome(): string;
export declare function profileRoot(): string;
export declare function configDirPath(): string;
export declare function configFilePath(): string;
export declare function readBackupConfig(): GistBackupConfig;
export declare function writeBackupConfig(cfg: GistBackupConfig): void;
export declare function deviceName(): string;
export declare function parseGistId(input: string): string;
/** Resolve the Gist token, env first (DSH_GITHUB_TOKEN), config value as fallback. */
export declare function resolveToken(cfg: GistBackupConfig): {
    token: string;
    source: 'env' | 'config';
} | null;
/** Schedule interval in ms (minute-granularity). */
export declare function scheduleIntervalMs(cfg: GistBackupConfig): number;
