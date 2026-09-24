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
import z from '@deepseek-ai/schemastery';
export { mergeManifests, restoreBackup } from './restore.js';
export { validateBackupStrict, collectProfileBackup, serializeBackup, unportableDeps, stripMachineLocalDeps } from './backup.js';
export { installRestoredDeps } from './install.js';
export { openUploadStore, migrateLegacyUploads, uploadDomainSpec } from './storage.js';
export { initProfileContext, activeProfile } from './config.js';
export { analyzeBundles, orphanBundles, removeBundles, findDshInstallDir, INBOX_BUNDLES } from './analyze.js';
declare const name = "dsh-market-gist-autosync";
declare const inject: string[];
declare const Config: z<Schemastery.ObjectS<{
    gistApiHost: z<string, string>;
}>, Schemastery.ObjectT<{
    gistApiHost: z<string, string>;
}>>;
declare function apply(ctx: any, rawConfig: any): Promise<void>;
export { name, inject, Config, apply };
