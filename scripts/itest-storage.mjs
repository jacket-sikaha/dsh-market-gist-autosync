// Storage-domain integration test: mock the ctx.storageDomain facility with an
// in-memory table, then verify the plugin's upload store — put/list ordering,
// 20-record trim, legacy config.json migration, and the null-service fallback.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// isolate config.json BEFORE importing the plugin (DSH_HOME is read lazily, but be safe)
const home = mkdtempSync(join(tmpdir(), 'gist-storage-itest-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'gist-autosync'), { recursive: true })

const lib = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
const { openUploadStore, migrateLegacyUploads, uploadDomainSpec } = lib

// --- in-memory mock of the storageDomain facility --------------------------
// FIDELITY NOTE: mirrors the REAL @deepseek-ai/dsh-storage-domain in the two
// ways that actually bit this plugin:
//  1. keys()/entries() return ITERATORS (not arrays) — callers must spread
//     before .sort()/.map().
//  2. open() re-validates every persisted record through each table's
//     valueSchema via .parse() — so a non-zod schema (schemastery has no
//     .parse) fails the reopen exactly like the real domain.
function mockTable() {
  const map = new Map()
  return {
    async put(k, v) { map.set(k, v) },
    get(k) { return map.get(k) },
    get size() { return map.size },
    keys() { return [...map.keys()][Symbol.iterator]() },
    entries() { return [...map.entries()][Symbol.iterator]() },
    async delete(k) { map.delete(k); return true },
  }
}
function makeFacility() {
  const domains = new Map() // domain name -> table name -> mockTable
  return {
    async open(spec) {
      let byTable = domains.get(spec.name)
      if (!byTable) { byTable = new Map(); domains.set(spec.name, byTable) }
      const handles = {
        table(name) {
          if (!byTable.has(name)) byTable.set(name, mockTable())
          return byTable.get(name)
        },
        async close() {},
      }
      // Re-validate persisted records on open, mirroring the real domain.
      for (const [tableName, tableSpec] of Object.entries(spec.tables)) {
        for (const [key, value] of handles.table(tableName).entries()) {
          tableSpec.valueSchema.parse(value)
        }
      }
      return handles
    },
  }
}
const facility = makeFacility()
const ctx = { get: (k) => (k === 'storageDomain' ? facility : undefined), logger: { info() {} } }

let pass = 0, fail = 0
function check(label, cond) {
  if (cond) { pass++; console.log(`✓ ${label}`) } else { fail++; console.log(`✗ ${label}`) }
}

// 1) domain spec is well-formed
check('domain spec name matches UNIT_NAME_RE', /^[a-z][a-z0-9_]*$/.test(uploadDomainSpec.name))

// 2) open store via mock facility
const store = await openUploadStore(ctx)
check('openUploadStore returns a store', store !== null)

// 3) put + list ordering (newest first)
await store.put({ gistId: 'g1', deviceName: 'PC-A', uploadedAt: '2026-09-20T01:00:00.000Z', status: 'new', bytes: 100 })
await store.put({ gistId: 'g1', deviceName: 'PC-A', uploadedAt: '2026-09-20T02:00:00.000Z', status: 'update', bytes: 200 })
await store.put({ gistId: 'g2', deviceName: 'PC-B', uploadedAt: '2026-09-20T03:00:00.000Z', status: 'new', bytes: 300 })
const list = store.list()
check('list returns newest first', list[0].gistId === 'g2' && list[2].gistId === 'g1')
check('record fields intact', list[0].deviceName === 'PC-B' && list[0].status === 'new' && list[0].bytes === 300)

// 4) trim to 20
for (let i = 0; i < 25; i++) {
  await store.put({ gistId: `gx${i}`, deviceName: 'PC-A', uploadedAt: `2026-09-21T00:${String(i).padStart(2, '0')}:00.000Z`, status: 'update', bytes: i })
}
check('trims to 20 records', store.list().length === 20)

// 4b) reopen the SAME domain (simulates a second boot) — persisted records
// must survive the schema re-validation. Regression guard for the
// schemastery-vs-zod bug: a schemastery schema has no `.parse`, so the real
// domain (and this faithful mock) throws here.
const reopened = await openUploadStore(ctx)
check('reopen re-validates persisted records (zod schema)', reopened !== null)
check('reopened store lists persisted records', reopened.list().length === 20)

// 5) migration from legacy config.json — fresh store so the 20-cap trim from
// step 4 does not immediately evict the older migrated records.
const facility2 = makeFacility()
const ctx2 = { get: (k) => (k === 'storageDomain' ? facility2 : undefined), logger: { info() {} } }
const store2 = await openUploadStore(ctx2)
writeFileSync(join(home, 'gist-autosync', 'config.json'), JSON.stringify({
  gistToken: '', gistId: 'abc',
  uploads: [
    { gistId: 'old1', gistUrl: 'https://gist.github.com/old1', bytes: 42, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T01:00:00.000Z' },
    { gistId: 'old2', gistUrl: 'https://gist.github.com/old2', bytes: 55, createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T01:00:00.000Z' },
  ],
}, null, 2), 'utf8')
const moved = await migrateLegacyUploads(store2)
check('migrated 2 legacy records', moved === 2)
const afterCfg = JSON.parse(readFileSync(join(home, 'gist-autosync', 'config.json'), 'utf8'))
check('config.json uploads cleared after migration', Array.isArray(afterCfg.uploads) && afterCfg.uploads.length === 0)
const old1 = store2.list().find((r) => r.gistId === 'old1')
check('migrated record has status field', old1 !== undefined && (old1.status === 'new' || old1.status === 'update'))
check('migrated record uses updatedAt as uploadedAt', old1 !== undefined && old1.uploadedAt === '2026-09-01T01:00:00.000Z')
const movedAgain = await migrateLegacyUploads(store2)
check('migration idempotent (0 moved again)', movedAgain === 0)

// 6) fallback when service unavailable
const nullStore = await openUploadStore({ get: () => undefined })
check('openUploadStore returns null without service', nullStore === null)

// 7) clear wipes every record
check('store2 has records before clear', store2.list().length > 0)
await store2.clear()
check('clear() empties the store', store2.list().length === 0)

await store.close()
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} storage-domain cases`)
process.exit(fail === 0 ? 0 : 1)
