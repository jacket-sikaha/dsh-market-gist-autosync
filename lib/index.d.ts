import z from "@deepseek-ai/schemastery";
export { mergeManifests, restoreBackup } from "./restore.js";
export { validateBackupStrict, collectProfileBackup, serializeBackup, unportableDeps, stripMachineLocalDeps, } from "./backup.js";
export { installRestoredDeps } from "./install.js";
export { openUploadStore, migrateLegacyUploads, uploadDomainSpec, } from "./storage.js";
export { initProfileContext, activeProfile } from "./config.js";
export { analyzeBundles, orphanBundles, removeBundles, findDshInstallDir, INBOX_BUNDLES, } from "./analyze.js";
declare const name = "dsh-market-gist-autosync";
declare const inject: string[];
declare const Config: z<{
    gistApiHost: string;
}>;
declare function apply(ctx: any, rawConfig: any): Promise<void>;
export { name, inject, Config, apply };
