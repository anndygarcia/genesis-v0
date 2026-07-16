// GET /api/stats — admin view, returns aggregated stats.
// Auth: HTTP Basic, where the password matches env.ADMIN_KEY.
// Falls back to a graceful empty response if KV is not bound.

export async function onRequest({ request, env }) {
  // HTTP Basic auth
  const auth = request.headers.get('authorization') || '';
  if (!env.ADMIN_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'ADMIN_KEY env not set' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
  }
  if (!auth.startsWith('Basic ')) {
    return new Response('Auth required', {
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="Genesis stats"' },
    });
  }
  let provided = '';
  try {
    provided = atob(auth.slice(6));
  } catch { /* fall through */ }
  // HTTP Basic auth: "username:password" — password is everything after the first colon
  const providedPassword = provided.includes(':') ? provided.split(':').slice(1).join(':') : provided;
  const expected = env.ADMIN_KEY;
  if (providedPassword !== expected) {
    return new Response('Forbidden', { status: 403 });
  }

  const out = { ok: true, emails: [], visitCount: 0, note: null };

  if (env && env.GENESIS_KV) {
    try {
      const keys = await env.GENESIS_KV.list({ prefix: 'email:' });
      out.emails = [];
      for (const k of keys.keys) {
        const v = await env.GENESIS_KV.get(k.name);
        if (v) out.emails.push(JSON.parse(v));
      }
      // crude visit count = unique IPs seen in /api/visit records (if any)
      const visits = await env.GENESIS_KV.list({ prefix: 'visit:' });
      out.visitCount = visits.keys.length;
    } catch (e) {
      out.error = e.message;
    }
  } else {
    out.note = 'No KV namespace bound. To enable real stats: Cloudflare dashboard → Pages → genesis-v0 → Settings → Functions → KV namespace bindings → add GENESIS_KV.';
  }

  return new Response(JSON.stringify(out, null, 2), {
    status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
