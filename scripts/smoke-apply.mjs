import { Context } from '@deepseek-ai/cordis'
import { name, inject, Config, apply } from '../lib/index.js'

const root = new Context()
// Provide a minimal webServer service (register is a no-op returning a disposer).
root.provide('webServer', {
  register() {
    return () => {}
  },
})

try {
  const result = await root.plugin({ name, inject, Config, apply }, {})
  console.log('APPLY OK — plugin applied without throwing')
  console.log('plugin handle:', typeof result === 'object' && result !== null ? Object.keys(result).filter((k) => typeof result[k] !== 'function').join(',') : typeof result)
} catch (e) {
  console.error('APPLY FAILED:', e.message)
  console.error(e.stack)
  process.exit(1)
}
