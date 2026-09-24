/**
 * The in-box bundles a profile template installs. They are supplied by the dsh
 * INSTALLATION, not by the profile, so failing to find one says this process
 * could not locate the installation - not that the profile is broken. Judging
 * those fatal once turned a working composition into a fatal verdict (#369),
 * so they are reported as unknown rather than missing.
 */
export declare const INBOX_BUNDLES: Set<string>;
/**
 * Locate the DSH host installation: walk up from the CLI entry first, then
 * inspect Electron's resources directory (Desktop may keep node_modules outside
 * the ASAR, expose them through ASAR's virtual filesystem, or disable ASAR).
 */
export declare function findDshInstallDir(entry?: string | undefined): string | null;
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
export declare function analyzeBundles(profileDirectory: string, dshInstallDir?: string | null): BundleLayer[];
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
export declare function orphanBundles(profileDirectory: string, dshInstallDir?: string | null): string[];
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
export declare function removeBundles(profileDirectory: string, names: string[]): string[];
