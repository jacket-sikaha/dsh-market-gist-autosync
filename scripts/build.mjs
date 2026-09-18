import { execSync } from 'node:child_process'

// Use tsc: esbuild's native service spawn is blocked in some sandboxes (EPERM),
// and our source is plain TS with no bundling requirement — schemastery/cordis
// are peer deps resolved at runtime by the DSH loader.
try {
  execSync('npx --no-install tsc -p tsconfig.json', { stdio: 'inherit' })
} catch (e) {
  // tsc already printed diagnostics; exit non-zero
  process.exit(1)
}
console.log('built lib/index.js')
