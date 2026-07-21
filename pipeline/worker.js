// Server-side AI extraction pipeline.
//
// Reads PDF, rasterizes each page to a canvas, runs the Yytsi
// segmentation model on each page, vectorizes the mask to walls,
// detects doors/windows, fuses into a single plan, and writes
// the final JSON.
//
// Future: this is where the constraint solver, calibration fix,
// and trained model swap will plug in.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
const { createCanvas } = require('canvas');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { PDFDocument } = require('pdf-lib');

const RASTER_SCALE = 2.0;          // target ~2200 px wide
const MODEL_INPUT_SIZE = 512;
const NUM_CLASSES = 4;             // floor, wall, door, window

/**
 * extractPdf(pdfPath, opts, log) -> { plan, detection }
 *
 * Stages:
 *   1. open PDF, count pages
 *   2. for each page: rasterize → run ONNX → 4-class mask
 *   3. vectorize mask → walls, doors, windows
 *   4. fuse multi-page plans
 *   5. calibration (heuristic for now, future: title-block OCR)
 */
export async function extractPdf(pdfPath, opts = {}, log = () => {}) {
  log('load', `loading PDF: ${pdfPath}`);
  const pdfBytes = await fs.readFile(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const numPages = pdfDoc.getPageCount();
  log('load', `${numPages} pages`);

  const session = await loadOnnx(opts.onnxModelPath);
  log('load', `ONNX session ready (input: ${session.inputNames.join(',')})`);

  const pages = [];
  for (let p = 1; p <= numPages; p++) {
    log('render', `page ${p}/${numPages}`);
    const canvas = await rasterizePage(pdfBytes, p, RASTER_SCALE);
    log('infer', `page ${p}/${numPages}`);
    const { mask, meta } = await runSegmentation(session, canvas);
    const wallLines = maskToWallPolylines(mask, meta, canvas.width, canvas.height);
    const openings = extractOpenings(mask, meta, canvas.width, canvas.height);
    pages.push({
      pageNumber: p,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      mask, meta, wallLines, openings,
    });
  }

  log('fuse', `fusing ${pages.length} pages`);
  const plan = fusePages(pages);
  plan.pages = numPages;
  plan.source = 'onnx';
  plan.ppf = estimatePixelsPerFoot(pages[0]);

  return { plan, detection: { source: 'onnx', numPages } };
}

// ---------------------------------------------------------------------------
// PDF → canvas
// ---------------------------------------------------------------------------

async function rasterizePage(pdfBytes, pageNumber, scale = 2.0) {
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    isEvalSupported: false,
  }).promise;
  const page = await doc.getPage(pageNumber);
  const vp = page.getViewport({ scale: 1 });
  const targetScale = scale * 1500 / Math.max(vp.width, vp.height);
  const target = page.getViewport({ scale: targetScale });
  const canvas = createCanvas(target.width, target.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, target.width, target.height);
  await page.render({ canvasContext: ctx, viewport: target }).promise;
  return canvas;
}

// ---------------------------------------------------------------------------
// ONNX
// ---------------------------------------------------------------------------

let _session = null;
let _sessionPath = null;
async function loadOnnx(modelPath, log = () => {}) {
  if (_session && _sessionPath === modelPath) return _session;
  log('load', `loading ONNX from ${modelPath}`);
  _session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
  });
  _sessionPath = modelPath;
  return _session;
}

async function runSegmentation(session, canvas) {
  const W = canvas.width, H = canvas.height;
  const scale = MODEL_INPUT_SIZE / Math.max(W, H);
  const newW = Math.round(W * scale);
  const newH = Math.round(H * scale);
  const offX = Math.floor((MODEL_INPUT_SIZE - newW) / 2);
  const offY = Math.floor((MODEL_INPUT_SIZE - newH) / 2);

  // Letterbox canvas → 512×512
  const lc = createCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  const lctx = lc.getContext('2d');
  lctx.fillStyle = 'white';
  lctx.fillRect(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  lctx.drawImage(canvas, offX, offY, newW, newH);

  // ImageNet normalization
  const mean = [0.485, 0.456, 0.406];
  const std  = [0.229, 0.224, 0.225];
  const data = lctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE).data;
  const float = new Float32Array(1 * 3 * MODEL_INPUT_SIZE * MODEL_INPUT_SIZE);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    float[j]     = (data[i]     / 255 - mean[0]) / std[0];
    float[j + 1] = (data[i + 1] / 255 - mean[1]) / std[1];
    float[j + 2] = (data[i + 2] / 255 - mean[2]) / std[2];
  }
  const tensor = new ort.Tensor('float32', float, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
  const outputs = await session.run({ image: tensor });
  const logits = outputs.logits;
  const mask = argmax(logits.data, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);

  return {
    mask,
    meta: {
      inputSize: MODEL_INPUT_SIZE,
      offX, offY,
      scale,
      origW: W, origH: H,
    },
  };
}

