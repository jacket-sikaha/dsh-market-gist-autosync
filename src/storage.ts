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
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { MAX_UPLOAD_RECORDS, readBackupConfig, writeBackupConfig, type GistBackupConfig, type UploadRecord } from './config.js'

// NOTE: the domain table schema MUST be zod, not schemastery. The storage
// domain calls `valueSchema.parse(raw)` on open (to re-validate persisted
// records), and schemastery schemas are callable functions with no `.parse`
// — passing one makes every non-empty table fail to reopen ("does not match
// its schema") and the plugin silently falls back to config.json. schemastery
// remains correct for the cordis Config schema in index.ts, which is validated
// by the scope via a direct call, never `.parse`.
const uploadRecordSchema = z.object({
  gistId: z.string(),
  deviceName: z.string(),
  uploadedAt: z.string(),
  status: z.union([z.literal('new'), z.literal('update')]),
  bytes: z.number(),
  // Deliberately z.string(), not a literal union — see UploadRecord.source.
  // An unknown value MUST parse successfully: this table is only validated on
  // reopen, and a single unparseable row fails the whole domain's loadAll(),
  // dropping every record from the UI. The UI renders anything else as "-".
  source: z.string().optional(),
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
  clear(): Promise<void>
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
      // Validate BEFORE writing. The domain's put() stores the value verbatim
      // and only re-validates during loadAll() on the NEXT boot: a bad row
      // would sit there silently, then make the whole domain fail to open —
      // and we would fall back to config.json, which migrateLegacyUploads() has
      // already emptied, so the UI shows zero records with no error at all.
      // Rejecting here keeps the failure attributable to the backup that made it.
      const parsed = uploadRecordSchema.safeParse(record)
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.length > 0 ? i.path.join('.') : 'record'}: ${i.message}`)
          .join('; ')
        console.error(`[gist-autosync] refusing to store upload record: ${detail}`)
        throw new Error(`upload record failed schema validation: ${detail}`)
      }
      // Key by timestamp; ISO strings sort chronologically for trimming.
      await table.put(record.uploadedAt, record)
      // Trim to the newest MAX_UPLOAD_RECORDS. NOTE: keys()/entries() return
      // ITERATORS (the domain re-exposes a snapshot iterator), not arrays —
      // spread before calling .sort()/.map().
      const keys = [...table.keys()].sort()
      const excess = keys.length - MAX_UPLOAD_RECORDS
      for (let i = 0; i < excess; i++) await table.delete(keys[i])
    },
    list() {
      return [...table.entries()]
        .map(([, v]) => v)
        .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))
    },
    async clear() {
      for (const key of table.keys()) await table.delete(key)
    },
    async close() {
      await domain.close()
    },
  }
}

/**
 * One-shot migration: move legacy config.json uploads into the domain, then
 * strip the MOVED rows from config.json. Rows that fail the domain's schema
 * check are left in place (kept[] below) instead of being deleted, so a single
 * bad row can never become data loss. Mostly idempotent — moved rows do not
 * come back, but kept rows are retried on every boot until they are fixed or
 * removed by hand.
 */
export async function migrateLegacyUploads(store: UploadStore): Promise<number> {
  const cfg = readBackupConfig()
  const legacy = Array.isArray(cfg.uploads) ? cfg.uploads : []
  if (legacy.length === 0) return 0
  let moved = 0
  // Rows that fail validation must be KEPT in config.json: they are real history
  // (possibly hand-edited), and listUploads() still reads them from the legacy
  // store. Clearing them along with the migrated ones would turn a schema
  // failure into data loss.
  const kept: UploadRecord[] = []
  for (const u of legacy) {
    if (!u || typeof u.gistId !== 'string') continue
    try {
      await store.put({
        gistId: u.gistId,
        deviceName: u.deviceName || '',
        uploadedAt: u.uploadedAt || u.updatedAt || u.createdAt || new Date().toISOString(),
        status: u.status === 'new' ? 'new' : 'update',
        bytes: typeof u.bytes === 'number' ? u.bytes : 0,
        // Preserve source: the legacy path has no schema gate, so dropping it
        // here would be an invisible downgrade of an otherwise valid record.
        source: u.source,
      })
      moved++
    } catch (e) {
      kept.push(u)
      console.error(
        `[gist-autosync] could not migrate legacy upload ${u.gistId}: ` +
          (e instanceof Error ? e.message : String(e)),
      )
    }
  }
  writeBackupConfig({ ...cfg, uploads: kept })
  return moved
}
