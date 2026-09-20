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
export declare function doBackup(cfg: GistBackupConfig, host: string): Promise<Result>;
export declare function doRestore(cfg: GistBackupConfig, host: string, gistInput: string, onProgress?: ProgressFn): Promise<Result>;
