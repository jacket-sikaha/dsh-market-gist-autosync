import { type UploadRecord } from './config.js';
export declare const uploadDomainSpec: import("@deepseek-ai/dsh-storage-domain").DomainSpec;
/** Minimal structural type of an open domain handle (avoid deep generics). */
export interface UploadStore {
    put(record: UploadRecord): Promise<void>;
    list(): UploadRecord[];
    clear(): Promise<void>;
    close(): Promise<void>;
}
/**
 * Open the upload domain through ctx.storageDomain and adapt it to a small
 * store interface. Returns null when the service is unavailable, so callers
 * can fall back to the legacy config.json path.
 */
export declare function openUploadStore(ctx: any): Promise<UploadStore | null>;
/**
 * One-shot migration: move legacy config.json uploads into the domain, then
 * strip the MOVED rows from config.json. Rows that fail the domain's schema
 * check are left in place (kept[] below) instead of being deleted, so a single
 * bad row can never become data loss. Mostly idempotent — moved rows do not
 * come back, but kept rows are retried on every boot until they are fixed or
 * removed by hand.
 */
export declare function migrateLegacyUploads(store: UploadStore): Promise<number>;
