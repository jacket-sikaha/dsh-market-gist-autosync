import { execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Build = Vite 8 (rolldown) bundles the host half into a single ESM file at
// lib/index.js, then tsc emits type declarations only.
//
// Why vite: rolldown's native bundler runs in-process (no esbuild service
// spawn, which some sandboxes block with EPERM), and single-file output keeps
// the DSH loader contract trivial — it imports exactly lib/index.js.
try {
  execSync('npx --no-install vite build', { stdio: 'inherit' })
  execSync('npx --no-install tsc -p tsconfig.json --emitDeclarationOnly', { stdio: 'inherit' })
} catch (e) {
  process.exit(1)
}
console.log('built lib/index.js (vite) + lib/*.d.ts (tsc)')

// The Plugins page renders package.json.icon for installed rows (DSH >= 0.1.7).
// A missing field, an absolute path, an extension outside svg/png/jpg/jpeg/webp,
// an asset over 256 KB, or one that never ships in the npm tarball all turn that
// row into meta.error instead of a quiet placeholder — so the host contract is
// enforced at build time rather than discovered after publish.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
const ICON_MAX_BYTES = 256 * 1024

const problems = []
const icon = manifest.icon
if (typeof icon !== 'string' || icon.trim() === '') {
  problems.push('package.json is missing a top-level "icon" path')
} else {
  const abs = resolve(root, icon)
  const shipped = Array.isArray(manifest.files) && manifest.files.some((entry) => {
    if (typeof entry !== 'string' || entry === '') return false
    const dir = entry.replace(/\\/g, '/').replace(/\/$/, '')
    if (dir === '') return false
    const target = icon.replace(/\\/g, '/')
    return target === dir || target.startsWith(`${dir}/`)
  })
  if (isAbsolute(icon)) problems.push(`icon must be relative, got ${JSON.stringify(icon)}`)
  else if (!ICON_EXTENSIONS.has(extname(icon).toLowerCase())) {
    problems.push(`icon must end in .svg/.png/.jpg/.jpeg/.webp, got ${JSON.stringify(icon)}`)
  } else if (!existsSync(abs)) problems.push(`icon file is missing: ${icon}`)
  else if (statSync(abs).size > ICON_MAX_BYTES) {
    problems.push(`icon is ${statSync(abs).size} bytes; the host limit is ${ICON_MAX_BYTES}`)
  }
  if (!shipped) problems.push(`package.json.files must include ${icon} (or its directory)`)
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`packaging: ${problem}`)
  process.exit(1)
}
console.log(`packaging: icon ${icon} (${statSync(resolve(root, icon)).size} bytes) ships with the package`)
