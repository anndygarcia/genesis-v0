// GENESIS · extract-tool/detect.mjs
//
// Wall detection from a raster floor plan.
//
// v0.2 uses a classical CV pipeline (no ML model download):
//   1. Convert to grayscale
//   2. Canny edge detection
//   3. Probabilistic Hough line transform
//   4. Filter & merge into wall segments
//
// The v0.3 swap-in point: load a YOLOv8n-seg model (fine-tuned on
// CubiCasa5K) and replace step 2 with a binary wall mask, then
// maskToLines() can trace the mask contours instead of Hough.
//
// Output: array of {x1,y1,x2,y2} line segments in canvas pixel coords.

export async function detectWalls(canvas, { opts = {}, maxDim = 1024 } = {}) {
  // Edge detection is O(W*H) per pass — downscale first for speed.
  // Detection quality doesn't suffer much because walls are sharp
  // edges that survive downscaling.
  let work = canvas;
  let scaleX = 1, scaleY = 1;
  if (canvas.width > maxDim || canvas.height > maxDim) {
    const ratio = maxDim / Math.max(canvas.width, canvas.height);
    const w = Math.round(canvas.width * ratio);
    const h = Math.round(canvas.height * ratio);
    scaleX = canvas.width / w;
    scaleY = canvas.height / h;
    work = await downscaleCanvas(canvas, w, h);
  }
  const ctx = work.getContext('2d');
  const imgData = ctx.getImageData(0, 0, work.width, work.height);
  const { lines, w, h } = runEdgePipeline(imgData, opts);
  // Scale line coordinates back up to original canvas size
  const scaled = lines.map(L => ({
    x1: L.x1 * scaleX, y1: L.y1 * scaleY,
    x2: L.x2 * scaleX, y2: L.y2 * scaleY,
  }));
  return { lines: scaled, width: canvas.width, height: canvas.height };
}

// Downscale a canvas to a smaller size. Works for HTMLCanvasElement,
// node-canvas, and OffscreenCanvas (browser).
async function downscaleCanvas(src, w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    return c;
  }
  // node-canvas path — dynamic import so we don't force `canvas` on
  // browser users (it's a Node-only dep).
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { createCanvas } = require('canvas');
  const dst = createCanvas(w, h);
  dst.getContext('2d').drawImage(src, 0, 0, w, h);
  return dst;
}

// ---------- Edge detection (no external dep) ----------
//
// Sobel operator for gradient magnitude, then non-maximum suppression
// and hysteresis thresholding (Canny-style).

function runEdgePipeline(imgData, opts) {
  const W = imgData.width, H = imgData.height;
  const gray = rgbaToGray(imgData);
  const blurred = boxBlur(gray, W, H, 2);
  const edges = cannyEdges(blurred, W, H, {
    low: 30, high: 80,
    ...opts,
  });
  // Canny output is 0/255. Hough-style line detection on edge pixels.
  const lines = houghLines(edges, W, H, {
    threshold: Math.round(W * 0.05),  // votes needed to call a line
    minLineLength: Math.round(W * 0.02),
    maxLineGap: Math.round(W * 0.01),
    ...opts,
  });
  return { lines, w: W, h: H };
}

function rgbaToGray(imgData) {
  const out = new Uint8ClampedArray(imgData.width * imgData.height);
  for (let i = 0, j = 0; i < imgData.data.length; i += 4, j++) {
    out[j] = (imgData.data[i] * 0.299 + imgData.data[i + 1] * 0.587 + imgData.data[i + 2] * 0.114) | 0;
  }
  return out;
}

function boxBlur(gray, W, H, radius) {
  const out = new Uint8ClampedArray(W * H);
  const dia = radius * 2 + 1;
  // Horizontal pass
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const x = clamp(k, 0, W - 1);
      sum += gray[y * W + x];
    }
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = sum / dia;
      const xAdd = clamp(x + radius + 1, 0, W - 1);
      const xSub = clamp(x - radius, 0, W - 1);
      sum += gray[y * W + xAdd] - gray[y * W + xSub];
    }
  }
  // Vertical pass
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const y = clamp(k, 0, H - 1);
      sum += tmp[y * W + x];
    }
    for (let y = 0; y < H; y++) {
      out[y * W + x] = (sum / dia) | 0;
      const yAdd = clamp(y + radius + 1, 0, H - 1);
      const ySub = clamp(y - radius, 0, H - 1);
      sum += tmp[yAdd * W + x] - tmp[ySub * W + x];
    }
  }
  return out;
}

