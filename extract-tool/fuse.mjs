// GENESIS · extract-tool/fuse.mjs
//
// Take the output of vector extraction + text extraction + calibration
// and produce a plan JSON matching state.js's schema.
//
// The simplest approach for v0.1:
//   1. Apply pixelsPerFoot to all coordinates (convert pt → ft)
//   2. Group lines into rectangular room polygons by finding axis-aligned
//      bounding boxes of contiguous wall segments
//   3. Match text labels to rooms by centroid proximity
//   4. Output as plan.rooms[]
//
// This is the v0.1 implementation — produces reasonable rooms for
// axis-aligned floor plans like Garcia. Polygonal/angled rooms are
// not yet supported; they'll fall back to bounding rectangles.

import { extractTextRuns } from './text.mjs';
import { calibrate } from './calibrate.mjs';

export async function extractPlanFromPdf(pdfPath, { pageIndex = 0 } = {}) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const data = await loadPdfData(pdfPath);
  const pdf = await pdfjsLib.getDocument({ data, disableFontFace: true, useSystemFonts: false }).promise;
  const page = await pdf.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: 1 });

  const ops = await page.getOperatorList();
  const lines = extractAllLines(ops, pdfjsLib.OPS);
  const text = await extractTextRuns(pdfPath, { pageIndex });
  const cal = calibrate(lines, text.runs);

  // Convert pt → ft using pixelsPerFoot. y-axis flips (PDF is y-up).
  const ppf = cal.pixelsPerFoot;
  const linesInFt = lines.map(L => ({
    x1: L.x1 / ppf,
    y1: (vp.height - L.y1) / ppf,    // flip y to "screen down"
    x2: L.x2 / ppf,
    y2: (vp.height - L.y2) / ppf,
  }));

  // Find the building envelope (outermost rectangle bounding all walls).
  const envelope = findEnvelope(linesInFt);

  // Find rooms inside the envelope: connected-axis-aligned rectangles.
  const rooms = findRectangularRooms(linesInFt, envelope);

  // Attach text labels to rooms by centroid proximity.
  attachLabels(rooms, text.runs, ppf, vp.height);

  // Heuristic ceiling heights from text (look for "10' CLG.", "12' CLG.", etc.)
  attachHeights(rooms, text.runs, ppf, vp.height);

  return {
    plan: {
      name: pdfPath.split('/').pop().replace(/\.pdf$/i, ''),
      rooms,
      footprint: envelope,
      source: 'extract',
      calibration: cal,
    },
    lines: linesInFt,
    text: text.runs,
    pageWidth: vp.width / ppf,
    pageHeight: vp.height / ppf,
  };
}

// Also export helpers so the browser-side entrypoint can reuse them.
export { extractAllLines, findEnvelope, findRectangularRooms, attachLabels, attachHeights };

function extractAllLines(ops, OPS) {
  const lines = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn !== OPS.constructPath) continue;
    const [opCodes, args] = ops.argsArray[i];
    let cursor = null;
    let pathStart = null;
    let ai = 0;
    for (let k = 0; k < opCodes.length; k++) {
      const op = opCodes[k];
      if (op === 13) {  // moveTo
        cursor = { x: args[ai], y: args[ai + 1] };
        pathStart = { ...cursor };
        ai += 2;
      } else if (op === 14) {  // lineTo
        if (cursor) {
          lines.push({ x1: cursor.x, y1: cursor.y, x2: args[ai], y2: args[ai + 1] });
          cursor = { x: args[ai], y: args[ai + 1] };
        }
        ai += 2;
      } else if (op === 19) {  // rect
        const [x, y, w, h] = [args[ai], args[ai + 1], args[ai + 2], args[ai + 3]];
        lines.push({ x1: x,     y1: y,     x2: x + w, y2: y });
        lines.push({ x1: x + w, y1: y,     x2: x + w, y2: y + h });
        lines.push({ x1: x + w, y1: y + h, x2: x,     y2: y + h });
        lines.push({ x1: x,     y1: y + h, x2: x,     y2: y });
        ai += 4;
      } else if (op === 18) {  // closePath
        if (cursor && pathStart) {
          lines.push({ x1: cursor.x, y1: cursor.y, x2: pathStart.x, y2: pathStart.y });
          cursor = { ...pathStart };
        }
      } else if (op === 28) {  // endPath
        cursor = null;
        pathStart = null;
      }
    }
  }
  return lines;
}

