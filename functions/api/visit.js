// POST /api/visit — fired by navigator.sendBeacon() on page load
// Stores visits in KV if bound; otherwise no-op. Returns 204 always.

export async function onRequestPost({ request, env }) {
  let body = {};
  try {
    body = await request.json();
  } catch { /* no body required */ }

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const entry = {
    ip,
    country: request.cf?.country || '',
    ua: request.headers.get('user-agent') || '',
    url: (body && body.url) || '/',
    ts: new Date().toISOString(),
  };

  if (env && env.GENESIS_KV) {
    try {
      // Use hash-of-IP to dedupe visits per IP per day
      const day = entry.ts.slice(0, 10);
      const seenKey = `visit:${day}:${ip}`;
      const seen = await env.GENESIS_KV.get(seenKey);
      if (seen) {
        // Update existing
        const seenData = JSON.parse(seen);
        seenData.last_ts = entry.ts;
        await env.GENESIS_KV.put(seenKey, JSON.stringify(seenData));
      } else {
        await env.GENESIS_KV.put(seenKey, JSON.stringify({ first_ts: entry.ts, last_ts: entry.ts, ...entry }));
      }
    } catch (e) {
      console.log('[visit] KV put failed:', e.message);
    }
  }

  return new Response(null, { status: 204 });
}

// sendBeacon sometimes sends text/plain
export async function onRequest({ request, env }) {
  if (request.method !== 'POST') {
    return new Response('POST only', { status: 405 });
  }
  return onRequestPost({ request, env });
}
