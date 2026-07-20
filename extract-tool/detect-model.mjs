// GENESIS · extract-tool/detect-model.mjs
//
// Wall + door + window segmentation using the Yytsi/floorplan-to-3d-walls
// ONNX model (UNet + ResNet-34, fine-tuned on CubiCasa5K, 0.983 mIoU).
//
// The model is downloaded once and cached by the browser/Node. We run it
// via ONNX Runtime — `onnxruntime-web` in the browser, `onnxruntime-node`
// in Node. Both expose the same `InferenceSession` API.
//
// Output: a 4-class mask at 512×512 (letterbox-padded) plus the original
// canvas dimensions + the letterbox offset, so callers can map pixels
// back to the original canvas coordinates.

// Default URL: same-origin CF Pages Function that streams the model
// from GitHub Releases and adds CORS headers. jsdelivr's gh-mirror
// has a 20 MB per-file cap (models are ~97 MB), and CF Pages has a
// 25 MB static-asset cap — neither hosts the model directly. The
// Function fetch()es from GH Releases, streams the body through a
// TransformStream, and returns it with `access-control-allow-origin: *`.
const MODEL_URL_DEFAULT = '/api/walls';
const IMG_SIZE = 512;
const CLASS_NAMES = ['floor', 'wall', 'door', 'window'];

