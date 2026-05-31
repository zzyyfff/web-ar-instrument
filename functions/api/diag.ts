// Cloudflare Pages Function: /api/diag  (SECURE reference backend)
//
// POST  → append a JSON diagnostic batch to R2 under diag/<session>/<ts>.json.
// GET   → ?session=<id> merges a session's entries; no args lists sessions.
//
// Gated by Cloudflare Access + JWT verification, fails closed without the storage
// binding, and CORS is LOCKED to ALLOWED_ORIGIN. (The earlier version of this route
// shipped `Access-Control-Allow-Origin: *` in front of unauthenticated R2 — exactly
// the anti-pattern this repo exists to correct; see SECURITY.md.)

import { gate, json, corsHeaders, type CorsEnv } from '../_lib/http'
import type { AccessEnv } from '../_lib/access'

interface Env extends AccessEnv, CorsEnv {
  RECORDINGS?: R2Bucket
}

const MAX_DIAG_SIZE = 256 * 1024 // 256 KB per batch
const SESSION_RE = /[^a-zA-Z0-9_-]/g // sanitize session ids used in object keys

export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) =>
  new Response(null, { status: 204, headers: corsHeaders(request, env) })

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const blocked = await gate(request, { ...env, storageBound: !!env.RECORDINGS })
  if (blocked) return blocked
  const bucket = env.RECORDINGS as R2Bucket
  const cors = corsHeaders(request, env)

  const buf = await request.arrayBuffer()
  if (buf.byteLength > MAX_DIAG_SIZE) return json(413, { error: 'too large' }, cors)
  const url = new URL(request.url)
  const session = (url.searchParams.get('session') || 'anon').replace(SESSION_RE, '').slice(0, 32)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  await bucket.put(`diag/${session}/${ts}.json`, buf, {
    httpMetadata: { contentType: 'application/json' },
  })
  return json(200, { ok: true, session, size: buf.byteLength }, cors)
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const blocked = await gate(request, { ...env, storageBound: !!env.RECORDINGS })
  if (blocked) return blocked
  const bucket = env.RECORDINGS as R2Bucket
  const cors = corsHeaders(request, env)

  const url = new URL(request.url)
  const session = url.searchParams.get('session')
  if (session) {
    const safe = session.replace(SESSION_RE, '').slice(0, 32)
    const list = await bucket.list({ prefix: `diag/${safe}/`, limit: 200 })
    const items = list.objects.sort((a, b) => a.key.localeCompare(b.key))
    const merged: unknown[] = []
    for (const item of items) {
      const obj = await bucket.get(item.key)
      if (!obj) continue
      try {
        const parsed = JSON.parse(await obj.text())
        if (Array.isArray(parsed)) merged.push(...parsed)
        else merged.push(parsed)
      } catch {
        /* skip unparseable */
      }
    }
    return json(200, { session: safe, count: items.length, entries: merged }, cors)
  }

  // List sessions newest-first, following the cursor so nothing is silently truncated.
  const prefix = (url.searchParams.get('prefix') || '').replace(SESSION_RE, '').slice(0, 32)
  const latest = new Map<string, number>()
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix: `diag/${prefix}`, limit: 1000, cursor })
    for (const obj of page.objects) {
      const m = obj.key.match(/^diag\/([^/]+)\//)
      if (!m) continue
      const up = +new Date(obj.uploaded)
      if (up > (latest.get(m[1]) ?? 0)) latest.set(m[1], up)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  const sessions = [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, up]) => ({ session: s, lastUpload: new Date(up).toISOString() }))
  return json(200, { prefix: prefix || null, count: sessions.length, sessions }, cors)
}
