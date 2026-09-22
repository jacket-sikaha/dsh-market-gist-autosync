import { defineConfig } from 'vite'

/**
 * Host-half bundling for the DSH plugin.
 *
 * Constraints imposed by the DSH plugin loader (cordis-plugin-loader):
 * - The bundle entry is loaded with a native ESM `import()`, so output MUST be
 *   a single ES module at lib/index.js.
 * - `node:*` builtins and the peer dependency `@deepseek-ai/schemastery` are
 *   provided by the host at runtime — they must stay external (bare imports),
 *   never inlined into the bundle.
 * - The client half (client/client.js) is NOT built here: the DSH client
 *   loader requires the hand-written `window.__ModuleLoader__.load()` wrapper
 *   format, which is already plain JS and gains nothing from bundling.
 *
 * Vite 8 (rolldown) is used deliberately: its native bundler runs in-process,
 * unlike esbuild's spawned service which is blocked in some sandboxes (EPERM).
 */
export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'lib',
    emptyOutDir: true,
    // Keep the bundle readable: stack traces in the DSH host must map to
    // something a human can debug, and the size win is irrelevant here.
    minify: false,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: (id) =>
        id.startsWith('node:') ||
        id === '@deepseek-ai/schemastery' ||
        id === '@deepseek-ai/dsh-storage-domain' ||
        id === 'zod' ||
        id.startsWith('@deepseek-ai/cordis'),
      output: {
        // Deterministic single-file output; no code splitting (the loader
        // imports exactly lib/index.js).
        codeSplitting: false,
      },
    },
  },
})
