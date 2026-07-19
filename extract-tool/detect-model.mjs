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

// Default URL: GitHub Release. The 98 MB model exceeds CF Pages' 25 MB
// static-asset cap, so we host on GitHub Releases instead.
const MODEL_URL_DEFAULT = 'https://github.com/anndygarcia/genesis-v0/releases/download/v0.3-walls/walls.onnx';
const IMG_SIZE = 512;
const CLASS_NAMES = ['floor', 'wall', 'door', 'window'];

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
  const session = await ort.InferenceSession.create(modelUrl, {
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
// Returns { doors: [{x, y}], windows: [{x, y}] } in original canvas coords.
export function extractOpenings(mask, meta) {
  const doors = [], windows = [];
  const seen = new Map();  // (x,y) -> { count, isDoor }
  const { offX, offY, scale } = meta;
  for (let y = 0; y < IMG_SIZE; y++) {
    for (let x = 0; x < IMG_SIZE; x++) {
      const cls = mask[y * IMG_SIZE + x];
      if (cls !== 2 && cls !== 3) continue;
      if (x < offX || x >= offX + meta.newW) continue;
      if (y < offY || y >= offY + meta.newH) continue;
      // Bucket to 16-pixel grid to dedupe
      const gx = Math.floor((x - offX) / scale / 16) * 16;
      const gy = Math.floor((y - offY) / scale / 16) * 16;
      const k = `${gx},${gy}`;
      if (!seen.has(k)) seen.set(k, { x: (x - offX) / scale, y: (y - offY) / scale, c: cls, count: 1 });
      else seen.get(k).count++;
    }
  }
  for (const v of seen.values()) {
    if (v.count < 5) continue;  // ignore noise
    const target = v.c === 2 ? doors : windows;
    target.push({ x: v.x, y: v.y, count: v.count });
  }
  return { doors, windows };
}

export { CLASS_NAMES };
