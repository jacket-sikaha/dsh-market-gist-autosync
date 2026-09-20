/**
 * Upload-record persistence via the official storage stack
 * (@deepseek-ai/dsh-storage-domain over the json backend mounted by dsh-base).
 *
 * Upload history is operational data — machine-generated, append-only — so it
 * does NOT belong in the plugin Config (method 1: scope.update restarts the
 * whole plugin per write) nor in a hand-rolled file when the host already
 * provides a schema-validated, crash-safe KV store. Sensitive settings stay in
 * config.json; only these non-sensitive history records live here.
 *
 * Falls back to the legacy config.json `uploads` array when the storageDomain
 * service is unavailable (a host without dsh-base's storage layer).
 */
import z from '@deepseek-ai/schemastery'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { MAX_UPLOAD_RECORDS, readBackupConfig, writeBackupConfig, type GistBackupConfig, type UploadRecord } from './config.js'

const uploadRecordSchema = z.object({
  gistId: z.string(),
  deviceName: z.string(),
  uploadedAt: z.string(),
  status: z.union([z.const('new'), z.const('update')]),
  bytes: z.number(),
})

export const uploadDomainSpec = defineDomain({
  name: 'gist_autosync',
  version: 1,
  tables: { uploads: domainTable(uploadRecordSchema) },
})

/** Minimal structural type of an open domain handle (avoid deep generics). */
export interface UploadStore {
  put(record: UploadRecord): Promise<void>
  list(): UploadRecord[]
  close(): Promise<void>
}

/**
 * Open the upload domain through ctx.storageDomain and adapt it to a small
 * store interface. Returns null when the service is unavailable, so callers
 * can fall back to the legacy config.json path.
 */
export async function openUploadStore(ctx: any): Promise<UploadStore | null> {
  const facility = ctx.get('storageDomain')
  if (facility === undefined) return null
  const domain = await facility.open(uploadDomainSpec)
  const table = domain.table('uploads')
  return {
    async put(record) {
      // Key by timestamp; ISO strings sort chronologically for trimming.
      await table.put(record.uploadedAt, record)
      // Trim to the newest MAX_UPLOAD_RECORDS.
      const keys = (table.keys() as string[]).sort()
      const excess = keys.length - MAX_UPLOAD_RECORDS
      for (let i = 0; i < excess; i++) await table.delete(keys[i])
    },
    list() {
      return (table.entries() as [string, UploadRecord][])
        .map(([, v]) => v)
        .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))
    },
    async close() {
      await domain.close()
    },
  }
}

/**
 * One-shot migration: move legacy config.json uploads into the domain, then
 * strip them from config.json. Idempotent — config.json without uploads is a
 * no-op.
 */
export async function migrateLegacyUploads(store: UploadStore): Promise<number> {
  const cfg = readBackupConfig()
  const legacy = Array.isArray(cfg.uploads) ? cfg.uploads : []
  if (legacy.length === 0) return 0
  let moved = 0
  for (const u of legacy) {
    if (!u || typeof u.gistId !== 'string') continue
    await store.put({
      gistId: u.gistId,
      deviceName: u.deviceName || '',
      uploadedAt: u.uploadedAt || u.updatedAt || u.createdAt || new Date().toISOString(),
      status: u.status === 'new' ? 'new' : 'update',
      bytes: typeof u.bytes === 'number' ? u.bytes : 0,
    })
    moved++
  }
  const next: GistBackupConfig = { ...cfg, uploads: [] }
  writeBackupConfig(next)
  return moved
}
