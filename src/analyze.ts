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
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./config";

/**
 * The in-box bundles a profile template installs. They are supplied by the dsh
 * INSTALLATION, not by the profile, so failing to find one says this process
 * could not locate the installation - not that the profile is broken. Judging
 * those fatal once turned a working composition into a fatal verdict (#369),
 * so they are reported as unknown rather than missing.
 */
export const INBOX_BUNDLES = new Set([
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-headless",
]);

const DSH_PACKAGE = "@deepseek-ai/dsh";

/** The host package's own manifest, or null when this directory is not it. */
function readDshManifest(
  directory: string,
): { name: string; version?: string } | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      manifest.name !== DSH_PACKAGE
    )
      return null;
    return {
      name: DSH_PACKAGE,
      version:
        typeof manifest.version === "string" ? manifest.version : undefined,
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
export function findDshInstallDir(
  entry: string | undefined = process.argv[1],
): string | null {
  if (entry !== undefined) {
    let directory = resolve(dirname(entry));
    for (let depth = 0; depth < 10; depth += 1) {
      if (readDshManifest(directory) !== null) return directory;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const resourcesPath = (process as unknown as { resourcesPath?: unknown })
    .resourcesPath;
  if (typeof resourcesPath !== "string" || resourcesPath === "") return null;
  for (const applicationRoot of ["app.asar.unpacked", "app.asar", "app"]) {
    const candidate = join(
      resourcesPath,
      applicationRoot,
      "node_modules",
      DSH_PACKAGE,
    );
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
function resolvePackageDir(
  anchorPackageJson: string,
  name: string,
  ignoredPackageDirectory?: string,
): string | null | undefined {
  let paths: string[];
  try {
    // createRequire requires an ABSOLUTE path; a relative anchor throws. Resolve
    // first so a caller that hands us a relative directory still gets a real
    // search instead of a spurious "not installed" verdict.
    paths = createRequire(resolve(anchorPackageJson)).resolve.paths(name) ?? [];
  } catch {
    // The probe itself failed (unreadable anchor). "I could not look" is NOT
    // "it is not there": conflating the two would report every bundle as
    // missing and then delete them all. Undefined carries that distinction.
    return undefined;
  }
  const ignored =
    ignoredPackageDirectory === undefined
      ? null
      : resolve(ignoredPackageDirectory);
  for (const searchPath of paths) {
    const candidate = join(searchPath, name);
    if (ignored !== null) {
      const resolvedCandidate = resolve(candidate);
      const matchesIgnored =
        process.platform === "win32"
          ? resolvedCandidate.toLowerCase() === ignored.toLowerCase()
          : resolvedCandidate === ignored;
      if (matchesIgnored) continue;
    }
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

/**
 * Parse a loader entry-list patch the way the boot does, so the check can never
 * disagree with the loader about what is loadable.
 *
 * The dialect is js-yaml's JSON schema plus the `!!js` scalar tag the DSH
 * include defines (an expression node the Loader evaluates at activation).
 * Community patches really use it — `dsh-better-sidebar` and `@tt-a1i/archify-dsh`
 * both carry `!!js` in the patch files shipped on this machine — so parsing with
 * a plain YAML/JSON reader would call those healthy plugins malformed and then
 * DELETE them. js-yaml is not a dependency of this plugin, so it is resolved
 * from the running installation (it is a direct dependency of dsh-app-boot, the
 * package doing the real parsing); when it cannot be resolved the parse verdict
 * is UNKNOWN and skipped rather than guessed.
 *
 * @returns the parsed entry list, null when the file is genuinely malformed,
 *          undefined when the check could not run.
 */
function parsePatchList(
  text: string,
  dshInstallDir: string | null,
): unknown[] | null | undefined {
  let yaml: {
    Type: new (tag: string, opts: Record<string, unknown>) => unknown;
    JSON_SCHEMA: { extend: (type: unknown) => unknown };
    load: (src: string, opts: Record<string, unknown>) => unknown;
  };
  // Anchors in the order that reflects where js-yaml actually lives: this
  // plugin's own file (installed into the profile, whose node_modules hoists
  // js-yaml), then the dsh installation (a direct dependency of the boot
  // package that does the real parsing), then the working directory.
  // Resolution is verified, not assumed: an anchor that cannot find js-yaml
  // yields the UNKNOWN verdict rather than a false "malformed".
  const anchors: string[] = [fileURLToPath(import.meta.url)];
  if (dshInstallDir !== null) anchors.push(join(dshInstallDir, "package.json"));
  anchors.push(join(process.cwd(), "package.json"));
  try {
    yaml = (() => {
      for (const anchor of anchors) {
        try {
          return createRequire(anchor)("js-yaml") as typeof yaml;
        } catch {
          continue;
        }
      }
      throw new Error("js-yaml is not resolvable");
    })();
  } catch {
    // Not a verdict about the profile: this process simply cannot run the same
    // parser the loader does.
    return undefined;
  }
  try {
    const jsExpr = new yaml.Type("tag:yaml.org,2002:js", {
      kind: "scalar",
      resolve: (data: unknown) => typeof data === "string",
      construct: (data: unknown) => ({ __jsExpr: data }),
    });
    const parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA.extend(jsExpr) });
    // The loader requires a top-level array of mappings and throws otherwise,
    // so both shapes are fatal for the whole profile.
    if (!Array.isArray(parsed)) return null;
    for (const entry of parsed) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export interface BundleLayer {
  name: string;
  /** Resolved directory, or null when neither anchor provides it. */
  directory: string | null;
  /** Why this bundle will fail to boot; null when it resolves or is unknown. */
  error: string | null;
  /**
   * True when this bundle's fate is UNKNOWN rather than known-bad: an in-box
   * bundle this process could not locate (#369), or a bundle whose resolution
   * probe itself failed. Never treated as fatal — an unknown must not be
   * allowed to delete a working bundle.
   */
  unresolvedInbox: boolean;
}

/** Analyze every declared bundle's resolvability, in manifest order. */
export function analyzeBundles(
  profileDirectory: string,
  dshInstallDir: string | null = findDshInstallDir(),
): BundleLayer[] {
  let names: string[] = [];
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDirectory, "package.json"), "utf8"),
    );
    const declared = manifest?.dsh?.profile?.bundles;
    if (Array.isArray(declared))
      names = declared.filter(
        (n: unknown): n is string => typeof n === "string",
      );
  } catch {
    return [];
  }
  return names.map((name) => {
    // The real loader gives the dsh installation first refusal for in-box
    // bundles; a direct profile-local copy with the same official name is only
    // a stale shadow, never evidence for the layer the running host loaded.
    const ignoredProfilePackage =
      dshInstallDir === null && INBOX_BUNDLES.has(name)
        ? join(profileDirectory, "node_modules", name)
        : undefined;
    const anchors = [
      dshInstallDir === null ? null : join(dshInstallDir, "package.json"),
      join(profileDirectory, "package.json"),
    ];
    let probeFailed = false;
    for (const anchor of anchors) {
      if (anchor === null) continue;
      const directory = resolvePackageDir(anchor, name, ignoredProfilePackage);
      if (typeof directory === "string")
        return judgeResolvedBundle(name, directory, dshInstallDir);
      if (directory === undefined) probeFailed = true;
    }
    // A failed probe is reported as unknown, never as a fatal verdict: acting
    // on it would delete a working bundle over a bug in this check.
    if (probeFailed)
      return { name, directory: null, error: null, unresolvedInbox: true };
    if (INBOX_BUNDLES.has(name))
      return { name, directory: null, error: null, unresolvedInbox: true };
    return {
      name,
      directory: null,
      error: "bundle package is not installed - the profile will fail to boot",
      unresolvedInbox: false,
    };
  });
}

/**
 * Judge a bundle whose package directory DID resolve, exactly as the boot
 * loader continues to judge it (dsh-app-boot's loadProfileDirectory).
 *
 * Resolving the directory is not the end of the loader's work: it then reads
 * `dsh.bundle.patch` from the bundle manifest and parses that file, throwing on
 * every failure. A bundle that resolves but declares no patch — or declares one
 * that is missing, unreadable, or not a valid entry list — still fails the
 * whole profile, so stopping at "the directory exists" would let exactly the
 * failure this pre-check exists to catch pass through, and the user would meet
 * it as a recovery-mode boot after the next restart.
 *
 * The patch is only PARSED, never applied: this asks whether the profile can
 * boot, not what it composes to. A parse this process cannot run (js-yaml
 * unresolvable) is UNKNOWN and never fatal.
 */
function judgeResolvedBundle(
  name: string,
  directory: string,
  dshInstallDir: string | null,
): BundleLayer {
  const resolved: BundleLayer = {
    name,
    directory,
    error: null,
    unresolvedInbox: false,
  };
  let declared: unknown;
  try {
    declared = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
      ?.dsh?.bundle?.patch;
  } catch {
    // The loader reads this same manifest and throws on an unreadable one, but
    // the probe itself failing is not evidence the file is broken for the
    // loader — treat it as unknown rather than deleting on our own blind spot.
    return { ...resolved, error: null, unresolvedInbox: true };
  }
  // A bundle may declare ONE patch file or a LIST of them. dsh 0.1.7's own
  // `@deepseek-ai/dsh-web-app` ships five (a base patch plus four presets) and
  // the official headless template includes that bundle, so accepting only a
  // string reports "will fail to boot" for the DEFAULT layout while
  // `dsh --dump-config` composes it fine. dshmarket hit exactly this and fixed
  // it in #676; the same mistake here would DELETE a healthy in-box bundle.
  //
  // Note the installed loader (0.1.5-rc.2) does `join(packageDir, declared)`,
  // which throws on an array — but that is one version's behavior, not the
  // contract. The list form is valid, so judge it by the contract.
  const declaredList =
    typeof declared === "string"
      ? [declared]
      : Array.isArray(declared)
        ? declared.filter((item): item is string => typeof item === "string")
        : [];
  if (declaredList.length === 0 || declaredList.some((rel) => rel === "")) {
    return {
      ...resolved,
      error:
        "bundle declares no dsh.bundle.patch - the profile will fail to boot",
    };
  }
  // EVERY declared file must exist and parse: the loader reads them all, so one
  // missing or malformed file fails the whole profile just as a lone one would.
  const texts: string[] = [];
  for (const relative of declaredList) {
    try {
      texts.push(readFileSync(join(directory, relative), "utf8"));
    } catch {
      return {
        ...resolved,
        error: `declared patch ${relative} is missing - the profile will fail to boot`,
      };
    }
  }
  for (let i = 0; i < texts.length; i += 1) {
    const parsed = parsePatchList(texts[i], dshInstallDir);
    if (parsed === undefined)
      return { ...resolved, error: null, unresolvedInbox: true };
    if (parsed === null) {
      return {
        ...resolved,
        error: `patch ${declaredList[i]} is not a valid loader entry list - the profile will fail to boot`,
      };
    }
  }
  return resolved;
}

/**
 * Declared bundles that will not resolve at boot (#339). Bundles whose fate is
 * merely UNKNOWN are excluded, because an unknown is not evidence of a broken
 * profile:
 * - an in-box bundle this process could not locate is supplied by the dsh
 *   installation, so failing to find it is a gap in what this process sees;
 * - a bundle whose resolution probe failed (unreadable anchor) was never
 *   actually looked for;
 * - a bundle whose patch could not be parsed because this process lacks the
 *   loader's YAML dialect.
 * All would otherwise delete a working bundle over a limitation of the check.
 *
 * Selected by `error`, not by `directory === null`: a bundle that resolves but
 * whose patch is missing or malformed fails the boot just as surely, and is
 * exactly what the pre-check is for.
 */
export function orphanBundles(
  profileDirectory: string,
  dshInstallDir: string | null = findDshInstallDir(),
): string[] {
  try {
    return analyzeBundles(profileDirectory, dshInstallDir)
      .filter((layer) => layer.error !== null && !layer.unresolvedInbox)
      .map((layer) => layer.name);
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
export function removeBundles(
  profileDirectory: string,
  names: string[],
): string[] {
  if (names.length === 0) return [];
  const manifestFile = join(profileDirectory, "package.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) return [];
    const drop = new Set(names);
    const removed = bundles.filter(
      (n: unknown): n is string => typeof n === "string" && drop.has(n),
    );
    if (removed.length === 0) return [];
    manifest.dsh.profile.bundles = bundles.filter(
      (n: unknown) => typeof n !== "string" || !drop.has(n),
    );
    writeFileAtomic(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
    return removed;
  } catch {
    return [];
  }
}
