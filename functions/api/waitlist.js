// POST /api/waitlist — capture an email from the homepage form
// In Pages Functions, this is the file `functions/api/waitlist.js`.
// Without Cloudflare KV (which requires a permission we don't have on the
// existing token), we log to the function's stdout and Cloudflare collects
// these logs in the Pages dashboard under project → Functions → Logs.
// A future iteration will bind a KV namespace and persist here.

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_json' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const email = (body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_email' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Best-effort persistence using a KV namespace if bound.
  // Pages will only bind it once KV is added to the project — until then
  // env.GENESIS_KV is undefined and we just log.
  if (env && env.GENESIS_KV) {
    try {
      await env.GENESIS_KV.put(`email:${Date.now()}:${email}`, JSON.stringify({
        email,
        ua: request.headers.get('user-agent') || '',
        country: request.cf?.country || '',
        ts: new Date().toISOString(),
      }));
    } catch (e) {
      console.log('[waitlist] KV put failed:', e.message);
    }
  }

  // Always log so it's visible in the Pages Functions log
  console.log('[waitlist] email:', email, 'country:', request.cf?.country || 'unknown');

  return new Response(JSON.stringify({ ok: true, queued: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Don't let CF cache personal data
      'cache-control': 'no-store',
    },
  });
}

// Friendly response for GETs (some browsers do this preflight-ish)
export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, hint: 'POST { email } to enroll' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