function cannyEdges(gray, W, H, { low = 30, high = 80 } = {}) {
  // Sobel gradient + magnitude
  const mag = new Uint8ClampedArray(W * H);
  const dir = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const tl = gray[(y - 1) * W + (x - 1)];
      const t  = gray[(y - 1) * W + x];
      const tr = gray[(y - 1) * W + (x + 1)];
      const l  = gray[y * W + (x - 1)];
      const r  = gray[y * W + (x + 1)];
      const bl = gray[(y + 1) * W + (x - 1)];
      const b  = gray[(y + 1) * W + x];
      const br = gray[(y + 1) * W + (x + 1)];
      const gx = -tl - 2 * l - bl + tr + 2 * r + br;
      const gy = -tl - 2 * t - tr + bl + 2 * b + br;
      const m = Math.sqrt(gx * gx + gy * gy);
      mag[y * W + x] = m > 255 ? 255 : m;
      dir[y * W + x] = Math.atan2(gy, gx);
    }
  }
  // Non-maximum suppression along gradient direction
  const suppressed = new Uint8ClampedArray(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const angle = dir[y * W + x];
      // 0° (horizontal edge), 45°, 90° (vertical edge), 135°
      let dx = 0, dy = 0;
      const a = ((angle * 180 / Math.PI) + 180) % 180;
      if (a < 22.5 || a >= 157.5)        { dx = 1; dy = 0; }
      else if (a < 67.5)                  { dx = 1; dy = 1; }
      else if (a < 112.5)                 { dx = 0; dy = 1; }
      else                                { dx = 1; dy = -1; }
      const m1 = mag[(y + dy) * W + (x + dx)];
      const m2 = mag[(y - dy) * W + (x - dx)];
      if (mag[y * W + x] >= m1 && mag[y * W + x] >= m2) {
        suppressed[y * W + x] = mag[y * W + x];
      }
    }
  }
  // Hysteresis thresholding
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = suppressed[y * W + x];
      if (v >= high) out[y * W + x] = 255;
      else if (v >= low) out[y * W + x] = 128;  // weak — flood fill later
    }
  }
  // Flood-fill weak edges that touch strong edges
  const seen = new Uint8Array(W * H);
  const stack = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (out[y * W + x] === 255 && !seen[y * W + x]) {
        stack.push([x, y]);
        while (stack.length) {
          const [cx, cy] = stack.pop();
          if (seen[cy * W + cx]) continue;
          seen[cy * W + cx] = 1;
          if (out[cy * W + cx] === 0) continue;
          out[cy * W + cx] = 255;
          for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < W && ny >= 0 && ny < H && !seen[ny * W + nx] && out[ny * W + nx] > 0) {
              stack.push([nx, ny]);
            }
          }
        }
      }
    }
  }
  return out;
}

// ---------- Hough transform for line segments ----------
//
// Standard Hough over (ρ, θ) accumulator; we trace connected runs of
// edge pixels to emit line segments (much faster than the full
// probabilistic Hough Line implementation, and good enough for floor
// plans where walls are mostly horizontal/vertical).

function houghLines(edges, W, H, { threshold = 80, minLineLength = 30, maxLineGap = 12 } = {}) {
  // Snap angles to nearest 5° — gives a small accumulator (36 bins)
  // and produces clean horizontal/vertical segments.
  const NBINS = 36;
  const lines = [];
  const visited = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (edges[y * W + x] < 128 || visited[y * W + x]) continue;
      // Try each of the 36 quantized directions starting from 0°
      let best = null;
      for (let b = 0; b < NBINS; b++) {
        const ang = b * Math.PI / NBINS;
        const dx = Math.cos(ang), dy = Math.sin(ang);
        let cx = x, cy = y;
        let count = 0;
        let minX = x, maxX = x, minY = y, maxY = y;
        while (cx >= 0 && cx < W && cy >= 0 && cy < H) {
          if (edges[cy * W + cx] >= 128 && !visited[cy * W + cx]) {
            visited[cy * W + cx] = 1;
            count++;
            minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
            minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
          } else if (count > 0) {
            // Tolerate a small gap, but break on big gap
            let inGap = false;
            for (let g = 1; g <= maxLineGap; g++) {
              const gx = cx + dx * g, gy = cy + dy * g;
              if (gx < 0 || gx >= W || gy < 0 || gy >= H) break;
              if (edges[gy * W + gx] >= 128) { inGap = true; break; }
            }
            if (!inGap) break;
          }
          cx += dx; cy += dy;
        }
        if (count >= threshold && (maxX - minX + maxY - minY) >= minLineLength) {
          if (!best || count > best.count) best = { count, minX, maxX, minY, maxY };
        }
        // Reset visited markings made during this sweep (we'll re-mark
        // for the best one after the loop).
        for (let yy = minY; yy <= maxY; yy++) {
          for (let xx = minX; xx <= maxX; xx++) {
            visited[yy * W + xx] = 0;
          }
        }
      }
      if (best) {
        const { minX, maxX, minY, maxY, count } = best;
        // Approximate the line endpoints using the bounding box,
        // choosing the two farthest diagonal corners.
        const isHoriz = (maxX - minX) > (maxY - minY);
        if (isHoriz) {
          lines.push({ x1: minX, y1: (minY + maxY) / 2, x2: maxX, y2: (minY + maxY) / 2, score: count });
        } else {
          lines.push({ x1: (minX + maxX) / 2, y1: minY, x2: (minX + maxX) / 2, y2: maxY, score: count });
        }
        // Mark this region visited
        for (let yy = minY; yy <= maxY; yy++) {
          for (let xx = minX; xx <= maxX; xx++) {
            visited[yy * W + xx] = 1;
          }
        }
      } else {
        visited[y * W + x] = 1;  // skip noise pixels
      }
    }
  }
  return lines;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// maskToLines — placeholder for the YOLOv8 swap-in.
// v0.2: just an alias of detectWalls (the edges are already lines).
export function maskToLines(detectionResult) {
  return detectionResult.lines;
}