function findEnvelope(linesInFt) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const L of linesInFt) {
    minX = Math.min(minX, L.x1, L.x2);
    minY = Math.min(minY, L.y1, L.y2);
    maxX = Math.max(maxX, L.x1, L.x2);
    maxY = Math.max(maxY, L.y1, L.y2);
  }
  return { x: minX, y: minY, w: maxX - minX, d: maxY - minY };
}

// Find rooms as axis-aligned bounding rectangles between wall segments.
// Strategy:
//   1. Find vertical wall segments (sort by x)
//   2. Find horizontal wall segments (sort by y)
//   3. For each pair of adjacent verticals and pair of adjacent
//      horizontals, emit a rectangle; check if any wall passes through
//      the interior (skip if so)
//   4. Filter out very small rectangles (< 1 ft × 1 ft)
function findRectangularRooms(lines, envelope) {
  // Filter lines to those likely to be walls:
  //   1. At least 5 ft long (skip short dim arrows and tick marks)
  //   2. Inside the building envelope (skip title-block borders etc.)
  const wallLines = lines.filter(L => {
    const len = Math.hypot(L.x2 - L.x1, L.y2 - L.y1);
    if (len < 5) return false;
    // Reject lines outside the envelope (with 2 ft tolerance)
    const minX = Math.min(L.x1, L.x2), maxX = Math.max(L.x1, L.x2);
    const minY = Math.min(L.y1, L.y2), maxY = Math.max(L.y1, L.y2);
    if (maxX < envelope.x - 2 || minX > envelope.x + envelope.w + 2) return false;
    if (maxY < envelope.y - 2 || minY > envelope.y + envelope.d + 2) return false;
    return true;
  });

  // Snap unique x/y values within 1 ft tolerance
  const verticals = snapUniques(wallLines.filter(L => Math.abs(L.x1 - L.x2) < 0.05).map(L => L.x1), 1);
  const horizontals = snapUniques(wallLines.filter(L => Math.abs(L.y1 - L.y2) < 0.05).map(L => L.y1), 1);

  // Filter to inside envelope (with tolerance)
  const inVerts = verticals.filter(x => x >= envelope.x - 1 && x <= envelope.x + envelope.w + 1);
  const inHoriz = horizontals.filter(y => y >= envelope.y - 1 && y <= envelope.y + envelope.d + 1);
  inVerts.sort((a, b) => a - b);
  inHoriz.sort((a, b) => a - b);

  const rooms = [];
  for (let i = 0; i < inVerts.length - 1; i++) {
    for (let j = 0; j < inHoriz.length - 1; j++) {
      const x1 = inVerts[i], x2 = inVerts[i + 1];
      const y1 = inHoriz[j], y2 = inHoriz[j + 1];
      if (x2 - x1 < 4 || y2 - y1 < 4) continue;

      // Skip if a wall passes through the interior (other than the 4 boundaries)
      const hasInternalWall = wallLines.some(L => {
        const onBoundary = (
          (Math.abs(L.x1 - x1) < 0.5 && Math.abs(L.x2 - x1) < 0.5) ||
          (Math.abs(L.x1 - x2) < 0.5 && Math.abs(L.x2 - x2) < 0.5) ||
          (Math.abs(L.y1 - y1) < 0.5 && Math.abs(L.y2 - y1) < 0.5) ||
          (Math.abs(L.y1 - y2) < 0.5 && Math.abs(L.y2 - y2) < 0.5)
        );
        if (onBoundary) return false;
        if (Math.abs(L.x1 - L.x2) < 0.05 && L.x1 > x1 + 0.5 && L.x1 < x2 - 0.5) {
          if (Math.max(L.y1, L.y2) > y1 + 0.5 && Math.min(L.y1, L.y2) < y2 - 0.5) return true;
        }
        if (Math.abs(L.y1 - L.y2) < 0.05 && L.y1 > y1 + 0.5 && L.y1 < y2 - 0.5) {
          if (Math.max(L.x1, L.x2) > x1 + 0.5 && Math.min(L.x1, L.x2) < x2 - 0.5) return true;
        }
        return false;
      });
      if (hasInternalWall) continue;

      rooms.push({
        id: `room-${i}-${j}`,
        x: x1, z: y1, w: x2 - x1, d: y2 - y1,
        area: (x2 - x1) * (y2 - y1),
      });
    }
  }

  return rooms.filter(r => r.w >= 4 && r.d >= 4);
}

