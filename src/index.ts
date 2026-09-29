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
import { createRequire } from "node:module";
import z from "@deepseek-ai/schemastery";
import {
  deviceName,
  activeProfile,
  initProfileContext,
  readBackupConfig,
  writeBackupConfig,
  scheduleIntervalMs,
  GIST_TOKEN_ENV,
  MAX_UPLOAD_RECORDS,
  err,
  type GistBackupConfig,
  type UploadRecord,
} from "./config.js";
import { doBackup, doRestore, doTest } from "./operations.js";
import { sendJson, sameOrigin, readJsonBody } from "./rpc.js";
import {
  openUploadStore,
  migrateLegacyUploads,
  type UploadStore,
} from "./storage.js";
import type { InstallProgress } from "./install.js";
// Re-export test surface so existing scripts keep working.
export { mergeManifests, restoreBackup } from "./restore.js";
export {
  validateBackupStrict,
  collectProfileBackup,
  serializeBackup,
  unportableDeps,
  stripMachineLocalDeps,
} from "./backup.js";
export { installRestoredDeps } from "./install.js";
export {
  openUploadStore,
  migrateLegacyUploads,
  uploadDomainSpec,
} from "./storage.js";
export { initProfileContext, activeProfile } from "./config.js";
export {
  analyzeBundles,
  orphanBundles,
  removeBundles,
  findDshInstallDir,
  INBOX_BUNDLES,
} from "./analyze.js";

const name = "dsh-market-gist-autosync";

// 插件自身版本号：直接读包根 package.json，发版只改一处（package.json）。
// lib/index.js 由 vite 打包为单文件，运行时位于 <pluginRoot>/lib/，
// createRequire 按文件位置解析 ../package.json，正是已安装插件的根目录。
function pluginVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json") as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}
const VERSION = pluginVersion();

const inject = ["webServer"];

const Config: z<{ gistApiHost: string }> = z.object({
  gistApiHost: z.string().default("api.github.com"),
});

/** Live restore progress, kept in memory for the client to poll. */
interface RestoreProgressState {
  active: boolean;
  lines: string[];
  done: boolean;
}
let restoreProgress: RestoreProgressState = {
  active: false,
  lines: [],
  done: true,
};

/**
 * Backup mutex. A backup collects the live profile and PATCHes a single gist:
 * two concurrent backups race the same file, and a "create fresh gist" run
 * racing a scheduled "update" run can spawn a second orphan gist whose id
 * then overwrites the real one in config.json. Scheduled runs SKIP (log +
 * skip this tick); manual runs are rejected so the UI can surface the clash.
 */
let backupInFlight = false;

function progressToLine(p: InstallProgress): string {
  switch (p.phase) {
    case "probe":
      return p.missing.length > 0
        ? `需安装 ${p.missing.length} 个插件：${p.missing.join("、")}`
        : "依赖均已安装";
    case "install-all":
      return "正在安装依赖…";
    case "install-one":
      return `正在安装 ${p.name}（${p.index}/${p.total}）…`;
    case "done-one":
      return `${p.name} ${p.ok ? "✓ 安装成功" : "✗ 安装失败"}`;
    default:
      return "";
  }
}

