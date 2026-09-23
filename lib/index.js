import z from "@deepseek-ai/schemastery";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { z as z$1 } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
//#region src/config.ts
/**
* Config, paths, and shared constants for the gist-autosync host plugin.
*/
var CONFIG_DIR = "gist-autosync";
var CONFIG_FILE = "config.json";
var GIST_FILENAME = "dsh-profile-backup.json";
var REQUEST_TIMEOUT_MS = 3e4;
var GIST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var GIST_TOKEN_ENV = "DSH_GITHUB_TOKEN";
/** dshmarket backup format constants — kept identical so backups interoperate. */
var BACKUP_FORMAT = "dsh-profile-backup";
var BACKUP_VERSION = .2;
var PROFILE_SKIP = /* @__PURE__ */ new Set([
	"node_modules",
	".dsh-market",
	".git"
]);
/**
* The profile this host process actually booted, resolved once in apply() via
* initProfileContext() and consumed by the pure functions below.
*
* Detection order (mirrors dshmarket's src/index.ts):
*   1. DSH Desktop's `desktopProfiles` service (`current.name`/`current.dir`) —
*      authoritative on Desktop, present before Loader entries mount.
*   2. `--profile <name>` in process.argv — how plain `dsh web` is launched.
*   3. DSH_PROFILE env — test/escape hatch (the runtime itself never sets it).
*   4. 'desktop' — historical default.
*/
var detectedProfile;
function initProfileContext(ctx) {
	detectedProfile = void 0;
	const current = (ctx?.get?.("desktopProfiles"))?.current;
	if (current && typeof current.name === "string" && current.name !== "") {
		detectedProfile = {
			name: current.name,
			dir: typeof current.dir === "string" && current.dir !== "" ? current.dir : void 0
		};
		return;
	}
	const argv = process.argv;
	const flag = argv.indexOf("--profile");
	if (flag !== -1 && flag + 1 < argv.length) {
		const value = argv[flag + 1];
		if (!value.startsWith("-")) {
			detectedProfile = { name: value };
			return;
		}
	}
	const env = process.env.DSH_PROFILE;
	if (typeof env === "string" && env.trim() !== "") detectedProfile = { name: env.trim() };
}
/** The active profile this backup covers (the profile this host booted). */
function activeProfile() {
	return detectedProfile?.name ?? process.env.DSH_PROFILE ?? "desktop";
}
var DEFAULTS = {
	gistToken: "",
	gistId: "",
	deviceName: "",
	scheduleEnabled: false,
	scheduleIntervalValue: 24,
	scheduleIntervalUnit: "hour",
	includeLock: false,
	uploads: []
};
function err(code, error) {
	return {
		ok: false,
		code,
		error
	};
}
function dshHome() {
	return process.env.DSH_HOME || homedir();
}
function profileRoot() {
	return detectedProfile?.dir ?? join(dshHome(), "profiles", activeProfile());
}
function configDirPath() {
	return join(dshHome(), CONFIG_DIR);
}
function configFilePath() {
	return join(configDirPath(), CONFIG_FILE);
}
function readBackupConfig() {
	try {
		const text = readFileSync(configFilePath(), "utf8");
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object") {
			const cfg = {
				...DEFAULTS,
				...parsed
			};
			if (!Array.isArray(cfg.uploads)) cfg.uploads = [];
			return cfg;
		}
	} catch {}
	return { ...DEFAULTS };
}
function writeBackupConfig(cfg) {
	mkdirSync(configDirPath(), { recursive: true });
	writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2), "utf8");
}
function deviceName() {
	return process.env.COMPUTERNAME || process.env.HOSTNAME || hostname();
}
function parseGistId(input) {
	const trimmed = String(input || "").trim();
	if (trimmed === "") return "";
	let candidate = trimmed;
	try {
		const u = new URL(trimmed);
		if (u.protocol === "https:" && (u.hostname === "gist.github.com" || u.hostname.endsWith(".gist.github.com"))) {
			const parts = u.pathname.split("/").filter(Boolean);
			if (parts.length < 2) throw new Error("gist url 缺少 gist id（这是 gist 主页，不是某个具体 gist；留空则每次自动新建）");
			candidate = parts[parts.length - 1] || "";
		}
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("gist url")) throw e;
	}
	if (!GIST_ID_RE.test(candidate)) throw new Error("invalid gist id/url");
	return candidate;
}
/** Resolve the Gist token, env first (DSH_GITHUB_TOKEN), config value as fallback. */
function resolveToken(cfg) {
	const env = process.env[GIST_TOKEN_ENV];
	if (typeof env === "string" && env.trim() !== "") return {
		token: env.trim(),
		source: "env"
	};
	const saved = cfg.gistToken.trim();
	if (saved !== "") return {
		token: saved,
		source: "config"
	};
	return null;
}
/** Schedule interval in ms (minute-granularity). */
function scheduleIntervalMs(cfg) {
	const v = Math.max(1, Number(cfg.scheduleIntervalValue) || 24);
	return cfg.scheduleIntervalUnit === "minute" ? v * 60 * 1e3 : v * 60 * 60 * 1e3;
}
//#endregion
//#region src/gist.ts
/**
* GitHub Gist HTTP layer + create/update/read operations.
* Pure network + response shaping; no config or restore logic here.
*/
function gistHttp(token, method, path, body, host = "api.github.com") {
	return new Promise((resolve) => {
		const headers = {
			authorization: `Bearer ${token}`,
			"user-agent": "dsh-market-gist-autosync",
			accept: "application/vnd.github+json"
		};
		if (body !== void 0) {
			headers["content-type"] = "application/json";
			headers["content-length"] = String(Buffer.byteLength(body));
		}
		const req = request({
			hostname: host,
			path,
			method,
			headers
		}, (res) => {
			const chunks = [];
			let size = 0;
			res.on("data", (chunk) => {
				size += chunk.length;
				chunks.push(chunk);
				if (size > 1064960) res.destroy();
			});
			res.on("end", () => resolve({
				status: res.statusCode || 0,
				body: Buffer.concat(chunks).toString("utf8")
			}));
		});
		req.on("error", (e) => resolve({
			status: 0,
			body: "",
			netError: e.message
		}));
		req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(/* @__PURE__ */ new Error("timeout")));
		if (body !== void 0) req.end(body);
		else req.end();
	});
}
function classify(status, body) {
	let msg = body;
	try {
		const p = JSON.parse(body);
		if (typeof p.message === "string" && p.message) msg = p.message;
	} catch {}
	if (status === 401) return err("invalid_token", "GitHub token 无效或已撤销");
	if (status === 403) return err("rate_limit", `GitHub 拒绝：${msg}`);
	if (status === 404) return err("invalid_gist", "Gist 不存在（请检查 id/URL）");
	if (status === 422) return err("invalid_gist", `GitHub 拒绝：${msg}`);
	return err("other", `HTTP ${status} ${msg}`);
}
async function createGist(token, content, host) {
	const r = await gistHttp(token, "POST", "/gists", JSON.stringify({
		description: "dsh profile backup (dsh-market-gist-autosync)",
		public: false,
		files: { [GIST_FILENAME]: { content } }
	}), host);
	if (r.netError) return err("network", r.netError);
	if (r.status !== 201) return classify(r.status, r.body);
	const data = JSON.parse(r.body);
	return {
		ok: true,
		gistId: data.id,
		gistUrl: data.html_url || `https://gist.github.com/${data.id}`,
		createdAt: data.created_at,
		updatedAt: data.updated_at
	};
}
async function updateGist(token, gistId, content, host) {
	const body = JSON.stringify({ files: { [GIST_FILENAME]: { content } } });
	const r = await gistHttp(token, "PATCH", `/gists/${gistId}`, body, host);
	if (r.netError) return err("network", r.netError);
	if (r.status !== 200) return classify(r.status, r.body);
	const data = JSON.parse(r.body);
	return {
		ok: true,
		gistId: data.id || gistId,
		gistUrl: data.html_url || `https://gist.github.com/${gistId}`,
		createdAt: data.created_at,
		updatedAt: data.updated_at
	};
}
async function verifyToken(token, host) {
	const r = await gistHttp(token, "GET", "/user", void 0, host);
	if (r.netError) return err("network", r.netError);
	if (r.status !== 200) return classify(r.status, r.body);
	return {
		ok: true,
		message: "连接正常"
	};
}
/** Fetch the raw text of the backup file inside a gist. Accepts our filename,
* dshmarket's filename, or any single file whose content looks like a backup. */
async function readGistBackupContent(token, gistId, host) {
	const r = await gistHttp(token, "GET", `/gists/${gistId}`, void 0, host);
	if (r.netError) return err("network", r.netError);
	if (r.status !== 200) return classify(r.status, r.body);
	let data;
	try {
		data = JSON.parse(r.body);
	} catch {
		return err("invalid_gist", "Gist 响应不是有效 JSON");
	}
	const filesObj = data.files ?? {};
	const candidate = filesObj["dsh-profile-backup.json"]?.content ?? filesObj["dsh-config-backup.json"]?.content ?? Object.values(filesObj).find((f) => typeof f?.content === "string" && f.content.includes("\"dsh-profile-backup\""))?.content;
	if (typeof candidate !== "string") return err("invalid_gist", "Gist 中找不到 dsh 备份文件");
	return {
		ok: true,
		content: candidate
	};
}
//#endregion
//#region src/backup.ts
/**
* Backup collection: gather the active profile's config files exactly like
* dshmarket (single profile, paths relative to the profile root), build the
* backup envelope, and validate it strictly (aligned with dshmarket's
* validatedBackup).
*/
function profileFiles(root, dir, out) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (PROFILE_SKIP.has(entry.name) || /\.bak\b/.test(entry.name)) continue;
		if (entry.name === "pnpm-lock.yaml") continue;
		const abs = resolve(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) profileFiles(root, abs, out);
		else if (entry.isFile()) out.push(resolve(abs).slice(root.length + 1).split(sep).join("/"));
		if (out.length > 256) throw new Error(`profile has more than 256 configuration files`);
	}
}
function collectProfileBackup(includeLock) {
	const root = resolve(profileRoot());
	const manifestFile = resolve(root, "package.json");
	if (!existsSync(manifestFile)) throw new Error("profile package.json is missing");
	const relPaths = [];
	profileFiles(root, root, relPaths);
	if (includeLock && existsSync(resolve(root, "pnpm-lock.yaml"))) relPaths.push("pnpm-lock.yaml");
	const files = relPaths.sort().map((path) => {
		const content = readFileSync(resolve(root, path), "utf8");
		return path === "package.json" ? {
			path,
			json: JSON.parse(content)
		} : {
			path,
			lines: content.split(/\r?\n/)
		};
	});
	if (!files.some((f) => f.path === "package.json")) throw new Error("profile package.json is missing");
	return {
		files,
		containsSecrets: files.some((f) => /\.credentials|\.env|secrets?/i.test(f.path))
	};
}
/** Serialize the backup with 2-space indent so it reads well on the Gist web UI. */
function serializeBackup(backup) {
	return JSON.stringify(backup, null, 2);
}
function buildBackupEnvelope(files) {
	return {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		createdAt: (/* @__PURE__ */ new Date()).toISOString(),
		profile: activeProfile(),
		files
	};
}
/**
* Strict structural validation aligned with dshmarket's validatedBackup:
* - format is a string, files is an array
* - path is non-empty, not absolute, no `..` segments
* - no SKIP_NAMES segments, no duplicate paths
* - package.json (if present as json) must be a plain object; lines must be strings
* Returns an error message, or null when valid.
*/
function validateBackupStrict(value) {
	if (value === null || typeof value !== "object") return "备份不是对象";
	const b = value;
	if (typeof b.format !== "string" || b.format === "") return "缺少 format 字段";
	if (!Array.isArray(b.files)) return "缺少 files 数组";
	if (b.files.length > 256) return `备份文件过多（>256）`;
	const paths = /* @__PURE__ */ new Set();
	for (const f of b.files) {
		if (f === null || typeof f !== "object") return "files 含非对象项";
		const file = f;
		if (typeof file.path !== "string" || file.path === "") return "files 含无 path 项";
		if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..")) return `不安全的备份路径: ${file.path}`;
		const normalized = file.path.replaceAll("\\", "/");
		if (normalized.split("/").some((part) => PROFILE_SKIP.has(part))) return `含被排除的路径: ${file.path}`;
		if (paths.has(normalized)) return `重复的备份路径: ${file.path}`;
		paths.add(normalized);
		const hasJson = file.json !== void 0;
		const hasLines = Array.isArray(file.lines);
		if (!hasJson && !hasLines) return `文件既无 json 也无 lines: ${file.path}`;
		if (file.path === "package.json" && hasJson) {
			if (file.json === null || typeof file.json !== "object" || Array.isArray(file.json)) return "package.json 的 json 不是对象";
		}
		if (hasLines && !file.lines.every((l) => typeof l === "string")) return `lines 含非字符串: ${file.path}`;
	}
	return null;
}
//#endregion
//#region src/restore.ts
/**
* Restore: write a backup back into the active profile, merging package.json
* (union bundles, overlay deps) so existing plugins survive. Atomic per-file
* writes with a rollback handle the caller can invoke if the post-restore
* dependency install fails entirely (mirrors dshmarket's restored.rollback()).
*/
function entryContent(file) {
	if (file.json !== void 0) return JSON.stringify(file.json, null, 2) + "\n";
	return (file.lines ?? []).join("\n");
}
/** Merge backup manifest into current: union bundles, overlay deps (current kept, backup wins conflicts). */
function mergeManifests(backupJson, current) {
	const asObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
	const backupDeps = asObj(backupJson.dependencies);
	const deps = { ...asObj(current.dependencies) };
	for (const [k, spec] of Object.entries(backupDeps)) if (typeof spec === "string") deps[k] = spec;
	const backupBundles = asObj(asObj(backupJson.dsh).profile).bundles;
	const currentBundles = asObj(asObj(current.dsh).profile).bundles;
	const bundleSet = /* @__PURE__ */ new Set();
	for (const b of Array.isArray(currentBundles) ? currentBundles : []) if (typeof b === "string") bundleSet.add(b);
	for (const b of Array.isArray(backupBundles) ? backupBundles : []) if (typeof b === "string") bundleSet.add(b);
	const merged = {
		...backupJson,
		...current,
		dependencies: deps
	};
	const curDsh = asObj(current.dsh);
	const curProfile = asObj(curDsh.profile);
	merged.dsh = {
		...asObj(backupJson.dsh),
		...curDsh,
		profile: {
			...asObj(asObj(backupJson.dsh).profile),
			...curProfile,
			bundles: [...bundleSet]
		}
	};
	return merged;
}
function unportableDeps(dependencies) {
	if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) return [];
	const found = [];
	for (const [name, raw] of Object.entries(dependencies)) {
		if (typeof raw !== "string") continue;
		const match = /^(?:link|file):(.+)$/i.exec(raw);
		if (match === null) continue;
		let p = match[1];
		try {
			p = decodeURIComponent(p);
		} catch {}
		if (/^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)) found.push({
			name,
			spec: raw
		});
	}
	return found;
}
function restoreBackup(root, backup) {
	const previous = /* @__PURE__ */ new Map();
	let rolledBack = false;
	const rollback = () => {
		if (rolledBack) return;
		rolledBack = true;
		for (const [target, content] of previous) try {
			if (content === null) rmSync(target, { force: true });
			else writeFileSync(target, content);
		} catch {}
	};
	let mergedManifest = false;
	const resolvedRoot = resolve(root);
	try {
		for (const file of backup.files) {
			const target = resolve(resolvedRoot, file.path);
			if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) throw new Error(`不安全的备份路径: ${file.path}`);
			if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`目标不是普通文件: ${file.path}`);
			mkdirSync(dirname(target), { recursive: true });
			previous.set(target, existsSync(target) ? readFileSync(target) : null);
			let content;
			if (file.json !== void 0 && /(^|\/)package\.json$/.test(file.path) && existsSync(target)) {
				const current = JSON.parse(readFileSync(target, "utf8"));
				content = JSON.stringify(mergeManifests(file.json, current), null, 2) + "\n";
				mergedManifest = true;
			} else content = entryContent(file);
			const temp = `${target}.gist-restore-${process.pid}`;
			writeFileSync(temp, content, "utf8");
			renameSync(temp, target);
		}
	} catch (e) {
		rollback();
		return {
			ok: false,
			error: e instanceof Error ? e.message : String(e)
		};
	}
	return {
		ok: true,
		restored: backup.files.length,
		mergedManifest,
		rollback
	};
}
//#endregion
//#region src/install.ts
/**
* Post-restore dependency install via pnpm, with live progress reporting.
*
* Two distinct failure modes are handled differently:
* - pnpm itself cannot run here (spawn EPERM / not found): we do NOT touch the
*   manifest — pruning deps we merely failed to *probe* would wrongly uninstall
*   plugins that are already present. Reported as installed:false instead.
* - pnpm runs but a specific package fails to install (404 / network): only
*   those packages are pruned, so the profile still boots without them.
* - A link:/file: dep names a path that does not exist here (a backup from
*   another machine, #205): pruned up front, because nothing can ever satisfy
*   it and any bundle naming it would then be unresolvable at boot.
*/
/** Spawn a command. Windows `.cmd` shims (pnpm) cannot start without a shell,
* so route through cmd.exe /d /s /c with an explicitly quoted command line. */
function spawnCmd(file, args, cwd) {
	return new Promise((resolvePromise) => {
		const quote = (a) => /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, "\"\"")}"` : a;
		const isWin = process.platform === "win32";
		const cmd = isWin ? process.env.ComSpec ?? "cmd.exe" : file;
		const argv = isWin ? [
			"/d",
			"/s",
			"/c",
			[file, ...args].map(quote).join(" ")
		] : args;
		let child;
		try {
			child = spawn(cmd, argv, {
				cwd,
				shell: false,
				windowsHide: true,
				env: {
					...process.env,
					CI: "true"
				}
			});
		} catch (e) {
			resolvePromise({
				exitCode: 1,
				stderr: "",
				spawnError: e instanceof Error ? e.message : String(e)
			});
			return;
		}
		let stderr = "";
		child.stderr?.on("data", (c) => {
			stderr += c.toString("utf8");
		});
		child.on("error", (e) => resolvePromise({
			exitCode: 1,
			stderr,
			spawnError: e.message
		}));
		child.on("close", (code) => resolvePromise({
			exitCode: code ?? 1,
			stderr
		}));
	});
}
function pruneDependency(manifestFile, name) {
	try {
		const m = JSON.parse(readFileSync(manifestFile, "utf8"));
		if (m.dependencies) delete m.dependencies[name];
		if (Array.isArray(m.dsh?.profile?.bundles)) m.dsh.profile.bundles = m.dsh.profile.bundles.filter((b) => b !== name);
		writeFileSync(manifestFile, JSON.stringify(m, null, 2) + "\n", "utf8");
	} catch {}
}
async function installRestoredDeps(root, onProgress) {
	const manifestFile = join(root, "package.json");
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
	} catch {
		return {
			ok: false,
			installed: false,
			summary: "无法读取恢复后的 package.json",
			installedNames: [],
			prunedNames: []
		};
	}
	const deps = Object.entries(manifest.dependencies ?? {});
	if (deps.length === 0) return {
		ok: true,
		installed: true,
		summary: "无依赖需要安装",
		installedNames: [],
		prunedNames: []
	};
	const deadLocal = [];
	for (const [name, spec] of deps) {
		if (typeof spec !== "string" || !/^(?:link|file):/i.test(spec)) continue;
		let target = spec.replace(/^(?:link|file):/i, "");
		try {
			target = decodeURIComponent(target);
		} catch {}
		const absolute = isAbsolute(target) ? target : join(root, target);
		if (!existsSync(absolute)) deadLocal.push(name);
	}
	for (const name of deadLocal) pruneDependency(manifestFile, name);
	const missing = Object.entries(JSON.parse(readFileSync(manifestFile, "utf8")).dependencies ?? {}).filter(([name, spec]) => {
		if (typeof spec !== "string") return false;
		if (/^(?:link|file):/i.test(spec)) return false;
		return !existsSync(join(root, "node_modules", name, "package.json"));
	}).map(([name, spec]) => [name, spec]);
	onProgress?.({
		phase: "probe",
		missing: missing.map(([n]) => n)
	});
	if (missing.length === 0 && deadLocal.length === 0) return {
		ok: true,
		installed: true,
		summary: "依赖均已安装",
		installedNames: [],
		prunedNames: []
	};
	if (missing.length === 0) return {
		ok: true,
		installed: true,
		summary: `已剔除 ${deadLocal.length} 个指向本机不存在路径的本地依赖：${deadLocal.join("、")}`,
		installedNames: [],
		prunedNames: deadLocal
	};
	onProgress?.({ phase: "install-all" });
	const install = await spawnCmd("pnpm", ["install", "--config.auto-install-peers=false"], root);
	if (install.exitCode === 0) return {
		ok: true,
		installed: true,
		summary: `依赖安装完成（新装 ${missing.length} 个）`,
		installedNames: missing.map(([n]) => n),
		prunedNames: []
	};
	if (install.spawnError) return {
		ok: true,
		installed: false,
		summary: `恢复完成，但此环境无法自动安装依赖（${install.spawnError}）。${missing.length} 个插件需在重启后于插件市场确认/重装：${missing.map(([n]) => n).join("、")}`,
		installedNames: [],
		prunedNames: []
	};
	const failed = [];
	const installedNames = [];
	for (let i = 0; i < missing.length; i++) {
		const [name, spec] = missing[i];
		onProgress?.({
			phase: "install-one",
			name,
			index: i + 1,
			total: missing.length
		});
		const r = await spawnCmd("pnpm", [
			"add",
			/^(?:github|git\+|https?):/.test(spec) ? spec : `${name}@${spec}`,
			"--config.auto-install-peers=false"
		], root);
		if (r.exitCode === 0 && existsSync(join(root, "node_modules", name, "package.json"))) {
			installedNames.push(name);
			onProgress?.({
				phase: "done-one",
				name,
				ok: true
			});
		} else if (r.spawnError) return {
			ok: true,
			installed: false,
			summary: `安装中断（${r.spawnError}）。请在重启后于插件市场确认依赖。`,
			installedNames,
			prunedNames: failed
		};
		else {
			failed.push(name);
			pruneDependency(manifestFile, name);
			onProgress?.({
				phase: "done-one",
				name,
				ok: false
			});
		}
	}
	if (failed.length === 0) return {
		ok: true,
		installed: true,
		summary: `依赖安装完成（新装 ${installedNames.length} 个）`,
		installedNames,
		prunedNames: []
	};
	if (installedNames.length > 0) return {
		ok: true,
		installed: true,
		summary: `已装 ${installedNames.length} 个，剔除装不上的：${failed.join("、")}（可在插件市场重装）`,
		installedNames,
		prunedNames: failed
	};
	return {
		ok: true,
		installed: false,
		summary: `依赖安装失败，已剔除装不上的：${failed.join("、")}。请在插件市场手动重装。`,
		installedNames,
		prunedNames: failed
	};
}
//#endregion
//#region src/analyze.ts
/**
* Profile boot analysis: can the boot loader actually resolve every bundle the
* profile declares?
*
* Ported from dshmarket's analyzeProfile / buildBundleLayers (#339). The boot
* loader reads dsh.profile.bundles and dies on the FIRST name it cannot
* resolve - the whole profile, not just that plugin. A restore that leaves such
* a name behind therefore does not fail where the user can see it: it fails at
* the NEXT restart, as a Loader error with nothing tying it back to the restore
* that caused it. Checking here is what lets the restore report it instead.
*
* Resolution mirrors the boot exactly: the dsh installation anchor first
* (in-box bundles always come from the running dsh, never a profile-local
* copy), then Node's own module search from the profile directory (which
* covers community bundles and pnpm's workspace-root hoisting).
*/
/**
* The in-box bundles a profile template installs. They are supplied by the dsh
* INSTALLATION, not by the profile, so failing to find one says this process
* could not locate the installation - not that the profile is broken. Judging
* those fatal once turned a working composition into a fatal verdict (#369),
* so they are reported as unknown rather than missing.
*/
var INBOX_BUNDLES = /* @__PURE__ */ new Set([
	"@deepseek-ai/dsh-base",
	"@deepseek-ai/dsh-web-app",
	"@deepseek-ai/dsh-headless"
]);
var DSH_PACKAGE = "@deepseek-ai/dsh";
/** The host package's own manifest, or null when this directory is not it. */
function readDshManifest(directory) {
	try {
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		if (manifest === null || typeof manifest !== "object" || manifest.name !== DSH_PACKAGE) return null;
		return {
			name: DSH_PACKAGE,
			version: typeof manifest.version === "string" ? manifest.version : void 0
		};
	} catch {
		return null;
	}
}
/**
* Locate the DSH host installation: walk up from the CLI entry first, then
* inspect Electron's resources directory (Desktop may keep node_modules outside
* the ASAR, expose them through ASAR's virtual filesystem, or disable ASAR).
*/
function findDshInstallDir(entry = process.argv[1]) {
	if (entry !== void 0) {
		let directory = resolve(dirname(entry));
		for (let depth = 0; depth < 10; depth += 1) {
			if (readDshManifest(directory) !== null) return directory;
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
	const resourcesPath = process.resourcesPath;
	if (typeof resourcesPath !== "string" || resourcesPath === "") return null;
	for (const applicationRoot of [
		"app.asar.unpacked",
		"app.asar",
		"app"
	]) {
		const candidate = join(resourcesPath, applicationRoot, "node_modules", DSH_PACKAGE);
		if (readDshManifest(candidate) !== null) return candidate;
	}
	return null;
}
/**
* Resolve one package's directory the way the dsh boot does: probe Node's own
* node_modules search paths from the anchor. Node resolution walks upward, so
* this also finds pnpm's workspace-root hoisting
* (profiles/node_modules when the profile lives under profiles/<name>).
*/
function resolvePackageDir(anchorPackageJson, name, ignoredPackageDirectory) {
	let paths;
	try {
		paths = createRequire(resolve(anchorPackageJson)).resolve.paths(name) ?? [];
	} catch {
		return;
	}
	const ignored = ignoredPackageDirectory === void 0 ? null : resolve(ignoredPackageDirectory);
	for (const searchPath of paths) {
		const candidate = join(searchPath, name);
		if (ignored !== null) {
			const resolvedCandidate = resolve(candidate);
			if (process.platform === "win32" ? resolvedCandidate.toLowerCase() === ignored.toLowerCase() : resolvedCandidate === ignored) continue;
		}
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
	return null;
}
/** Analyze every declared bundle's resolvability, in manifest order. */
function analyzeBundles(profileDirectory, dshInstallDir = findDshInstallDir()) {
	let names = [];
	try {
		const declared = JSON.parse(readFileSync(join(profileDirectory, "package.json"), "utf8"))?.dsh?.profile?.bundles;
		if (Array.isArray(declared)) names = declared.filter((n) => typeof n === "string");
	} catch {
		return [];
	}
	return names.map((name) => {
		const ignoredProfilePackage = dshInstallDir === null && INBOX_BUNDLES.has(name) ? join(profileDirectory, "node_modules", name) : void 0;
		const anchors = [dshInstallDir === null ? null : join(dshInstallDir, "package.json"), join(profileDirectory, "package.json")];
		let probeFailed = false;
		for (const anchor of anchors) {
			if (anchor === null) continue;
			const directory = resolvePackageDir(anchor, name, ignoredProfilePackage);
			if (typeof directory === "string") return {
				name,
				directory,
				error: null,
				unresolvedInbox: false
			};
			if (directory === void 0) probeFailed = true;
		}
		if (probeFailed) return {
			name,
			directory: null,
			error: null,
			unresolvedInbox: true
		};
		if (INBOX_BUNDLES.has(name)) return {
			name,
			directory: null,
			error: null,
			unresolvedInbox: true
		};
		return {
			name,
			directory: null,
			error: "bundle package is not installed - the profile will fail to boot",
			unresolvedInbox: false
		};
	});
}
/**
* Declared bundles that will not resolve at boot (#339). Bundles whose fate is
* merely UNKNOWN are excluded, because an unknown is not evidence of a broken
* profile:
* - an in-box bundle this process could not locate is supplied by the dsh
*   installation, so failing to find it is a gap in what this process sees;
* - a bundle whose resolution probe failed (unreadable anchor) was never
*   actually looked for.
* Both would otherwise delete a working bundle over a limitation of the check.
*/
function orphanBundles(profileDirectory, dshInstallDir = findDshInstallDir()) {
	try {
		return analyzeBundles(profileDirectory, dshInstallDir).filter((layer) => layer.directory === null && !layer.unresolvedInbox).map((layer) => layer.name);
	} catch {
		return [];
	}
}
/**
* Drop the named bundles from the profile manifest, returning the names that
* were actually present. Best effort: an unreadable or unwritable manifest is
* left exactly as it was.
*
* Removing rather than only reporting is deliberate. The boot loader dies on
* the first unresolvable name, so leaving one in place means the very next
* restart lands in recovery mode - a state the user cannot climb out of from
* inside the plugin that caused it. The plugin is unloadable either way;
* dropping the row is what lets the rest of the profile boot.
*/
function removeBundles(profileDirectory, names) {
	if (names.length === 0) return [];
	const manifestFile = join(profileDirectory, "package.json");
	try {
		const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
		const bundles = manifest?.dsh?.profile?.bundles;
		if (!Array.isArray(bundles)) return [];
		const drop = new Set(names);
		const removed = bundles.filter((n) => typeof n === "string" && drop.has(n));
		if (removed.length === 0) return [];
		manifest.dsh.profile.bundles = bundles.filter((n) => typeof n !== "string" || !drop.has(n));
		writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
		return removed;
	} catch {
		return [];
	}
}
//#endregion
//#region src/operations.ts
/**
* High-level operations the RPC handler exposes: test connection, backup now,
* restore from a gist. These compose the config / gist / backup / restore /
* install modules and own the cross-cutting concerns (token resolution,
* gistId persistence, upload records, install-failure rollback).
*/
async function doTest(cfg, host) {
	const resolved = resolveToken(cfg);
	if (!resolved) return err("no_token", "未配置 Gist token（请在下方填写，或设置环境变量 DSH_GITHUB_TOKEN）");
	const token = resolved.token;
	const r = await verifyToken(token, host);
	if (!r.ok) return r;
	if (cfg.gistId.trim() !== "") {
		let gid;
		try {
			gid = parseGistId(cfg.gistId);
		} catch (e) {
			return err("invalid_gist", e instanceof Error ? e.message : String(e));
		}
		const get = await gistHttp(token, "GET", `/gists/${gid}`, void 0, host);
		if (get.netError) return err("network", get.netError);
		if (get.status !== 200) return classify(get.status, get.body);
	}
	return {
		ok: true,
		message: `连接正常（token 来源：${resolved.source === "env" ? "环境变量" : "已保存配置"}）`
	};
}
/**
* gistOverride: when provided (including the empty string), it is the source of
* truth for which gist to update — the UI field value, so "clear the field and
* back up" really creates a fresh gist. undefined = use cfg.gistId (scheduled
* backups, which have no UI context).
*/
async function doBackup(cfg, host, gistOverride) {
	const resolved = resolveToken(cfg);
	if (!resolved) return err("no_token", "未配置 Gist token（请在下方填写，或设置环境变量 DSH_GITHUB_TOKEN）");
	let gid;
	try {
		gid = parseGistId(gistOverride !== void 0 ? gistOverride : cfg.gistId);
	} catch (e) {
		return err("invalid_gist", e instanceof Error ? e.message : String(e));
	}
	const token = resolved.token;
	let files;
	let containsSecrets = false;
	try {
		const collected = collectProfileBackup(cfg.includeLock);
		files = collected.files;
		containsSecrets = collected.containsSecrets;
	} catch (e) {
		return err("other", e instanceof Error ? e.message : String(e));
	}
	const content = serializeBackup(buildBackupEnvelope(files));
	const bytes = Buffer.byteLength(content);
	if (bytes > 1048576) return err("too_large", `备份 ${(bytes / 1024).toFixed(0)}KB 超过 GitHub Gist 1MB 限制`);
	const isNew = gid === "";
	const ref = isNew ? await createGist(token, content, host) : await updateGist(token, gid, content, host);
	if (!ref.ok) return ref;
	const newGistId = String(ref.gistId || gid);
	const gistUrl = String(ref.gistUrl || `https://gist.github.com/${newGistId}`);
	const record = {
		gistId: newGistId,
		deviceName: cfg.deviceName.trim() || deviceName(),
		uploadedAt: (/* @__PURE__ */ new Date()).toISOString(),
		status: isNew ? "new" : "update",
		bytes
	};
	writeBackupConfig({
		...cfg,
		gistId: newGistId
	});
	return {
		ok: true,
		gistId: newGistId,
		gistUrl,
		bytes,
		isNew,
		record,
		containsSecrets
	};
}
async function doRestore(cfg, host, gistInput, onProgress) {
	const resolved = resolveToken(cfg);
	if (!resolved) return err("no_token", "未配置 Gist token（请在下方填写，或设置环境变量 DSH_GITHUB_TOKEN）");
	let gid;
	try {
		gid = parseGistId(gistInput || cfg.gistId);
	} catch (e) {
		return err("invalid_gist", e instanceof Error ? e.message : String(e));
	}
	if (gid === "") return err("invalid_gist", "请提供要恢复的 Gist id 或 URL");
	const got = await readGistBackupContent(resolved.token, gid, host);
	if (!got.ok) return got;
	let parsed;
	try {
		parsed = JSON.parse(got.content);
	} catch {
		return err("invalid_gist", "备份文件内容不是有效 JSON");
	}
	const vErr = validateBackupStrict(parsed);
	if (vErr) return err("invalid_gist", vErr);
	const result = restoreBackup(profileRoot(), parsed);
	if (!result.ok) return err("restore_failed", result.error || "恢复失败");
	const pkgEntry = parsed.files.find((f) => f.path === "package.json" && f.json !== void 0);
	const warnings = pkgEntry ? unportableDeps(pkgEntry.json?.dependencies) : [];
	const install = await installRestoredDeps(profileRoot(), onProgress);
	if (!install.installed && install.prunedNames.length > 0 && install.installedNames.length === 0) {
		result.rollback?.();
		return err("restore_failed", `依赖全部安装失败，已回滚恢复。${install.summary}`);
	}
	const orphans = orphanBundles(profileRoot(), findDshInstallDir());
	const droppedBundles = removeBundles(profileRoot(), orphans);
	const warnNote = warnings.length > 0 ? `；注意：${warnings.length} 个依赖指向本机不存在的本地路径，${warnings.map((w) => `${w.name}（${w.spec}）`).join("、")}——这些插件不会自动安装，需在插件市场手动重装或移除` : "";
	const bootNote = droppedBundles.length > 0 ? `；启动预检发现 ${droppedBundles.length} 个无法解析的 bundle，已从 profile 移除（保留的话下次重启会直接进恢复模式）：${droppedBundles.join("、")}` : "";
	return {
		ok: true,
		restored: result.restored,
		mergedManifest: result.mergedManifest,
		installOk: install.installed,
		installedNames: install.installedNames,
		prunedNames: install.prunedNames,
		unportableDepsWarnings: warnings,
		bootErrors: droppedBundles,
		message: `已恢复 ${result.restored} 个文件到 profile「${activeProfile()}」${result.mergedManifest ? "（package.json 已合并，未覆盖现有插件）" : ""}。${install.summary}${warnNote}${bootNote}。重启 DSH 后生效。`
	};
}
//#endregion
//#region src/rpc.ts
/**
* Minimal HTTP plumbing for the webServer RPC route.
*/
function sendJson(response, status, value) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	response.end(JSON.stringify(value));
}
function sameOrigin(request) {
	const origin = request.headers?.["origin"] ?? request.headers?.["Origin"];
	if (origin === void 0) return true;
	const value = Array.isArray(origin) ? origin[0] : origin;
	if (value === "") return true;
	try {
		const u = new URL(value);
		return [
			"localhost",
			"127.0.0.1",
			"::1"
		].includes(u.hostname) || u.hostname.startsWith("127.");
	} catch {
		return false;
	}
}
async function readJsonBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		request.on("data", (c) => chunks.push(c));
		request.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
			} catch (e) {
				reject(e);
			}
		});
		request.on("error", reject);
	});
}
//#endregion
//#region src/storage.ts
/**
* Upload-record persistence via the official storage stack
* (@deepseek-ai/dsh-storage-domain over the json backend mounted by dsh-base).
*
* Upload history is operational data — machine-generated, append-only — so it
* does NOT belong in the plugin Config (method 1: scope.update restarts the
* whole plugin per write) nor in a hand-rolled file when the host already
* provides a schema-validated, crash-safe KV store. Sensitive settings stay in
* config.json; only these non-sensitive history records live here.
*
* Falls back to the legacy config.json `uploads` array when the storageDomain
* service is unavailable (a host without dsh-base's storage layer).
*/
var uploadRecordSchema = z$1.object({
	gistId: z$1.string(),
	deviceName: z$1.string(),
	uploadedAt: z$1.string(),
	status: z$1.union([z$1.literal("new"), z$1.literal("update")]),
	bytes: z$1.number()
});
var uploadDomainSpec = defineDomain({
	name: "gist_autosync",
	version: 1,
	tables: { uploads: domainTable(uploadRecordSchema) }
});
/**
* Open the upload domain through ctx.storageDomain and adapt it to a small
* store interface. Returns null when the service is unavailable, so callers
* can fall back to the legacy config.json path.
*/
async function openUploadStore(ctx) {
	const facility = ctx.get("storageDomain");
	if (facility === void 0) return null;
	const domain = await facility.open(uploadDomainSpec);
	const table = domain.table("uploads");
	return {
		async put(record) {
			await table.put(record.uploadedAt, record);
			const keys = [...table.keys()].sort();
			const excess = keys.length - 20;
			for (let i = 0; i < excess; i++) await table.delete(keys[i]);
		},
		list() {
			return [...table.entries()].map(([, v]) => v).sort((a, b) => a.uploadedAt < b.uploadedAt ? 1 : -1);
		},
		async clear() {
			for (const key of table.keys()) await table.delete(key);
		},
		async close() {
			await domain.close();
		}
	};
}
/**
* One-shot migration: move legacy config.json uploads into the domain, then
* strip them from config.json. Idempotent — config.json without uploads is a
* no-op.
*/
async function migrateLegacyUploads(store) {
	const cfg = readBackupConfig();
	const legacy = Array.isArray(cfg.uploads) ? cfg.uploads : [];
	if (legacy.length === 0) return 0;
	let moved = 0;
	for (const u of legacy) {
		if (!u || typeof u.gistId !== "string") continue;
		await store.put({
			gistId: u.gistId,
			deviceName: u.deviceName || "",
			uploadedAt: u.uploadedAt || u.updatedAt || u.createdAt || (/* @__PURE__ */ new Date()).toISOString(),
			status: u.status === "new" ? "new" : "update",
			bytes: typeof u.bytes === "number" ? u.bytes : 0
		});
		moved++;
	}
	writeBackupConfig({
		...cfg,
		uploads: []
	});
	return moved;
}
//#endregion
//#region src/index.ts
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
var name = "dsh-market-gist-autosync";
var inject = ["webServer"];
var Config = z.object({ gistApiHost: z.string().default("api.github.com") });
var restoreProgress = {
	active: false,
	lines: [],
	done: true
};
function progressToLine(p) {
	switch (p.phase) {
		case "probe": return p.missing.length > 0 ? `需安装 ${p.missing.length} 个插件：${p.missing.join("、")}` : "依赖均已安装";
		case "install-all": return "正在安装依赖…";
		case "install-one": return `正在安装 ${p.name}（${p.index}/${p.total}）…`;
		case "done-one": return `${p.name} ${p.ok ? "✓ 安装成功" : "✗ 安装失败"}`;
		default: return "";
	}
}
async function apply(ctx, rawConfig) {
	const apiHost = rawConfig?.gistApiHost ?? "api.github.com";
	initProfileContext(ctx);
	let interval;
	const STORAGE_OPEN_RETRY_MS = 250;
	const STORAGE_OPEN_TIMEOUT_MS = 15e3;
	const openStoreWhenReady = async () => {
		const deadline = Date.now() + STORAGE_OPEN_TIMEOUT_MS;
		for (;;) {
			if (ctx.get("storageDomain") === void 0) {
				if (Date.now() >= deadline) {
					console.error("[gist-autosync] storage domain service never appeared, falling back to config.json");
					return null;
				}
				await new Promise((resolve) => setTimeout(resolve, STORAGE_OPEN_RETRY_MS));
				continue;
			}
			try {
				const store = await openUploadStore(ctx);
				if (store) {
					if (await migrateLegacyUploads(store) > 0) ctx.logger?.info?.("migrated legacy upload record(s) into the storage domain");
					return store;
				}
				return null;
			} catch (e) {
				console.error("[gist-autosync] storage domain open failed, falling back to config.json: " + (e instanceof Error ? e.message : String(e)));
				return null;
			}
		}
	};
	const storePromise = openStoreWhenReady();
	/**
	* Upload records, MERGED from both stores.
	*
	* The domain is the destination, but config.json rows written by an earlier
	* layout (or by a boot that lost the provisioning race before this fix) are
	* still real history and must not disappear from the UI. Merge by
	* (gistId, uploadedAt) and keep the newest MAX_UPLOAD_RECORDS.
	*/
	const listUploads = async () => {
		const legacy = (readBackupConfig().uploads || []).filter((u) => typeof u?.gistId === "string");
		const store = await storePromise;
		if (!store) return legacy;
		const seen = /* @__PURE__ */ new Set();
		const merged = [];
		for (const u of [...store.list(), ...legacy]) {
			const key = u.gistId + "|" + u.uploadedAt;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(u);
		}
		merged.sort((a, b) => a.uploadedAt < b.uploadedAt ? 1 : -1);
		return merged.slice(0, 20);
	};
	/** Persist the record doBackup produced (store when available, else legacy). */
	const recordUpload = async (record) => {
		const store = await storePromise;
		if (store) await store.put(record);
		else {
			const cfg = readBackupConfig();
			writeBackupConfig({
				...cfg,
				uploads: [record, ...cfg.uploads || []].slice(0, 20)
			});
		}
	};
	/** doBackup + record persistence, shared by the timer and the RPC. */
	const runBackup = async (gistOverride) => {
		const r = await doBackup(readBackupConfig(), apiHost, gistOverride);
		if (r.ok && r.record) try {
			await recordUpload(r.record);
		} catch (e) {
			console.error(`[gist-autosync] failed to record upload: ${e instanceof Error ? e.message : String(e)}`);
		}
		return r;
	};
	/** Wipe upload history (domain store when available, else legacy file). */
	const clearUploads = async () => {
		const store = await storePromise;
		if (store) await store.clear();
		else writeBackupConfig({
			...readBackupConfig(),
			uploads: []
		});
	};
	const schedule = (cfg) => {
		if (interval) {
			clearInterval(interval);
			interval = void 0;
		}
		if (cfg.scheduleEnabled) {
			interval = setInterval(() => {
				runBackup().then((r) => {
					if (!r.ok) console.error(`[gist-autosync] scheduled backup failed: ${r.error}`);
				}).catch((e) => console.error(`[gist-autosync] scheduled backup error: ${e instanceof Error ? e.message : String(e)}`));
			}, scheduleIntervalMs(cfg));
			interval.unref?.();
		}
	};
	ctx.effect(() => {
		const stop = () => {
			if (interval) {
				clearInterval(interval);
				interval = void 0;
			}
			storePromise.then((store) => store?.close()).catch(() => {});
		};
		schedule(readBackupConfig());
		return stop;
	});
	ctx.webServer.register({
		kind: "exact",
		path: "/dsh-market-gist-autosync/rpc",
		handler: async (request, response) => {
			if (request.method !== "POST") {
				response.writeHead(405, { allow: "POST" });
				response.end();
				return;
			}
			if (!sameOrigin(request)) return sendJson(response, 403, { error: "untrusted origin" });
			try {
				const body = await readJsonBody(request);
				const action = body.action;
				if (action === "getConfig") {
					const envToken = typeof process.env["DSH_GITHUB_TOKEN"] === "string" && process.env["DSH_GITHUB_TOKEN"].trim() !== "";
					sendJson(response, 200, {
						ok: true,
						config: {
							...readBackupConfig(),
							uploads: await listUploads()
						},
						deviceNameDetected: deviceName(),
						activeProfile: activeProfile(),
						envTokenSet: envToken
					});
				} else if (action === "saveConfig") {
					const incoming = body.config || {};
					const cfg = {
						...readBackupConfig(),
						...incoming
					};
					cfg.scheduleEnabled = Boolean(cfg.scheduleEnabled);
					cfg.scheduleIntervalValue = Math.max(1, Number(cfg.scheduleIntervalValue) || 24);
					cfg.scheduleIntervalUnit = cfg.scheduleIntervalUnit === "minute" ? "minute" : "hour";
					cfg.includeLock = Boolean(cfg.includeLock);
					writeBackupConfig(cfg);
					schedule(cfg);
					sendJson(response, 200, {
						ok: true,
						config: cfg
					});
				} else if (action === "testConnection") sendJson(response, 200, await doTest(readBackupConfig(), apiHost));
				else if (action === "backupNow") sendJson(response, 200, await runBackup(typeof body.gist === "string" ? body.gist : void 0));
				else if (action === "restore") {
					const gistInput = typeof body.gist === "string" ? body.gist : "";
					restoreProgress = {
						active: true,
						lines: [],
						done: false
					};
					const result = await doRestore(readBackupConfig(), apiHost, gistInput, (p) => {
						const line = progressToLine(p);
						if (line) restoreProgress.lines.push(line);
					});
					restoreProgress.done = true;
					restoreProgress.active = false;
					sendJson(response, 200, {
						...result,
						progressLines: restoreProgress.lines
					});
				} else if (action === "restoreProgress") sendJson(response, 200, {
					ok: true,
					...restoreProgress
				});
				else if (action === "listUploads") sendJson(response, 200, {
					ok: true,
					uploads: await listUploads()
				});
				else if (action === "clearUploads") {
					await clearUploads();
					sendJson(response, 200, { ok: true });
				} else sendJson(response, 400, {
					ok: false,
					code: "invalid_action",
					error: "invalid action"
				});
			} catch (e) {
				sendJson(response, 400, {
					ok: false,
					code: "other",
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}
	});
}
//#endregion
export { Config, INBOX_BUNDLES, activeProfile, analyzeBundles, apply, collectProfileBackup, findDshInstallDir, initProfileContext, inject, installRestoredDeps, mergeManifests, migrateLegacyUploads, name, openUploadStore, orphanBundles, removeBundles, restoreBackup, serializeBackup, unportableDeps, uploadDomainSpec, validateBackupStrict };
