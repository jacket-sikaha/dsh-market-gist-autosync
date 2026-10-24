export interface PnpmResult {
    exitCode: number;
    stderr: string;
    spawnError?: string;
}
/** Per-line stderr streaming, so callers can turn pnpm's progress reporter into
 * UI counters while the install is still running. */
export interface SpawnHooks {
    /** Called once per complete stderr line, in arrival order. */
    onStderrLine?: (line: string) => void;
}
/** Spawn a command. Windows `.cmd` shims (pnpm) cannot start without a shell,
 * so route through cmd.exe /d /s /c with an explicitly quoted command line. */
export declare function spawnCmd(file: string, args: string[], cwd: string, hooks?: SpawnHooks): Promise<PnpmResult>;
/** Package counts lifted out of that line. The unit is packages, NOT plugins —
 *  one plugin can pull dozens — so the UI shows them as counters instead of
 *  turning them into a percentage. */
export interface InstallCounters {
    resolved: number;
    reused: number;
    added: number;
}
/** Progress phases reported to the caller for live UI display. */
export type InstallProgress = {
    phase: 'probe';
    missing: string[];
} | {
    phase: 'install-all';
} | {
    phase: 'install-count';
    resolved: number;
    reused: number;
    added: number;
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
    /** Tail of pnpm's own output when the install failed; empty on success. */
    stderrTail?: string[];
}
export declare function installRestoredDeps(root: string, onProgress?: (p: InstallProgress) => void): Promise<InstallOutcome>;
