import { type UploadRecord } from './config.js';
export declare const uploadDomainSpec: import("@deepseek-ai/dsh-storage-domain").DomainSpec;
/** Minimal structural type of an open domain handle (avoid deep generics). */
export interface UploadStore {
    put(record: UploadRecord): Promise<void>;
    list(): UploadRecord[];
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
 * strip them from config.json. Idempotent — config.json without uploads is a
 * no-op.
 */
export declare function migrateLegacyUploads(store: UploadStore): Promise<number>;
