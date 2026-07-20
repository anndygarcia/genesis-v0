// CF Pages Function — streams the Yytsi walls.onnx from GH Releases
// with permissive CORS headers so browser-based ONNX Runtime Web can
// load it without 25 MB asset-cap workarounds.
//
// GH Releases are hosted on Azure Blob without CORS headers, so
// fetches from genesis-mind.com origin are blocked. CF Pages can
// stream the upstream body via a TransformStream without buffering
// the whole model in memory.
//
// Route: GET /api/models/walls → 200 OK with model bytes,
//   content-type application/octet-stream, CORS * enabled.

const GH_RELEASE_URL = 'https://github.com/anndygarcia/genesis-v0/releases/download/v0.3-walls/walls.onnx';

export async function onRequestGet() {
  try {
    const upstream = await fetch(GH_RELEASE_URL, {
      headers: { 'cache-control': 'no-cache' },
    });
    if (!upstream.ok) {
      return new Response(`Upstream ${upstream.status}`, { status: 502 });
    }

    // Stream the upstream body via a TransformStream — we don't
    // buffer the whole ~97 MB in Pages memory.
    const { readable, writable } = new TransformStream();
    upstream.body.pipeTo(writable).catch(() => {});

    return new Response(readable, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
        'content-length': upstream.headers.get('content-length') || '',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-max-age': '86400',
        'cache-control': 'public, max-age=31536000, immutable',
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
