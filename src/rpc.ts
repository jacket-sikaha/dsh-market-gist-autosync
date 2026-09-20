/**
 * Minimal HTTP plumbing for the webServer RPC route.
 */

export function sendJson(response: { writeHead: (s: number, h: Record<string, string>) => void; end: (b?: string) => void }, status: number, value: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

export function sameOrigin(request: { headers?: Record<string, string | string[] | undefined> }): boolean {
  // Minimal loopback guard, matching dshmarket's posture. The webServer sits
  // on loopback; treat requests without a disallowed Origin as same-origin.
  const origin = request.headers?.['origin'] ?? request.headers?.['Origin']
  if (origin === undefined) return true
  const value = Array.isArray(origin) ? origin[0] : origin
  if (value === '') return true
  try {
    const u = new URL(value)
    return ['localhost', '127.0.0.1', '::1'].includes(u.hostname) || u.hostname.startsWith('127.')
  } catch {
    return false
  }
}

export async function readJsonBody(request: { on: (ev: string, cb: (c: Buffer) => void) => void }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (c: Buffer) => chunks.push(c))
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    request.on('error', reject)
  })
}