// Cluster nearby numeric values into a single canonical value.
function snapUniques(values, tolerance) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && Math.abs(sorted[j] - sorted[i]) <= tolerance) j++;
    // Use the median of the cluster
    const cluster = sorted.slice(i, j);
    out.push(cluster[Math.floor(cluster.length / 2)]);
    i = j;
  }
  return out;
}

function uniqueXs(vertLines) {
  const set = new Map();
  for (const L of vertLines) {
    const k = Math.round(L.x1 * 10) / 10;
    if (!set.has(k)) set.set(k, true);
  }
  return Array.from(set.keys());
}
function uniqueYs(horizLines) {
  const set = new Map();
  for (const L of horizLines) {
    const k = Math.round(L.y1 * 10) / 10;
    if (!set.has(k)) set.set(k, true);
  }
  return Array.from(set.keys());
}

function attachLabels(rooms, runs, ppf, pageH) {
  for (const run of runs) {
    const ftX = run.x / ppf;
    const ftY = (pageH - run.y) / ppf;
    const str = run.str.trim();
    if (!str) continue;
    // Find the room containing this point
    const room = rooms.find(r =>
      ftX >= r.x && ftX <= r.x + r.w &&
      ftY >= r.z && ftY <= r.z + r.d
    );
    if (room) {
      room.name = str;
    }
  }
  // Default names for any room that didn't get a label
  rooms.forEach((r, i) => {
    if (!r.name) r.name = `Room ${i + 1}`;
  });
}

