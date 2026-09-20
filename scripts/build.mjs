import { execSync } from 'node:child_process'

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
