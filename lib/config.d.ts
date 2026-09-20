export declare const name = "dsh-market-gist-autosync";
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
/** The active profile this backup covers (matches the desktop profile dir). */
export declare function activeProfile(): string;
export interface UploadRecord {
    gistId: string;
    deviceName: string;
    uploadedAt: string;
    /** 'new' = created a fresh gist; 'update' = overwrote an existing one. */
    status: 'new' | 'update';
    bytes: number;
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