// Resolve a model URL to bytes that ORT can load.
// In the browser, ORT passes a `string` URL straight to fetch — which
// fails when the model CDN doesn't return CORS headers. We download
// the URL ourselves (so we can surface failures clearly), then hand
// ORT a Uint8Array. In Node, ORT only loads from disk, so we cache the
// download to a local file (idempotent — re-runs use the file).
async function localModelPath(modelUrlOrPath) {
  // Already a local path (no scheme, starts with ./, etc.)
  if (!modelUrlOrPath.startsWith('http://') && !modelUrlOrPath.startsWith('https://')) {
    return modelUrlOrPath;
  }
  // Browser: fetch the URL ourselves, then pass bytes to ORT.
  if (typeof document !== 'undefined') {
    const res = await fetch(modelUrlOrPath, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(
        `Failed to download model from ${modelUrlOrPath}: HTTP ${res.status}`
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  // Node: download to a cache file. Use createRequire so `require` is
  // available in pure ESM contexts.
  const isNode = typeof process !== 'undefined' && process.versions?.node;
  if (!isNode) return modelUrlOrPath;
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const fsSync = req('fs');
  const fs = fsSync.promises;
  const path = req('path');
  const cacheDir = process.platform === 'win32'
    ? (process.env.TEMP || 'C:\\Temp')
    : '/tmp/genesis-extract-cache';
  await fs.mkdir(cacheDir, { recursive: true });
  const name = path.basename(new URL(modelUrlOrPath).pathname) || 'walls.onnx';
  const cached = path.join(cacheDir, name);
  try {
    await fs.access(cached);
    return cached;
  } catch {
    const res = await fetch(modelUrlOrPath, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${modelUrlOrPath}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(cached, buf);
    return cached;
  }
}

// Preprocessing: letterbox-resize + ImageNet normalization.
// Returns tensor of shape [1, 3, 512, 512] plus the unpad transform.
export async function preprocessImage(canvas) {
  const W = canvas.width, H = canvas.height;
  const scale = IMG_SIZE / Math.max(W, H);
  const newW = Math.round(W * scale), newH = Math.round(H * scale);
  const offX = Math.floor((IMG_SIZE - newW) / 2);
  const offY = Math.floor((IMG_SIZE - newH) / 2);

  // Draw onto a 512×512 canvas, padding with ImageNet-mean fill (gray).
  // Use whatever canvas API is available (browser: HTMLCanvasElement,
  // Node: node-canvas).
  let pad;
  if (typeof document !== 'undefined') {
    pad = document.createElement('canvas');
  } else {
    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    const { createCanvas } = nodeRequire('canvas');
    pad = createCanvas(IMG_SIZE, IMG_SIZE);
  }
  pad.width = IMG_SIZE; pad.height = IMG_SIZE;
  const pctx = pad.getContext('2d');
  pctx.fillStyle = 'rgb(124,116,104)';  // 0.485, 0.456, 0.406 × 255
  pctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);
  pctx.drawImage(canvas, offX, offY, newW, newH);
  // Read back as ImageData
  const id = pctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE);
  const data = id.data;
  // Convert H,W,4 → 1,3,512,512 with ImageNet normalization
  const tensor = new Float32Array(1 * 3 * IMG_SIZE * IMG_SIZE);
  const mean = [0.485, 0.456, 0.406];
  const std  = [0.229, 0.224, 0.225];
  for (let y = 0; y < IMG_SIZE; y++) {
    for (let x = 0; x < IMG_SIZE; x++) {
      const idx = (y * IMG_SIZE + x) * 4;
      const r = data[idx + 0] / 255;
      const g = data[idx + 1] / 255;
      const b = data[idx + 2] / 255;
      tensor[(0) * IMG_SIZE * IMG_SIZE + y * IMG_SIZE + x] = (r - mean[0]) / std[0];
      tensor[(1) * IMG_SIZE * IMG_SIZE + y * IMG_SIZE + x] = (g - mean[1]) / std[1];
      tensor[(2) * IMG_SIZE * IMG_SIZE + y * IMG_SIZE + x] = (b - mean[2]) / std[2];
    }
  }
  return {
    tensor,
    meta: { origW: W, origH: H, scale, offX, offY, newW, newH },
  };
}

// Run inference on a canvas. Returns:
//   mask: Uint8Array of length IMG_SIZE*IMG_SIZE — class per pixel
//   meta: same meta returned by preprocessImage
export async function segmentWithModel(canvas, { modelUrl = MODEL_URL_DEFAULT } = {}) {
  // Use onnxruntime-web in the browser; onnxruntime-node in Node.
  // Detect at runtime — globalThis.__useOrt is set by the Node CLI
  // entry point if available.
  let ort;
  let providers = ['wasm'];  // browser default
  if (typeof globalThis !== 'undefined' && globalThis.__useOrt) {
    ort = globalThis.__useOrt;
    providers = ['cpu'];  // node: cpu is bundled
  } else if (typeof process !== 'undefined' && process.versions?.node) {
    const nodeMod = await import('onnxruntime-node');
    ort = nodeMod.default || nodeMod;
    providers = ['cpu'];
  } else {
    const webMod = await import('onnxruntime-web');
    ort = webMod.default || webMod;
    providers = ['wasm'];
  }
  const session = await ort.InferenceSession.create(await localModelPath(modelUrl), {
    executionProviders: providers,
  });
  const { tensor, meta } = await preprocessImage(canvas);
  const feeds = { image: new ort.Tensor('float32', tensor, [1, 3, IMG_SIZE, IMG_SIZE]) };
  const { logits } = await session.run(feeds);
  const data = logits.data;  // Float32Array, length 1*4*512*512
  const mask = new Uint8Array(IMG_SIZE * IMG_SIZE);
  for (let y = 0; y < IMG_SIZE; y++) {
    for (let x = 0; x < IMG_SIZE; x++) {
      const base = (y * IMG_SIZE + x);
      let bestC = 0, bestV = -Infinity;
      for (let c = 0; c < 4; c++) {
        const v = data[c * IMG_SIZE * IMG_SIZE + base];
        if (v > bestV) { bestV = v; bestC = c; }
      }
      mask[base] = bestC;
    }
  }
  return { mask, meta };
}

// Convert a mask + meta back into original-canvas pixel coords.
//   - wallMask: Uint8Array [H*W] of 0/1 (binary, class 1 only)
//   - canvasW/H: original canvas dims
//   - meta: returned from preprocessImage
export function maskToWallPolylines(mask, meta, { canvasW, canvasH }) {
  const lines = [];
  const { offX, offY, scale } = meta;
  // Helper: convert mask[x,y] (in 512 space) → original canvas (x, y)
  const toOrig = (mx, my) => {
    if (mx < offX || mx >= offX + meta.newW) return null;
    if (my < offY || my >= offY + meta.newH) return null;
    return [(mx - offX) / scale, (my - offY) / scale];
  };
  const isWall = (x, y) => mask[y * IMG_SIZE + x] === 1;

  // Helper: scan along an axis, find runs ≥ minLen with a small gap tolerance.
  // Walls in the model mask may be 1px wide; real walls stay contiguous
  // across multiple rows when projected.
  function scanRuns(getIsOn, maxIdx, minLen, gap = 1) {
    const out = [];
    let runStart = -1;
    let gapCount = 0;
    function flushRun(runEnd) {
      if (runStart < 0) return;
      if (runEnd - runStart >= minLen) out.push([runStart, runEnd]);
      runStart = -1;
      gapCount = 0;
    }
    for (let i = 0; i < maxIdx; i++) {
      const inside = getIsOn(i);
      if (inside) {
        if (runStart < 0) runStart = i;
        gapCount = 0;
      } else if (runStart >= 0 && gapCount < gap) {
        gapCount++;
      } else {
        flushRun(i - 1 - gapCount);
      }
    }
    flushRun(maxIdx - 1);  // edge: flush any run that reached the end
    return out;
  }

  // Horizontal scan: for each row, find horizontal wall runs
  let hTotal = 0;
  for (let y = 0; y < IMG_SIZE; y++) {
    const runs = scanRuns(x => isWall(x, y), IMG_SIZE, 8, 2);
    for (const [s, e] of runs) {
      const a = toOrig(s, y);
      const b = toOrig(e, y);
      if (a && b) {
        lines.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], score: e - s });
        hTotal++;
      }
    }
  }
  // Vertical scan: for each column, find vertical wall runs.
  // Note: isWall(a, b) = mask[b*512+a], so for column x we want
  // getIsOn(y) = isWall(x, y).
  let vTotal = 0;
  for (let x = 0; x < IMG_SIZE; x++) {
    const col = (y) => isWall(x, y);
    const runs = scanRuns(col, IMG_SIZE, 8, 2);
    for (const [s, e] of runs) {
      const a = toOrig(x, s);
      const b = toOrig(x, e);
      if (a && b) {
        lines.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], score: e - s });
        vTotal++;
      }
    }
  }
  if (typeof process !== 'undefined' && process.env?.DEBUG_DETECT) {
    console.log(`maskToWallPolylines: hRuns=${hTotal} vRuns=${vTotal}`);
  }
  // Filter very short runs.
  const minMaskLen = 30;
  return lines.filter(L => L.score >= minMaskLen);
}

