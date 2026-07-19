// GENESIS · extract-browser.mjs
//
// Browser-side version of the extract-tool pipeline. Loads pdfjs-dist
// from a CDN (already loaded for the existing upload UX), then runs
// the same vector/text/calibrate/fuse flow as the Node CLI.
//
// Returns a plan JSON matching state.js's schema, ready for
// `window.GENESIS.loadPlan(plan)`.

// These are browser-flavored copies of the Node modules, using the
// already-loaded pdfjsLib instead of an AMD CommonJS require().
//
// Each module is small enough to inline here; if extract-tool grows,
// we can switch to a build step that produces a single ESM bundle.

const OPS = {
  moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17,
  closePath: 18, rectangle: 19, endPath: 28,
};

export async function extractVectorLinesFromPdfPage(pdfjsLib, page) {
  const ops = await page.getOperatorList();
  const vp = page.getViewport({ scale: 1 });
  const lines = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn !== pdfjsLib.OPS.constructPath) continue;
    const [opCodes, args] = ops.argsArray[i];

    let cursor = null;
    let pathStart = null;
    let ai = 0;

    for (let k = 0; k < opCodes.length; k++) {
      const op = opCodes[k];
      if (op === OPS.moveTo) {
        cursor = { x: args[ai], y: args[ai + 1] };
        pathStart = { ...cursor };
        ai += 2;
      } else if (op === OPS.lineTo) {
        if (cursor) {
          lines.push({ x1: cursor.x, y1: cursor.y, x2: args[ai], y2: args[ai + 1] });
          cursor = { x: args[ai], y: args[ai + 1] };
        }
        ai += 2;
      } else if (op === OPS.rectangle) {
        const [x, y, w, h] = [args[ai], args[ai + 1], args[ai + 2], args[ai + 3]];
        pushRect(lines, x, y, w, h);
        ai += 4;
      } else if (op === OPS.curveTo) {
        if (cursor) {
          emitBezier(lines, cursor.x, cursor.y, args[ai], args[ai + 1], args[ai + 2], args[ai + 3], args[ai + 4], args[ai + 5]);
          cursor = { x: args[ai + 4], y: args[ai + 5] };
        }
        ai += 6;
      } else if (op === OPS.closePath) {
        if (cursor && pathStart) {
          lines.push({ x1: cursor.x, y1: cursor.y, x2: pathStart.x, y2: pathStart.y });
          cursor = { ...pathStart };
        }
      } else if (op === OPS.endPath) {
        cursor = null;
        pathStart = null;
      }
    }
  }
  return { lines, bbox: { x: 0, y: 0, w: vp.width, h: vp.height } };
}

function pushRect(lines, x, y, w, h) {
  lines.push({ x1: x, y1: y, x2: x + w, y2: y });
  lines.push({ x1: x + w, y1: y, x2: x + w, y2: y + h });
  lines.push({ x1: x + w, y1: y + h, x2: x, y2: y + h });
  lines.push({ x1: x, y1: y + h, x2: x, y2: y });
}

function emitBezier(lines, x0, y0, c1x, c1y, c2x, c2y, x1, y1, segments = 8) {
  let prev = { x: x0, y: y0 };
  for (let s = 1; s <= segments; s++) {
    const t = s / segments;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x1;
    const y = u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1;
    lines.push({ x1: prev.x, y1: prev.y, x2: x, y2: y });
    prev = { x, y };
  }
}

export async function extractTextRunsFromPage(pdfjsLib, page) {
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const tr = item.transform;
    const x = tr[4];
    const y = tr[5];
    const fontSize = Math.hypot(tr[2], tr[3]) || tr[0];
    runs.push({
      str: item.str,
      x,
      y,
      width: item.width,
      height: item.height,
      fontSize,
    });
  }
  return { runs, pageWidth: vp.width, pageHeight: vp.height };
}

// Detect whether a PDF page is vector (has constructPath ops + text)
// or raster (scanned image). Public — used by app.js's openExtract().
export async function detectPdfKind(page, pdfjsLib) {
  const ops = await page.getOperatorList();
  const text = await page.getTextContent();
  let hasConstructPath = false;
  for (const fn of ops.fnArray) {
    if (fn === pdfjsLib.OPS.constructPath) { hasConstructPath = true; break; }
  }
  if (text.items.length > 5 && hasConstructPath) return 'vector';
  if (text.items.length > 5) return 'text-raster';
  return 'raster';
}

// Raster path orchestrator — render is done by the caller (since
// pdf.js canvas creation differs between Node and the browser).
// Reuses the Node CLI's `extractPlanFromRasterCanvas` shape.
export async function extractPlanFromRasterCanvas(canvas, { fileName = 'plan' } = {}) {
  const rasterMod = await import('./raster.mjs');
  return await rasterMod.extractPlanFromRasterCanvas(canvas, { fileName });
}

import {
  calibrate as calibrateShared,
  findRectangularRooms as fuseRooms,
  findEnvelope as fuseEnvelope,
} from './fuse.mjs';

export async function extractPlanFromPdfPage(pdfjsLib, page, { fileName = 'plan' } = {}) {
  const t0 = performance.now();
  const { lines } = await extractVectorLinesFromPdfPage(pdfjsLib, page);
  const text = await extractTextRunsFromPage(pdfjsLib, page);
  const cal = calibrateShared(lines, text.runs);
  const ppf = cal.pixelsPerFoot;
  const pageH = text.pageHeight;

  const linesInFt = lines.map(L => ({
    x1: L.x1 / ppf,
    y1: (pageH - L.y1) / ppf,
    x2: L.x2 / ppf,
    y2: (pageH - L.y2) / ppf,
  }));

  const envelope = fuseEnvelope(linesInFt);
  const rooms = fuseRooms(linesInFt, envelope);
  // Attach labels
  for (const run of text.runs) {
    const ftX = run.x / ppf;
    const ftY = (pageH - run.y) / ppf;
    const str = run.str.trim();
    if (!str) continue;
    const room = rooms.find(r =>
      ftX >= r.x && ftX <= r.x + r.w &&
      ftY >= r.z && ftY <= r.z + r.d
    );
    if (room && !room.name) room.name = str;
  }
  rooms.forEach((r, i) => { if (!r.name) r.name = `Room ${i + 1}`; });
  const CLG_RE = /(\d+)['\s]*(?:CLG|CLG\.|CEILING)/i;
  rooms.forEach(room => {
    if (room.name) {
      const m = room.name.match(CLG_RE);
      if (m) room.h = parseInt(m[1], 10);
    }
    if (!room.h) room.h = 9;
  });

  const dt = performance.now() - t0;
  return {
    plan: {
      name: fileName.replace(/\.pdf$/i, ''),
      rooms,
      footprint: envelope,
      source: 'extract',
      calibration: cal,
    },
    elapsedMs: dt,
  };
}
