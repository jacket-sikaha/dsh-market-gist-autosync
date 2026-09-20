/**
 * High-level operations the RPC handler exposes: test connection, backup now,
 * restore from a gist. These compose the config / gist / backup / restore /
 * install modules and own the cross-cutting concerns (token resolution,
 * gistId persistence, upload records, install-failure rollback).
 */
import { type GistBackupConfig, type Result } from './config.js';
import { type InstallProgress } from './install.js';
export type ProgressFn = (p: InstallProgress) => void;
export declare function doTest(cfg: GistBackupConfig, host: string): Promise<Result>;
/**
 * gistOverride: when provided (including the empty string), it is the source of
 * truth for which gist to update — the UI field value, so "clear the field and
 * back up" really creates a fresh gist. undefined = use cfg.gistId (scheduled
 * backups, which have no UI context).
 */
export declare function doBackup(cfg: GistBackupConfig, host: string, gistOverride?: string): Promise<Result>;
export declare function doRestore(cfg: GistBackupConfig, host: string, gistInput: string, onProgress?: ProgressFn): Promise<Result>;
