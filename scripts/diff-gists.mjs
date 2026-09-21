// Diff two gist backup profiles: fetch both via GitHub API (using the token
// from the live config.json) and compare their file trees + per-file content.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import https from 'node:https'
import os from 'node:os'

const home = process.env.DSH_HOME || join(os.homedir(), '.dsh')
const cfg = JSON.parse(readFileSync(join(home, 'gist-autosync', 'config.json'), 'utf8'))
const token = cfg.gistToken

if (!token) {
  console.error('no token in config.json')
  process.exit(1)
}

function getJson(token, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.github.com', path, method: 'GET', headers: { authorization: `Bearer ${token}`, 'user-agent': 'dsh-gist-diff', accept: 'application/vnd.github+json' } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// find our backup file inside a gist files map
function backupContent(data) {
  const files = data.files || {}
  for (const [name, f] of Object.entries(files)) {
    if (typeof f?.content === 'string' && (name === 'dsh-profile-backup.json' || f.content.includes('"dsh-profile-backup"'))) {
      return { name, content: f.content }
    }
  }
  return null
}

const [a, b] = process.argv.slice(2)
const aId = a.split('/').pop()
const bId = b.split('/').pop()

const ra = await getJson(token, `/gists/${aId}`)
const rb = await getJson(token, `/gists/${bId}`)

if (ra.status !== 200 || rb.status !== 200) {
  console.error(`fetch failed: a=${ra.status} b=${rb.status}`)
  if (ra.status !== 200) console.error('a body:', ra.body.slice(0, 300))
  if (rb.status !== 200) console.error('b body:', rb.body.slice(0, 300))
  process.exit(1)
}

const da = JSON.parse(ra.body)
const db = JSON.parse(rb.body)
const ca = backupContent(da)
const cb = backupContent(db)

if (!ca || !cb) {
  console.error('backup file not found in one/both gists')
  process.exit(1)
}

const ba = JSON.parse(ca.content)
const bb = JSON.parse(cb.content)

console.log(`A (${aId})  format=${ba.format} createdAt=${ba.createdAt} profile=${ba.profile}`)
console.log(`B (${bId})  format=${bb.format} createdAt=${bb.createdAt} profile=${bb.profile}`)
console.log('')

// index files by path (normalize: package.json is {path, json}, others {path, lines})
function index(bu) {
  const m = new Map()
  for (const f of bu.files || []) m.set(f.path, f)
  return m
}
const fa = index(ba)
const fb = index(bb)
const allPaths = new Set([...fa.keys(), ...fb.keys()])

let changed = 0
for (const p of [...allPaths].sort()) {
  const x = fa.get(p)
  const y = fb.get(p)
  if (!x) { console.log(`[A only]   + ${p}`); changed++; continue }
  if (!y) { console.log(`[B only]   - ${p}`); changed++; continue }
  const cx = x.json !== undefined ? JSON.stringify(x.json, null, 2) : (x.lines || []).join('\n')
  const cy = y.json !== undefined ? JSON.stringify(y.json, null, 2) : (y.lines || []).join('\n')
  if (cx !== cy) {
    changed++
    console.log(`[CHANGED]  ~ ${p}`)
    // show a compact line-level diff
    const lx = cx.split('\n')
    const ly = cy.split('\n')
    const max = Math.max(lx.length, ly.length)
    for (let i = 0; i < max; i++) {
      const l = lx[i]
      const r = ly[i]
      if (l !== r) {
        if (l !== undefined) console.log(`  A${String(i + 1).padStart(3)}: ${l}`)
        if (r !== undefined) console.log(`  B${String(i + 1).padStart(3)}: ${r}`)
      }
    }
  }
}

console.log('')
console.log('files: A=' + ba.files.length + ' B=' + bb.files.length + ', changed=' + changed)
console.log('')
console.log('A updated_at:', da.updated_at)
console.log('B updated_at:', db.updated_at)
console.log('文件清单:')
for (const p of [...allPaths].sort()) {
  const x = fa.get(p) || fb.get(p)
  const kind = x.json !== undefined ? 'json' : 'lines(' + (x.lines || []).length + ')'
  const inA = fa.has(p) ? '✓' : '-'
  const inB = fb.has(p) ? '✓' : '-'
  console.log(`  A=${inA} B=${inB}  ${p}  [${kind}]`)
}