function argmax(data, H, W) {
  const out = new Uint8Array(H * W);
  const C = data.length / (H * W);
  for (let i = 0; i < H * W; i++) {
    let best = 0, bestVal = -Infinity;
    for (let c = 0; c < C; c++) {
      const v = data[i + c * H * W];
      if (v > bestVal) { bestVal = v; best = c; }
    }
    out[i] = best;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vectorize mask → walls (simplified; constraint solver lands next)
// ---------------------------------------------------------------------------

function maskToWallPolylines(mask, meta, canvasW, canvasH) {
  // For now: extract all wall-class pixels and trace them as
  // polylines via a basic 8-connected path-follower. The constraint
  // solver (orthogonal snap, length quantization) lands in v2.
  const walls = [];
  const visited = new Uint8Array(mask.length);
  const W = meta.inputSize, H = meta.inputSize;

  // Reverse-map letterbox coords → canvas coords
  function toCanvas(x, y) {
    const px = (x - meta.offX) / meta.scale;
    const py = (y - meta.offY) / meta.scale;
    return [px, py];
  }

  // Find a starting wall pixel and follow its connected component
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i] !== 1 || visited[i]) continue;
      const poly = [];
      const stack = [[x, y]];
      while (stack.length) {
        const [cx, cy] = stack.pop();
        const ci = cy * W + cx;
        if (visited[ci] || mask[ci] !== 1) continue;
        visited[ci] = 1;
        const [px, py] = toCanvas(cx, cy);
        poly.push([px, py]);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            stack.push([nx, ny]);
          }
        }
      }
      if (poly.length > 5) {
        walls.push({ name: `Wall ${walls.length + 1}`, points: poly });
      }
    }
  }
  return walls;
}

function extractOpenings(mask, meta, canvasW, canvasH) {
  // For now: extract connected components of door and window classes,
  // centroid + bounding box. Future: use YOLOv8 detector for better
  // accuracy on small objects.
  const doors = [];
  const windows = [];
  const visited = new Uint8Array(mask.length);
  const W = meta.inputSize, H = meta.inputSize;

  function toCanvas(x, y) {
    const px = (x - meta.offX) / meta.scale;
    const py = (y - meta.offY) / meta.scale;
    return [px, py];
  }

  for (let cls = 2; cls <= 3; cls++) {
    const target = cls === 2 ? doors : windows;
    visited.fill(0);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (mask[i] !== cls || visited[i]) continue;
        let minX = x, maxX = x, minY = y, maxY = y;
        const stack = [[x, y]];
        while (stack.length) {
          const [cx, cy] = stack.pop();
          const ci = cy * W + cx;
          if (visited[ci] || mask[ci] !== cls) continue;
          visited[ci] = 1;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
              stack.push([nx, ny]);
            }
          }
        }
        if (maxX - minX >= 3 && maxY - minY >= 3) {
          const [px, py] = toCanvas((minX + maxX) / 2, (minY + maxY) / 2);
          const [wPx, hPx] = [
            (maxX - minX) / meta.scale,
            (maxY - minY) / meta.scale,
          ];
          target.push({
            kind: cls === 2 ? 'door' : 'window',
            x: px, y: py,
            w: wPx, h: hPx,
          });
        }
      }
    }
  }
  return { doors, windows };
}

// ---------------------------------------------------------------------------
// Fuse multi-page
// ---------------------------------------------------------------------------

function fusePages(pages) {
  // Concatenate walls, doors, windows. Future: stitch pages via
  // detected page breaks; right now each page is treated as its own
  // floor (matches multi-story plans).
  const walls = [];
  const doors = [];
  const windows = [];
  for (let p = 0; p < pages.length; p++) {
    for (const w of pages[p].wallLines) {
      walls.push({ ...w, page: pages[p].pageNumber });
    }
    for (const d of pages[p].openings.doors) {
      doors.push({ ...d, page: pages[p].pageNumber });
    }
    for (const w of pages[p].openings.windows) {
      windows.push({ ...w, page: pages[p].pageNumber });
    }
  }
  return {
    walls,
    doors,
    windows,
    rooms: [],  // Future: constraint solver fills these
  };
}

function estimatePixelsPerFoot(page) {
  // Heuristic DPI estimate. Future: read title block OCR.
  // For architectural plans at 22×34 inches drawn at typical scale,
  // 1 foot ≈ canvas width / (avg house length in feet).
  // Until then: assume 22 ft × 34 ft (smallest reasonable room),
  // so ppf = canvasW / 22.
  return page.canvasWidth / 22;
}