const CLG_RE = /(\d+)['\s]*(?:CLG|CLG\.|CEILING)/i;
function attachHeights(rooms, runs, ppf, pageH) {
  for (const room of rooms) {
    if (room.name) {
      const m = room.name.match(CLG_RE);
      if (m) room.h = parseInt(m[1], 10);
    }
  }
  // Default 9 ft
  rooms.forEach(r => { if (!r.h) r.h = 9; });
}

async function loadPdfData(pdfPath) {
  const fs = await import('node:fs/promises');
  const buf = await fs.readFile(pdfPath);
  return new Uint8Array(buf);
}

// =============================================================
//   OPENINGS MATCHING
//
// Given:
//   - openingsPixel: [{px, py, x, y, w, h, count}] in original canvas px coords
//   - linesInFt:     [{x1,y1,x2,y2}]  in feet-space, y-up
//   - rooms:         [{x, z, w, d, name}] in feet-space
//   - ppf:           pixels per foot
//   - canvasH:       original canvas height in pixels
//
// Produce:
//   doors:   [{x, z, w, axis: 'x'|'z', kind: 'exterior'|'interior', label}]
//   windows: [{x, z, w, axis: 'x'|'z', label}]
//
// Algorithm:
//   1. Convert each opening's centroid from canvas-px to feet-space.
//      The canvas had y-down; we flip.
//   2. For each opening, find the nearest wall within a small threshold.
//      Wall orientation tells us the axis of the opening:
//        horizontal wall (constant z) → opening axis = 'x' (door runs along x)
//        vertical wall   (constant x) → opening axis = 'z'
//   3. Compute position (ftX, ftY) directly as the centroid; the wall's
//      projection point gives context for which room the opening belongs to.
//   4. Width: take the model's bounding-box extent along the wall axis;
//      fall back to 3 ft (door) / 4 ft (window) if the model gave nothing
//      usable.
//   5. Classify each door as exterior if the wall is on the envelope,
//      interior otherwise.
export function matchOpeningsToWalls(openingsPixel, linesInFt, rooms, ppf, canvasH) {
  const envelope = findEnvelope(linesInFt);
  if (!envelope) return { doors: [], windows: [] };
  const doors = [];
  const windows = [];
  const process = (arr, isDoor) => {
    for (const op of arr) {
      // Convert px centroid → feet-space (canvas y is downward, plan y is up)
      const ftX = op.px / ppf;
      const ftY = (canvasH - op.py) / ppf;
      // Find nearest wall (within 2 ft — typical residential wall thickness is 0.5 ft)
      let bestDist = Infinity, bestWall = null;
      for (const L of linesInFt) {
        const ax = L.x1, az = L.y1;
        const bx = L.x2, bz = L.y2;
        const dx = bx - ax, dz = bz - az;
        const lenSq = dx * dx + dz * dz;
        let t = lenSq === 0 ? 0 : ((ftX - ax) * dx + (ftY - az) * dz) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const projX = ax + t * dx, projZ = az + t * dz;
        const d = Math.hypot(ftX - projX, ftY - projZ);
        if (d < bestDist) { bestDist = d; bestWall = { L, dx, dz }; }
      }
      // Threshold: nearest wall must be within a reasonable distance.
      // In real architect drawings doors are within 0-2 ft of their wall.
      // We relax to 12 ft for icons that drift away from their host
      // wall (door-swing arcs are often drawn slightly offset).
      if (!bestWall || bestDist > 12) continue;
      const planDim = Math.max(envelope.w, envelope.d);
      if (bestDist > planDim * 0.3) continue;
      const onEnv = isOnEnvelope(bestWall.L, envelope);
      const horizWall = Math.abs(bestWall.dz) < Math.abs(bestWall.dx);
      // Width: take bbox extent along wall axis. Model sometimes gives 0
      // for thin openings, so fall back to door=3 ft, window=4 ft.
      let width;
      if (horizWall) {
        width = Math.max(op.w, 0) / ppf;
      } else {
        width = Math.max(op.h, 0) / ppf;
      }
      if (width < 0.5) width = isDoor ? 3 : 4;
      width = Math.min(width, 12);  // cap at garage-door max
      // For positioning: snap the opening to the wall line. Otherwise the
      // geometry renderer in app.js (which uses (x, axis, w) to draw a
      // window slot along the wall) gets the door crossing both rooms.
      let posX = ftX, posZ = ftY;
      const segDx = bestWall.dx, segDz = bestWall.dz;
      const segLenSq = segDx * segDx + segDz * segDz;
      if (segLenSq > 0) {
        const t = ((ftX - bestWall.L.x1) * segDx + (ftY - bestWall.L.y1) * segDz) / segLenSq;
        const tc = Math.max(0, Math.min(1, t));
        posX = bestWall.L.x1 + tc * segDx;
        posZ = bestWall.L.y1 + tc * segDz;
      }
      const out = {
        x: posX,
        z: posZ,
        w: Number(width.toFixed(2)),
        axis: horizWall ? 'x' : 'z',
      };
      if (isDoor) {
        out.id = `door-auto-${doors.length + 1}`;
        out.label = onEnv ? 'Door (exterior)' : 'Door';
        if (onEnv) out.kind = 'exterior';
      } else {
        out.id = `window-auto-${windows.length + 1}`;
        out.label = 'Window';
      }
      if (isDoor) doors.push(out); else windows.push(out);
    }
  };
  process(openingsPixel.doors, true);
  process(openingsPixel.windows, false);
  // Dedupe openings that ended up at the same position. With the
  // bucketing-then-bbox approach, a single real opening often becomes
  // 2-3 buckets (model mask holes show up as separate regions). Collapse
  // anything within 2 ft of an already-emitted opening.
  const dedupe = (arr) => {
    const out = [];
    for (const o of arr) {
      if (out.some(p => Math.hypot(p.x - o.x, p.z - o.z) < 2.0)) continue;
      out.push(o);
    }
    return out;
  };
  return { doors: dedupe(doors), windows: dedupe(windows) };
}

// Is a wall (line) on the envelope of the building?
// True if the wall lies within 0.5 ft of any envelope edge.
function isOnEnvelope(L, envelope) {
  const tol = 0.5;
  const pts = [[L.x1, L.y1], [L.x2, L.y2]];
  for (const [px, pz] of pts) {
    const onLeft = Math.abs(px - envelope.x) < tol;
    const onRight = Math.abs(px - (envelope.x + envelope.w)) < tol;
    const onTop = Math.abs(pz - envelope.z) < tol;
    const onBot = Math.abs(pz - (envelope.z + envelope.d)) < tol;
    if (onLeft || onRight || onTop || onBot) return true;
  }
  return false;
}
