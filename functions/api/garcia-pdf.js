// CF Pages Function — serves the Garcia Residence.pdf fixture from
// the raw GitHub URL, with permissive CORS. Used for live testing
// the model path on a real architectural plan.
//
// Route: GET /api/garcia-pdf → 200 OK with PDF bytes,
//   content-type application/pdf, CORS * enabled.

const GH_RAW_URL = 'https://raw.githubusercontent.com/anndygarcia/genesis-v0/main/extract-tool/test-fixtures/garcia-residence.pdf';

export async function onRequestGet() {
  try {
    const upstream = await fetch(GH_RAW_URL, {
      headers: { 'cache-control': 'no-cache' },
    });
    if (!upstream.ok) {
      return new Response(`Upstream ${upstream.status}`, { status: 502 });
    }
    const { readable, writable } = new TransformStream();
    upstream.body.pipeTo(writable).catch(() => {});
    return new Response(readable, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-length': upstream.headers.get('content-length') || '',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-max-age': '86400',
        'cache-control': 'public, max-age=300',
      },
    });
  } catch (e) {
    return new Response(`Proxy error: ${e.message}`, { status: 500 });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}
