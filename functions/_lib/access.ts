import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

/**
 * Cloudflare Access (Zero Trust) JWT verification — the security core of this backend.
 *
 * The deployment sits behind a Cloudflare Access application, so unauthenticated
 * requests are stopped at the edge before they reach this function. We verify the
 * Access assertion AGAIN here, in code, as defense in depth: we do not trust the
 * proxy blindly. If Access were ever misconfigured, bypassed, or the route exposed,
 * this check still refuses anyone without a valid, correctly-scoped token.
 *
 * This is the headline lesson of this repo: never put an unauthenticated endpoint in
 * front of private storage. The gate is identity-aware AND independently verified, and
 * it FAILS CLOSED — missing config refuses service rather than silently opening.
 */

export interface AccessEnv {
  /** e.g. https://your-team.cloudflareaccess.com (no trailing slash). */
  CF_ACCESS_TEAM_DOMAIN?: string
  /** The Access application's Audience (AUD) tag. */
  CF_ACCESS_AUD?: string
}

export interface AccessIdentity {
  email?: string
  sub?: string
}

/** Thrown when the backend itself is misconfigured (no Access env). Maps to 503. */
export class AccessConfigError extends Error {}
/** Thrown when the caller is not authenticated/authorized. Maps to 403. */
export class AccessDeniedError extends Error {}

// One JWKS per team domain, cached across warm invocations (module scope persists
// between requests on a warm Worker). jose fetches + caches the keys and rotates them.
const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function jwksFor(teamDomain: string) {
  let set = jwksByTeam.get(teamDomain)
  if (!set) {
    set = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`))
    jwksByTeam.set(teamDomain, set)
  }
  return set
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

/**
 * Verify the Access JWT on a request. Returns the caller identity on success.
 * Throws AccessConfigError (→503) if the backend is misconfigured, or
 * AccessDeniedError (→403) if the caller has no valid token. Never returns
 * successfully without a cryptographically verified, correctly-scoped assertion.
 */
export async function verifyAccess(request: Request, env: AccessEnv): Promise<AccessIdentity> {
  const team = env.CF_ACCESS_TEAM_DOMAIN
  const aud = env.CF_ACCESS_AUD
  if (!team || !aud) {
    // Fail closed: with no Access config we refuse, never fall back to open.
    throw new AccessConfigError('Access not configured (CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD)')
  }
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ?? readCookie(request, 'CF_Authorization')
  if (!token) throw new AccessDeniedError('no Access assertion on request')

  let payload: JWTPayload
  try {
    ;({ payload } = await jwtVerify(token, jwksFor(team), { issuer: team, audience: aud }))
  } catch {
    // Bad signature, wrong aud/iss, expired — all are auth failures, not config errors.
    throw new AccessDeniedError('invalid Access assertion')
  }
  return {
    email: typeof payload.email === 'string' ? payload.email : undefined,
    sub: payload.sub,
  }
}
