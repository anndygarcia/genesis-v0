// POST /api/waitlist — capture an email from the homepage form
// Sends a notification to admin via Resend / Mailgun / SendGrid if the
// matching API key is set as an environment variable. Without a key,
// the email is just logged to Pages Functions logs (visible in the
// Cloudflare dashboard). KV persistence is added once the namespace
// is bound via env.GENESIS_KV.

// In-memory dedupe map. CF Pages Functions are isolated per-request but
// module-level state is shared across invocations of the same isolate
// within ~30s of activity. A 10-minute per-email quiet period prevents
// double-submits from spamming the admin inbox.
const RECENT = new Map(); // email -> expiry timestamp (ms)
const DEDUPE_TTL_MS = 10 * 60 * 1000;

function isDuplicate(email) {
  const now = Date.now();
  for (const [k, exp] of RECENT) if (exp < now) RECENT.delete(k);
  if (RECENT.has(email)) return true;
  RECENT.set(email, now + DEDUPE_TTL_MS);
  return false;
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('invalid_json');
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return badRequest('invalid_email');
  }

  // Dedupe double-submits / accidental refreshes
  if (isDuplicate(email)) {
    console.log('[waitlist] dedupe hit for', email);
    return new Response(JSON.stringify({ ok: true, deduped: true }), {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  const entry = {
    email,
    ua: request.headers.get('user-agent') || '',
    country: request.cf?.country || '',
    ts: new Date().toISOString(),
    source: (request.headers.get('referer') || '').slice(0, 200),
  };

  console.log('[waitlist] email:', email, 'country:', entry.country);

  // 1. Persist via KV if bound
  if (env && env.GENESIS_KV) {
    try {
      await env.GENESIS_KV.put(`email:${Date.now()}:${email}`, JSON.stringify(entry));
    } catch (e) {
      console.log('[waitlist] KV put failed:', e.message);
    }
  }

  // 2. Notify admin by email — works the moment a key is set
  const notifyResult = await notifyAdmin(entry, env);
  if (notifyResult.error) {
    console.log('[waitlist] notify failed:', notifyResult.error);
  } else if (notifyResult.sent) {
    console.log('[waitlist] admin notified via', notifyResult.provider);
  }

  // 3. Optional autoresponder to the user ("we'll be in touch")
  if (env && env.AUTORESPOND_FROM && (env.RESEND_API_KEY || env.MAILGUN_API_KEY || env.SENDGRID_API_KEY)) {
    try { await sendAutoresponder(email, env); } catch (e) { console.log('autoresponder:', e.message); }
  }

  return new Response(JSON.stringify({ ok: true, queued: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, hint: 'POST { email }' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

function badRequest(error) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status: 400, headers: { 'content-type': 'application/json' },
  });
}

async function notifyAdmin(entry, env) {
  const subject = `New Genesis waitlist signup: ${entry.email}`;
  const text = [
    'New Genesis waitlist signup',
    '',
    `  Email:   ${entry.email}`,
    `  Country: ${entry.country || 'unknown'}`,
    `  Time:    ${entry.ts}`,
    `  UA:      ${entry.ua}`,
    `  Source:  ${entry.source || '(direct)'}`,
  ].join('\n');
  return sendEmail(env, env.ADMIN_TO || 'anndy@gartex-construction.com', subject, text);
}

async function sendAutoresponder(email, env) {
  const subject = "You're on the Genesis list";
  const text = [
    `Hi,`,
    '',
    `Thanks for requesting early access to Genesis.`,
    '',
    `We're letting in a small cohort of Houston builders and homeowners`,
    `this quarter. We'll email you the moment your slot is open.`,
    '',
    `— The Genesis team`,
    '',
    `--`,
    `genesis-mind.com · AI Blueprint to Interactive 3D Homes`,
  ].join('\n');
  return sendEmail(env, email, subject, text);
}

async function sendEmail(env, to, subject, text) {
  // Try providers in priority order: Resend > Mailgun > SendGrid
  if (env && env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.AUTORESPOND_FROM || 'Genesis <noreply@genesis-mind.com>',
        to: [to],
        subject,
        text,
      }),
    });
    if (r.ok) return { sent: true, provider: 'resend' };
    return { sent: false, error: `resend ${r.status}: ${(await r.text()).slice(0,200)}` };
  }
  if (env && env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN) {
    const form = new URLSearchParams();
    form.set('from', env.AUTORESPOND_FROM || `Genesis <noreply@${env.MAILGUN_DOMAIN}>`);
    form.set('to', to);
    form.set('subject', subject);
    form.set('text', text);
    const r = await fetch(`https://api.mailgun.net/v3/${env.MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: {
        'authorization': 'Basic ' + btoa(`api:${env.MAILGUN_API_KEY}`),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    if (r.ok) return { sent: true, provider: 'mailgun' };
    return { sent: false, error: `mailgun ${r.status}: ${(await r.text()).slice(0,200)}` };
  }
  if (env && env.SENDGRID_API_KEY) {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${env.SENDGRID_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: env.AUTORESPOND_FROM_EMAIL || 'noreply@genesis-mind.com', name: 'Genesis' },
        subject,
        content: [{ type: 'text/plain', value: text }],
      }),
    });
    if (r.status === 202) return { sent: true, provider: 'sendgrid' };
    return { sent: false, error: `sendgrid ${r.status}: ${(await r.text()).slice(0,200)}` };
  }
  return { sent: false, error: 'no_provider' };
}
