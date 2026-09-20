import { type Result } from './config.js';
export interface GistHttpResult {
    status: number;
    body: string;
    netError?: string;
}
export declare function gistHttp(token: string, method: string, path: string, body?: string, host?: string): Promise<GistHttpResult>;
export declare function classify(status: number, body: string): Result;
export declare function createGist(token: string, content: string, host: string): Promise<Result>;
export declare function updateGist(token: string, gistId: string, content: string, host: string): Promise<Result>;
export declare function verifyToken(token: string, host: string): Promise<Result>;
/** Fetch the raw text of the backup file inside a gist. Accepts our filename,
 * dshmarket's filename, or any single file whose content looks like a backup. */
export declare function readGistBackupContent(token: string, gistId: string, host: string): Promise<{
    ok: true;
    content: string;
} | {
    ok: false;
    code: string;
    error: string;
}>;
