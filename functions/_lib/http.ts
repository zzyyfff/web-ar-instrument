import { AccessConfigError, AccessDeniedError, verifyAccess, type AccessEnv } from './access'

/** JSON response helper. */
export function json(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  })
}

export interface CorsEnv {
  /** Exact origin allowed for cross-origin data requests. Never '*'. */
  ALLOWED_ORIGIN?: string
}

/**
 * Locked CORS. We echo the allowed origin ONLY when the request's Origin exactly
 * matches the configured ALLOWED_ORIGIN — never '*' on a data route, and never
 * reflect an arbitrary caller's origin (which would be '*' with extra steps).
 * Returns no CORS headers at all for a non-matching/absent origin.
 */
export function corsHeaders(request: Request, env: CorsEnv): Record<string, string> {
  const origin = request.headers.get('Origin')
  if (env.ALLOWED_ORIGIN && origin && origin === env.ALLOWED_ORIGIN) {
    return {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    }
  }
  return {}
}

/**
 * Gate a request: require a configured storage binding AND a verified Access
 * identity. Returns a Response to short-circuit (503 if misconfigured, 403 if
 * denied) or null to proceed. Centralizing this keeps every route fail-closed by
 * construction — a new endpoint can't forget to check auth.
 *
 * Error bodies are intentionally generic (no internal detail) so the gate never
 * leaks whether it was a config problem vs a bad token to an unauthenticated caller.
 */
export async function gate(
  request: Request,
  env: AccessEnv & { storageBound: boolean },
): Promise<Response | null> {
  if (!env.storageBound) return json(503, { error: 'storage not configured' })
  try {
    await verifyAccess(request, env)
    return null
  } catch (e) {
    if (e instanceof AccessConfigError) {
      console.error('[gate] misconfigured:', e.message)
      return json(503, { error: 'backend not configured' })
    }
    if (e instanceof AccessDeniedError) return json(403, { error: 'forbidden' })
    console.error('[gate] unexpected:', e)
    return json(403, { error: 'forbidden' })
  }
}
