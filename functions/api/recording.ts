// Cloudflare Pages Function: /api/recording  (SECURE reference backend)
//
// POST  → accept sensor+camera JSON, write to R2.  POST ?video=rec_xxx → binary video.
// GET   → ?id=rec_xxx fetches JSON; ?video=rec_xxx fetches video; no args lists 50 recent.
//
// EVERY handler is gated by Cloudflare Access + JWT verification and fails closed if
// the storage binding or Access config is missing. CORS is locked to ALLOWED_ORIGIN.
// Object keys are generated server-side (never caller-controlled) so there is no path
// traversal. This is the secure-by-default rewrite of an earlier OPEN proxy — see
// SECURITY.md ("What this corrects").

import { gate, json, corsHeaders, type CorsEnv } from '../_lib/http'
import type { AccessEnv } from '../_lib/access'

interface Env extends AccessEnv, CorsEnv {
  /** R2 bucket binding (configured by the deployer; nothing private hardcoded). */
  RECORDINGS?: R2Bucket
}

const MAX_JSON_SIZE = 25 * 1024 * 1024 // 25 MB
const MAX_VIDEO_SIZE = 60 * 1024 * 1024 // 60 MB
const REC_ID_RE = /^rec_[a-z0-9]+$/ // server-generated ids only

function shortId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8)
}

export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) =>
  new Response(null, { status: 204, headers: corsHeaders(request, env) })

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const blocked = await gate(request, { ...env, storageBound: !!env.RECORDINGS })
  if (blocked) return blocked
  const bucket = env.RECORDINGS as R2Bucket
  const cors = corsHeaders(request, env)

  const url = new URL(request.url)
  const videoId = url.searchParams.get('video')
  if (videoId) {
    if (!REC_ID_RE.test(videoId)) return json(400, { error: 'invalid video id' }, cors)
    const ct = request.headers.get('content-type') || ''
    if (!ct.startsWith('video/')) return json(400, { error: 'expected video/* content-type' }, cors)
    const buf = await request.arrayBuffer()
    if (buf.byteLength > MAX_VIDEO_SIZE) return json(413, { error: 'video too large' }, cors)
    if (buf.byteLength < 1024) return json(400, { error: 'video too small' }, cors)
    const ext = ct.includes('mp4') ? 'mp4' : 'webm'
    await bucket.put(`recordings/${videoId}.video.${ext}`, buf, {
      httpMetadata: { contentType: ct },
    })
    return json(200, { id: videoId, video_size_bytes: buf.byteLength, ext }, cors)
  }

  const ct = request.headers.get('content-type') || ''
  if (!ct.includes('application/json')) return json(400, { error: 'expected application/json' }, cors)
  const buf = await request.arrayBuffer()
  if (buf.byteLength > MAX_JSON_SIZE) return json(413, { error: 'body too large' }, cors)
  if (buf.byteLength < 64) return json(400, { error: 'body too small' }, cors)

  let durationS = 0
  try {
    const parsed = JSON.parse(new TextDecoder().decode(buf)) as { durationMs?: number }
    if (typeof parsed.durationMs === 'number') durationS = parsed.durationMs / 1000
  } catch {
    return json(400, { error: 'body is not valid JSON' }, cors)
  }

  const id = `rec_${shortId()}`
  await bucket.put(`recordings/${id}.json`, buf, {
    httpMetadata: { contentType: 'application/json' },
  })
  return json(
    200,
    { id, size_bytes: buf.byteLength, duration_s: Math.round(durationS * 10) / 10, ts: new Date().toISOString() },
    cors,
  )
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const blocked = await gate(request, { ...env, storageBound: !!env.RECORDINGS })
  if (blocked) return blocked
  const bucket = env.RECORDINGS as R2Bucket
  const cors = corsHeaders(request, env)

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  const videoId = url.searchParams.get('video')

  if (videoId) {
    if (!REC_ID_RE.test(videoId)) return json(400, { error: 'invalid video id' }, cors)
    for (const ext of ['mp4', 'webm']) {
      const obj = await bucket.get(`recordings/${videoId}.video.${ext}`)
      if (obj) {
        return new Response(await obj.arrayBuffer(), {
          status: 200,
          headers: { 'Content-Type': `video/${ext}`, ...cors },
        })
      }
    }
    return json(404, { error: 'video not found' }, cors)
  }

  if (id) {
    if (!REC_ID_RE.test(id)) return json(400, { error: 'invalid id' }, cors)
    const obj = await bucket.get(`recordings/${id}.json`)
    if (!obj) return json(404, { error: 'not found' }, cors)
    return new Response(await obj.text(), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    })
  }

  // List recordings newest-first. R2 lists in KEY order, and the recordings/ prefix
  // also contains the *.video.* siblings — so a naive limit-50 + map would drop newer
  // recordings and emit malformed ids for video objects. Follow the cursor, keep only
  // the JSON recording objects, sort by upload time, then take the newest 50.
  const JSON_KEY_RE = /^recordings\/(rec_[a-z0-9]+)\.json$/
  const all: Array<{ id: string; size_bytes: number; uploaded: Date }> = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix: 'recordings/', limit: 1000, cursor })
    for (const o of page.objects) {
      const m = o.key.match(JSON_KEY_RE)
      if (m) all.push({ id: m[1], size_bytes: o.size, uploaded: o.uploaded })
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  all.sort((a, b) => +new Date(b.uploaded) - +new Date(a.uploaded))
  const items = all.slice(0, 50)
  return json(200, { count: items.length, items }, cors)
}
