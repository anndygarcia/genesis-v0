// CF Pages Function: proxy upload + status polling to the Railway
// pipeline. CF Pages has a 30s/request limit, so we don't process
// PDFs here — we hand off to Railway where the worker has unlimited
// CPU time. Returns the job_id immediately; front-end polls.
//
// Routes (single function, internal dispatch by query string):
//   POST /api/extract                          -> proxies POST to Railway /api/extract
//   GET  /api/extract?id=<job_id>              -> proxies GET to Railway /api/jobs/:id
//   GET  /api/extract?plan=1&id=<job_id>       -> proxies GET to Railway /api/jobs/:id/plan
//                                                 (avoids the need for /api/extract/plan.js)

const PIPELINE_URL_DEFAULT = 'http://localhost:8080';

export async function onRequestPost({ request, env }) {
  const url = (env && env.PIPELINE_URL) || PIPELINE_URL_DEFAULT;
  try {
    const form = await request.formData();
    const pdf = form.get('pdf');
    if (!pdf) {
      return json({ error: 'no pdf file in form' }, 400);
    }
    const out = new FormData();
    out.append('pdf', pdf, pdf.name || 'plan.pdf');

    const res = await fetch(`${url}/api/extract`, {
      method: 'POST',
      body: out,
    });
    if (!res.ok) {
      const errBody = await res.text();
      return json({
        error: `pipeline returned ${res.status}`,
        body: errBody.slice(0, 500),
      }, 502);
    }
    const data = await res.json();
    return json(data, 202);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const isPlan = url.searchParams.get('plan') === '1';
  if (!id) return json({ error: 'missing id' }, 400);
  const base = (env && env.PIPELINE_URL) || PIPELINE_URL_DEFAULT;

  const proxyPath = isPlan ? `/api/jobs/${id}/plan` : `/api/jobs/${id}`;
  try {
    const res = await fetch(`${base}${proxyPath}`);
    if (!res.ok) return json({ error: `pipeline ${res.status}` }, 502);
    return json(await res.json());
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
  });
}