async function apply(ctx: any, rawConfig: any) {
  const apiHost: string = rawConfig?.gistApiHost ?? "api.github.com";

  // Resolve the booted profile (desktopProfiles on Desktop, --profile argv on
  // plain dsh web) BEFORE anything reads activeProfile()/profileRoot().
  initProfileContext(ctx);

  let interval: ReturnType<typeof setInterval> | undefined;
  /** ETA (epoch ms) of the next scheduled backup, null when the timer is off. */
  let nextRunAt: number | null = null;

  // Upload records live in the dsh-storage domain (schema-validated, crash-safe
  // KV), not in the settings file.
  //
  // The domain service is PROVIDED ASYNCHRONOUSLY by @deepseek-ai/dsh-storage-domain
  // (it waits for its own storage backend via ctx.inject before calling
  // provide('storageDomain')). A one-shot ctx.get() at apply() time therefore
  // races that provisioning: when it loses, the plugin used to fall back to
  // config.json permanently and records split across the two stores. Retry
  // until the service appears, so the store is opened once it is available.
  const STORAGE_OPEN_RETRY_MS = 250;
  const STORAGE_OPEN_TIMEOUT_MS = 15_000;
  const openStoreWhenReady = async (): Promise<UploadStore | null> => {
    const deadline = Date.now() + STORAGE_OPEN_TIMEOUT_MS;
    for (;;) {
      // The service is provided asynchronously; retry silently until it shows.
      if (ctx.get("storageDomain") === undefined) {
        if (Date.now() >= deadline) {
          console.error(
            "[gist-autosync] storage domain service never appeared, falling back to config.json",
          );
          return null;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, STORAGE_OPEN_RETRY_MS),
        );
        continue;
      }
      // Service is present: an open failure is deterministic (schema/backend),
      // not a provisioning race — fail once, don't spam retries.
      try {
        const store = await openUploadStore(ctx);
        if (store) {
          const moved = await migrateLegacyUploads(store);
          if (moved > 0)
            ctx.logger?.info?.(
              "migrated legacy upload record(s) into the storage domain",
            );
          return store;
        }
        return null;
      } catch (e) {
        console.error(
          "[gist-autosync] storage domain open failed, falling back to config.json: " +
            (e instanceof Error ? e.message : String(e)),
        );
        return null;
      }
    }
  };
  const storePromise: Promise<UploadStore | null> = openStoreWhenReady();

  /**
   * Upload records, MERGED from both stores.
   *
   * The domain is the destination, but config.json rows written by an earlier
   * layout (or by a boot that lost the provisioning race before this fix) are
   * still real history and must not disappear from the UI. Merge by
   * (gistId, uploadedAt) and keep the newest MAX_UPLOAD_RECORDS.
   */
  const listUploads = async (): Promise<UploadRecord[]> => {
    const legacy = (readBackupConfig().uploads || []).filter(
      (u) => typeof u?.gistId === "string",
    );
    const store = await storePromise;
    if (!store) return legacy;
    const seen = new Set<string>();
    const merged: UploadRecord[] = [];
    for (const u of [...store.list(), ...legacy]) {
      const key = u.gistId + "|" + u.uploadedAt;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(u);
    }
    merged.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
    return merged.slice(0, MAX_UPLOAD_RECORDS);
  };

  /** Persist the record doBackup produced (store when available, else legacy). */
  const recordUpload = async (record: UploadRecord): Promise<void> => {
    const store = await storePromise;
    if (store) {
      await store.put(record);
    } else {
      const cfg = readBackupConfig();
      writeBackupConfig({
        ...cfg,
        uploads: [record, ...(cfg.uploads || [])].slice(0, 20),
      });
    }
  };

  /**
   * doBackup + record persistence, shared by the timer and the RPC.
   *
   * Mutex: only one backup at a time. Scheduled runs that collide are
   * skipped (returning a no-op Result with code 'backup_in_progress'); manual
   * runs that collide are rejected the same way so the UI can toast it.
   *
   * Failure recording: when doBackup returns !ok, we persist a 'failed' record
   * so the broken backup chain is visible in the upload-history UI instead of
   * only in a console.error nobody reads. The gistId on a failure is the
   * configured one (or '-' when none is saved yet) — the attempt never reached
   * GitHub, so there is no real id to record.
   */
  const runBackup = async (
    gistOverride?: string,
    source: "scheduled" | "manual" = "manual",
  ) => {
    if (backupInFlight) {
      // A skip, not a failure: do not pollute the history with a red row.
      return err("backup_in_progress", "已有备份操作正在进行，请稍后再试");
    }
    backupInFlight = true;
    try {
      const cfg = readBackupConfig();
      const r = await doBackup(cfg, apiHost, gistOverride, source);
      // On success, persist the success record doBackup produced.
      if (r.ok && r.record) {
        try {
          await recordUpload(r.record as UploadRecord);
        } catch (e) {
          console.error(
            `[gist-autosync] failed to record upload: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return r;
      }
      // On failure, persist a 'failed' record so the gap is visible in the
      // UI history instead of silently swallowed. The configured gistId is
      // the best label we have (the attempt may not have reached GitHub).
      //
      // Type narrowing: Result's ok:true branch carries an index signature
      // ([k: string]: unknown), so a successful-but-recordless result leaves
      // r typed as the success branch where .error is unknown. Guard with
      // !r.ok so TS knows we are in the error branch where .error is string.
      if (!r.ok) {
        const failed: UploadRecord = {
          gistId: (gistOverride ?? cfg.gistId).trim() || "-",
          deviceName: cfg.deviceName.trim() || deviceName(),
          uploadedAt: new Date().toISOString(),
          status: "failed",
          bytes: 0,
          source,
          error: r.error,
        };
        try {
          await recordUpload(failed);
        } catch (e) {
          console.error(
            `[gist-autosync] failed to record failed upload: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return r;
    } finally {
      backupInFlight = false;
    }
  };

  /** Wipe upload history (domain store when available, else legacy file). */
  const clearUploads = async (): Promise<void> => {
    const store = await storePromise;
    if (store) {
      await store.clear();
    } else {
      const cfg = readBackupConfig();
      writeBackupConfig({ ...cfg, uploads: [] });
    }
  };

  const schedule = (cfg: GistBackupConfig) => {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
    nextRunAt = null;
    if (cfg.scheduleEnabled) {
      const ms = scheduleIntervalMs(cfg);
      // Track the ETA of the next scheduled run so the UI can show it.
      // Updated again on every tick — the interval keeps firing.
      nextRunAt = Date.now() + ms;
      interval = setInterval(() => {
        nextRunAt = Date.now() + ms;
        runBackup(undefined, "scheduled")
          .then((r) => {
            if (!r.ok)
              console.error(
                `[gist-autosync] scheduled backup failed: ${r.error}`,
              );
          })
          .catch((e) =>
            console.error(
              `[gist-autosync] scheduled backup error: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
      }, ms);
      interval.unref?.();
    }
  };

  ctx.effect(() => {
    const stop = () => {
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
      // Release the domain handle when this fiber stops.
      void storePromise.then((store) => store?.close()).catch(() => {});
    };
    schedule(readBackupConfig());
    return stop;
  });

  ctx.webServer.register({
    kind: "exact",
    path: "/dsh-market-gist-autosync/rpc",
    handler: async (request: any, response: any) => {
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" });
        response.end();
        return;
      }
      if (!sameOrigin(request))
        return sendJson(response, 403, { error: "untrusted origin" });
      try {
        const body = await readJsonBody(request);
        const action = body.action;
        if (action === "getConfig") {
          const envToken =
            typeof process.env[GIST_TOKEN_ENV] === "string" &&
            process.env[GIST_TOKEN_ENV].trim() !== "";
          const cfg = readBackupConfig();
          sendJson(response, 200, {
            ok: true,
            config: { ...cfg, uploads: await listUploads() },
            deviceNameDetected: deviceName(),
            activeProfile: activeProfile(),
            envTokenSet: envToken,
            version: VERSION,
            nextRunAt,
          });
        } else if (action === "saveConfig") {
          const incoming = (body.config as Partial<GistBackupConfig>) || {};
          const cfg = { ...readBackupConfig(), ...incoming };
          cfg.scheduleEnabled = Boolean(cfg.scheduleEnabled);
          cfg.scheduleIntervalValue = Math.max(
            1,
            Number(cfg.scheduleIntervalValue) || 24,
          );
          cfg.scheduleIntervalUnit =
            cfg.scheduleIntervalUnit === "minute" ? "minute" : "hour";
          cfg.includeLock = Boolean(cfg.includeLock);
          writeBackupConfig(cfg);
          schedule(cfg);
          sendJson(response, 200, { ok: true, config: cfg });
        } else if (action === "testConnection") {
          sendJson(response, 200, await doTest(readBackupConfig(), apiHost));
        } else if (action === "backupNow") {
          // The UI field is the source of truth for a manual backup: pass it
          // through even when empty (empty = create a fresh gist), instead of
          // silently falling back to the last-saved gistId on disk.
          sendJson(
            response,
            200,
            await runBackup(
              typeof body.gist === "string" ? body.gist : undefined,
              "manual",
            ),
          );
        } else if (action === "restore") {
          // Restore is a long operation (pull gist, write files, pnpm install).
          // A second concurrent restore would race the first on the same profile
          // files and pnpm runs — not just garble progress, but cause real data
          // corruption. Reject with 409 instead of queueing: the UI polls
          // restoreProgress and already shows the in-flight state.
          if (restoreProgress.active) {
            sendJson(response, 409, {
              ok: false,
              code: "restore_in_progress",
              error: "已有恢复操作正在进行，请等待其完成后再试",
            });
          } else {
            const gistInput = typeof body.gist === "string" ? body.gist : "";
            restoreProgress = { active: true, lines: [], done: false };
            const result = await doRestore(
              readBackupConfig(),
              apiHost,
              gistInput,
              (p) => {
                const line = progressToLine(p);
                if (line) restoreProgress.lines.push(line);
              },
            );
            restoreProgress.done = true;
            restoreProgress.active = false;
            sendJson(response, 200, {
              ...result,
              progressLines: restoreProgress.lines,
            });
          }
        } else if (action === "restoreProgress") {
          sendJson(response, 200, { ok: true, ...restoreProgress });
        } else if (action === "listUploads") {
          // nextRunAt rides along: the client already polls this endpoint,
          // and the ETA changes on every tick / schedule save.
          sendJson(response, 200, {
            ok: true,
            uploads: await listUploads(),
            nextRunAt,
          });
        } else if (action === "clearUploads") {
          await clearUploads();
          sendJson(response, 200, { ok: true });
        } else {
          sendJson(response, 400, {
            ok: false,
            code: "invalid_action",
            error: "invalid action",
          });
        }
      } catch (e) {
        sendJson(response, 400, {
          ok: false,
          code: "other",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  });
  // Note: no model tool here. Registering a tool requires the @deepseek-ai/dsh-tools
  // defineTool contract (output { schema, render }) which is easy to get wrong and
  // will abort host boot; the core capability is fully covered by the RPC endpoint
  // above plus self-scheduling. A tool can be added later once the host half is stable.
}

export { name, inject, Config, apply };
