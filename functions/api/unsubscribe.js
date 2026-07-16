// GET /api/unsubscribe?email=user@example.com
// Logs the opt-out and returns a confirmation page. Without KV we cannot
// persist the unsubscribed address — this is best-effort. Once a KV
// namespace is bound as env.GENESIS_KV, the opt-out is written under
// "unsub:<email>" and future waitlist calls for the same email are blocked.

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();

  // Render a small confirmation HTML page either way
  const page = (status) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Genesis — unsubscribed</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2300d4ff'/%3E%3Ctext x='16' y='22' font-family='system-ui' font-size='18' font-weight='700' text-anchor='middle' fill='%23001018'%3EG%3C/text%3E%3C/svg%3E">
<style>
  body{margin:0;background:#06090f;color:#e6edf3;font:15px/1.55 system-ui,-apple-system,Segoe UI,Inter,sans-serif;}
  .wrap{max-width:520px;margin:60px auto;padding:36px;background:#0b1320;border:1px solid rgba(255,255,255,0.07);border-radius:14px;}
  h1{color:#00d4ff;font-size:22px;margin:0 0 12px;}
  p{color:#9aa3b2;font-size:14.5px;}
  a{color:#00d4ff;text-decoration:none;}
  code{background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;font-size:13px;}
  .brand{color:#00d4ff;font-weight:600;letter-spacing:0.04em;}
</style>
</head>
<body>
  <div class="wrap">
    <span class="brand">GENESIS</span>
    <h1>${status}</h1>
    <p>You're opted out of the Genesis waitlist.</p>
    <p>If this was a mistake, <a href="https://genesis-mind.com#waitlist">sign back up</a> anytime.</p>
    <p style="margin-top:24px;font-size:13px;">Address: <code>${email.replace(/[<>&]/g, '')}</code></p>
  </div>
</body>
</html>`;

  // Persist if KV is bound
  if (env && env.GENESIS_KV && email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    try {
      await env.GENESIS_KV.put('unsub:' + email, JSON.stringify({ ts: new Date().toISOString() }));
    } catch (e) { console.log('unsub KV write failed:', e.message); }
  }

  // Also log so it's visible in CF Function logs even without KV
  console.log('[unsub]', email || '(no email provided)');

  // Note: this endpoint does not check ADMIN_KEY — it's meant to be opened
  // from an email link by the recipient. The /api/waitlist path is the one
  // that would block re-subscribes from the same address (TODO: when KV exists).

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(page('Hmm — no email address in that link.'), {
      status: 400, headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  return new Response(page('You\'re unsubscribed.'), {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