// Extract door + window positions from the model mask.
// Returns:
//   doors:    [{x, y, w, h, px, py}]  in original canvas pixel coords
//   windows:  [{x, y, w, h, px, py}]  in original canvas pixel coords
// The (px, py) pair is the opening's centroid in pixel space; x/y/w/h
// form the oriented bounding box in feet-space once callers apply
// pixelsPerFoot. The orientation (whether w or h is the long axis)
// determines which wall it lives on — horizontally-leaning openings
// attach to vertical walls and vice versa.
export function extractOpenings(mask, meta) {
  const doors = [], windows = [];
  const seen = new Map();  // bucket key -> {min, max, count, c, sumX, sumY}
  const { offX, offY, scale } = meta;
  for (let y = 0; y < IMG_SIZE; y++) {
    for (let x = 0; x < IMG_SIZE; x++) {
      const cls = mask[y * IMG_SIZE + x];
      if (cls !== 2 && cls !== 3) continue;
      if (x < offX || x >= offX + meta.newW) continue;
      if (y < offY || y >= offY + meta.newH) continue;
      // Bucket to 16-pixel grid (in mask space) to dedupe and create
      // one opening region per cluster.
      const gx = Math.floor((x - offX) / scale / 16) * 16;
      const gy = Math.floor((y - offY) / scale / 16) * 16;
      const k = `${gx},${gy}`;
      const px = (x - offX) / scale;  // pixel-space centroid
      const py = (y - offY) / scale;
      if (!seen.has(k)) {
        seen.set(k, { c: cls, count: 0, sumX: 0, sumY: 0,
                     minX: px, maxX: px, minY: py, maxY: py });
      }
      const v = seen.get(k);
      v.count++;
      v.sumX += px;
      v.sumY += py;
      if (px < v.minX) v.minX = px;
      if (px > v.maxX) v.maxX = px;
      if (py < v.minY) v.minY = py;
      if (py > v.maxY) v.maxY = py;
    }
  }
  for (const v of seen.values()) {
    if (v.count < 5) continue;  // ignore noise
    const target = v.c === 2 ? doors : windows;
    target.push({
      // Centroid in original-canvas pixel coords.
      px: v.sumX / v.count,
      py: v.sumY / v.count,
      // Oriented bbox in original pixel coords.
      x: v.minX, y: v.minY,
      w: v.maxX - v.minX,
      h: v.maxY - v.minY,
      count: v.count,
    });
  }
  return { doors, windows };
}

export { CLASS_NAMES };
