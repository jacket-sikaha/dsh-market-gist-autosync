import { type Result } from './config.js';
/** Machine-readable error codes the UI maps to localized messages. */
export type GistErrorCode = 'auth' | 'not_found' | 'rate_limit' | 'invalid' | 'timeout' | 'network' | 'other';
export interface GistHttpResult {
    status: number;
    body: string;
    /** Set when the request never reached a server: timeout or network failure. */
    netError?: string;
    /** Stable code for the netError, when set; mirrors GistErrorCode for the UI. */
    netErrorCode?: GistErrorCode;
}
/** Map a thrown request-level error to a stable code (timeout / network / other). */
export declare function classifyNetError(error: unknown): GistErrorCode;
/**
 * One HTTP round-trip to api.github.com. The 30s hard ceiling always applies
 * (AbortSignal.timeout); when a caller signal is given it is merged with
 * AbortSignal.any so the route-level ceiling wins first and the 30s is the
 * fallback that guarantees termination.
 */
export declare function gistHttp(token: string, method: string, path: string, body?: string, host?: string, signal?: AbortSignal): Promise<GistHttpResult>;
/** Map a GitHub HTTP failure to a typed Result. */
export declare function classify(status: number, body: string): Result;
/** Turn a netError-bearing GistHttpResult into a typed Result. */
/** Turn a netError-bearing GistHttpResult into a typed Result. */
export declare function failNet(r: GistHttpResult): Result;
export declare function createGist(token: string, content: string, host: string, signal?: AbortSignal): Promise<Result>;
export declare function updateGist(token: string, gistId: string, content: string, host: string, signal?: AbortSignal): Promise<Result>;
export declare function verifyToken(token: string, host: string, signal?: AbortSignal): Promise<Result>;
/** Fetch the raw text of the backup file inside a gist. Accepts our filename,
 * dshmarket's filename, or any single file whose content looks like a backup. */
export declare function readGistBackupContent(token: string, gistId: string, host: string, signal?: AbortSignal): Promise<{
    ok: true;
    content: string;
} | {
    ok: false;
    code: string;
    error: string;
}>;
