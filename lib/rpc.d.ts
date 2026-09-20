/**
 * Minimal HTTP plumbing for the webServer RPC route.
 */
export declare function sendJson(response: {
    writeHead: (s: number, h: Record<string, string>) => void;
    end: (b?: string) => void;
}, status: number, value: unknown): void;
export declare function sameOrigin(request: {
    headers?: Record<string, string | string[] | undefined>;
}): boolean;
export declare function readJsonBody(request: {
    on: (ev: string, cb: (c: Buffer) => void) => void;
}): Promise<Record<string, unknown>>;
