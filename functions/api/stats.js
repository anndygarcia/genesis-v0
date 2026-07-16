// GET /api/stats — admin view, returns aggregated stats
// Same KV pattern as waitlist. When KV is bound, returns emails + visit counts.
// Falls back to a graceful empty response.

export async function onRequestGet({ request, env, url }) {
  const adminKey = request.headers.get('x-admin-key') || url.searchParams.get('key');
  const expected = env && env.ADMIN_KEY;
  if (!expected || adminKey !== expected) {
    return new Response('forbidden', { status: 403 });
  }

  const out = {
    ok: true,
    visits: 0,
    emails: [],
    note: 'Waiting for KV binding — once added, this endpoint reads from KV.',
  };

  if (env && env.GENESIS_KV) {
    try {
      // Read all email:* keys
      const keys = await env.GENESIS_KV.list({ prefix: 'email:' });
      out.emails = [];
      for (const k of keys.keys) {
        const v = await env.GENESIS_KV.get(k.name);
        if (v) out.emails.push(JSON.parse(v));
      }
      out.visits = out.emails.length; // crude proxy
    } catch (e) {
      out.error = e.message;
    }
  }

  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
