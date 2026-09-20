/**
 * dsh-market-gist-autosync — 把当前 DSH profile 的配置定时备份到 GitHub Gist。
 *
 * Host 半（Cordis 插件入口）。业务逻辑按职责拆分到同目录模块：
 *   config.ts      配置、路径、常量、token 解析、调度间隔
 *   gist.ts        GitHub Gist HTTP 与 create/update/read
 *   backup.ts      profile 文件收集、备份 envelope、严格校验（对齐 dshmarket）
 *   restore.ts     合并 manifest、原子写回、文件回滚
 *   install.ts     恢复后 pnpm install（含逐插件进度回调）
 *   operations.ts  test/backup/restore 高层编排
 *   rpc.ts         HTTP 工具（sendJson/sameOrigin/readJsonBody）
 *
 * 本文件只做 Cordis 接线：inject、Config schema、apply（定时调度 + RPC 路由）。
 */
import z from '@deepseek-ai/schemastery'
import {
  deviceName,
  activeProfile,
  readBackupConfig,
  writeBackupConfig,
  scheduleIntervalMs,
  GIST_TOKEN_ENV,
  type GistBackupConfig,
} from './config.js'
import { doBackup, doRestore, doTest } from './operations.js'
import { sendJson, sameOrigin, readJsonBody } from './rpc.js'
import type { InstallProgress } from './install.js'
// Re-export test surface so existing scripts keep working.
export { mergeManifests, restoreBackup } from './restore.js'
export { validateBackupStrict, collectProfileBackup, serializeBackup } from './backup.js'
export { installRestoredDeps } from './install.js'

const name = 'dsh-market-gist-autosync'

const inject = ['webServer']

const Config = z.object({
  gistApiHost: z.string().default('api.github.com'),
})

/** Live restore progress, kept in memory for the client to poll. */
interface RestoreProgressState {
  active: boolean
  lines: string[]
  done: boolean
}
let restoreProgress: RestoreProgressState = { active: false, lines: [], done: true }

function progressToLine(p: InstallProgress): string {
  switch (p.phase) {
    case 'probe':
      return p.missing.length > 0 ? `需安装 ${p.missing.length} 个插件：${p.missing.join('、')}` : '依赖均已安装'
    case 'install-all':
      return '正在安装依赖…'
    case 'install-one':
      return `正在安装 ${p.name}（${p.index}/${p.total}）…`
    case 'done-one':
      return `${p.name} ${p.ok ? '✓ 安装成功' : '✗ 安装失败'}`
    default:
      return ''
  }
}

async function apply(ctx: any, rawConfig: any) {
  const apiHost: string = rawConfig?.gistApiHost ?? 'api.github.com'

  let interval: ReturnType<typeof setInterval> | undefined

  const schedule = (cfg: GistBackupConfig) => {
    if (interval) {
      clearInterval(interval)
      interval = undefined
    }
    if (cfg.scheduleEnabled) {
      interval = setInterval(() => {
        doBackup(readBackupConfig(), apiHost)
          .then((r) => {
            if (!r.ok) console.error(`[gist-autosync] scheduled backup failed: ${r.error}`)
          })
          .catch((e) => console.error(`[gist-autosync] scheduled backup error: ${e instanceof Error ? e.message : String(e)}`))
      }, scheduleIntervalMs(cfg))
      interval.unref?.()
    }
  }

  ctx.effect(() => {
    const stop = () => {
      if (interval) {
        clearInterval(interval)
        interval = undefined
      }
    }
    schedule(readBackupConfig())
    return stop
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-market-gist-autosync/rpc',
    handler: async (request: any, response: any) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin' })
      try {
        const body = await readJsonBody(request)
        const action = body.action
        if (action === 'getConfig') {
          const envToken = typeof process.env[GIST_TOKEN_ENV] === 'string' && process.env[GIST_TOKEN_ENV].trim() !== ''
          sendJson(response, 200, { ok: true, config: readBackupConfig(), deviceNameDetected: deviceName(), activeProfile: activeProfile(), envTokenSet: envToken })
        } else if (action === 'saveConfig') {
          const incoming = (body.config as Partial<GistBackupConfig>) || {}
          const cfg = { ...readBackupConfig(), ...incoming }
          cfg.scheduleEnabled = Boolean(cfg.scheduleEnabled)
          cfg.scheduleIntervalValue = Math.max(1, Number(cfg.scheduleIntervalValue) || 24)
          cfg.scheduleIntervalUnit = cfg.scheduleIntervalUnit === 'minute' ? 'minute' : 'hour'
          cfg.includeLock = Boolean(cfg.includeLock)
          writeBackupConfig(cfg)
          schedule(cfg)
          sendJson(response, 200, { ok: true, config: cfg })
        } else if (action === 'testConnection') {
          sendJson(response, 200, await doTest(readBackupConfig(), apiHost))
        } else if (action === 'backupNow') {
          sendJson(response, 200, await doBackup(readBackupConfig(), apiHost))
        } else if (action === 'restore') {
          const gistInput = typeof body.gist === 'string' ? body.gist : ''
          restoreProgress = { active: true, lines: [], done: false }
          const result = await doRestore(readBackupConfig(), apiHost, gistInput, (p) => {
            const line = progressToLine(p)
            if (line) restoreProgress.lines.push(line)
          })
          restoreProgress.done = true
          restoreProgress.active = false
          sendJson(response, 200, { ...result, progressLines: restoreProgress.lines })
        } else if (action === 'restoreProgress') {
          sendJson(response, 200, { ok: true, ...restoreProgress })
        } else if (action === 'listUploads') {
          sendJson(response, 200, { ok: true, uploads: readBackupConfig().uploads || [] })
        } else {
          sendJson(response, 400, { ok: false, code: 'invalid_action', error: 'invalid action' })
        }
      } catch (e) {
        sendJson(response, 400, { ok: false, code: 'other', error: e instanceof Error ? e.message : String(e) })
      }
    },
  })
  // Note: no model tool here. Registering a tool requires the @deepseek-ai/dsh-tools
  // defineTool contract (output { schema, render }) which is easy to get wrong and
  // will abort host boot; the core capability is fully covered by the RPC endpoint
  // above plus self-scheduling. A tool can be added later once the host half is stable.
}

export { name, inject, Config, apply }
