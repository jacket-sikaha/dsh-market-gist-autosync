export interface PnpmResult {
    exitCode: number;
    stderr: string;
    spawnError?: string;
}
/** Spawn a command. Windows `.cmd` shims (pnpm) cannot start without a shell,
 * so route through cmd.exe /d /s /c with an explicitly quoted command line. */
export declare function spawnCmd(file: string, args: string[], cwd: string): Promise<PnpmResult>;
/** Progress phases reported to the caller for live UI display. */
export type InstallProgress = {
    phase: 'probe';
    missing: string[];
} | {
    phase: 'install-all';
} | {
    phase: 'install-one';
    name: string;
    index: number;
    total: number;
} | {
    phase: 'done-one';
    name: string;
    ok: boolean;
};
export interface InstallOutcome {
    ok: boolean;
    /** true when deps were actually installed (or already present); false when
     *  pnpm could not run and the manifest was left for manual reinstall. */
    installed: boolean;
    summary: string;
    /** Names newly installed this run. */
    installedNames: string[];
    /** Names that failed and were pruned from the manifest. */
    prunedNames: string[];
}
export declare function installRestoredDeps(root: string, onProgress?: (p: InstallProgress) => void): Promise<InstallOutcome>;
