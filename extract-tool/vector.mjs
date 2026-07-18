// GENESIS · extract-tool/vector.mjs
//
// Extract precise line segments from a vector PDF page.
//
// pdfjs-dist 3.x uses one operator — `constructPath` — for every
// drawn path. Its args are [ops, args] where `ops` is a flat Int8Array
// of opcodes (13=moveTo, 14=lineTo, 19=rect, 18=closePath, 28=endPath)
// and `args` is a flat array of numbers consumed in order:
//
//   moveTo   (13) → args 2 (x, y)
//   lineTo   (14) → args 2 (x, y)
//   rect     (19) → args 4 (x, y, w, h)
//   curveTo  (15) → args 6 (cp1x, cp1y, cp2x, cp2y, x, y)  → emit chord
//   closePath(18) → args 0
//
// Output: { lines: [{x1,y1,x2,y2}, ...], bbox, pageCount, pdfPath }

const OPS = {
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  endPath: 28,
};

export async function extractVectorLines(pdfPath, { pageIndex = 0 } = {}) {
  // pdfjs-dist 3.x ships as AMD/CommonJS only; load it via createRequire
  // so we can use it from ESM. This avoids the ESM/CJS interop quirks
  // that show up when dynamic-importing an AMD module.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const data = await loadPdfData(pdfPath);
  const pdf = await pdfjsLib.getDocument({ data, disableFontFace: true, useSystemFonts: false }).promise;
  const page = await pdf.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();

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
      switch (op) {
        case OPS.moveTo: {
          cursor = { x: args[ai], y: args[ai + 1] };
          pathStart = { ...cursor };
          ai += 2;
          break;
        }
        case OPS.lineTo: {
          if (!cursor) break;
          const nx = args[ai], ny = args[ai + 1];
          lines.push({ x1: cursor.x, y1: cursor.y, x2: nx, y2: ny });
          cursor = { x: nx, y: ny };
          ai += 2;
          break;
        }
        case OPS.rectangle: {
          const [x, y, w, h] = [args[ai], args[ai + 1], args[ai + 2], args[ai + 3]];
          pushRect(lines, x, y, w, h);
          ai += 4;
          break;
        }
        case OPS.curveTo: {
          if (!cursor) { ai += 6; break; }
          const [c1x, c1y, c2x, c2y, x2, y2] = [args[ai], args[ai + 1], args[ai + 2], args[ai + 3], args[ai + 4], args[ai + 5]];
          emitBezier(lines, cursor.x, cursor.y, c1x, c1y, c2x, c2y, x2, y2);
          cursor = { x: x2, y: y2 };
          ai += 6;
          break;
        }
        case OPS.curveTo2: {
          if (!cursor) { ai += 4; break; }
          const [c2x, c2y, x2, y2] = [args[ai], args[ai + 1], args[ai + 2], args[ai + 3]];
          emitBezier(lines, cursor.x, cursor.y, cursor.x, cursor.y, c2x, c2y, x2, y2);
          cursor = { x: x2, y: y2 };
          ai += 4;
          break;
        }
        case OPS.curveTo3: {
          if (!cursor) { ai += 4; break; }
          const [c1x, c1y, x2, y2] = [args[ai], args[ai + 1], args[ai + 2], args[ai + 3]];
          emitBezier(lines, cursor.x, cursor.y, c1x, c1y, x2, y2, x2, y2);
          cursor = { x: x2, y: y2 };
          ai += 4;
          break;
        }
        case OPS.closePath: {
          if (cursor && pathStart && (cursor.x !== pathStart.x || cursor.y !== pathStart.y)) {
            lines.push({ x1: cursor.x, y1: cursor.y, x2: pathStart.x, y2: pathStart.y });
            cursor = { ...pathStart };
          }
          break;
        }
        case OPS.endPath:
          cursor = null;
          pathStart = null;
          break;
      }
    }
  }

  return {
    lines,
    bbox: { x: 0, y: 0, w: vp.width, h: vp.height },
    pageIndex,
    pageCount: pdf.numPages,
    pdfPath,
  };
}

function pushRect(lines, x, y, w, h) {
  lines.push({ x1: x,     y1: y,     x2: x + w, y2: y });
  lines.push({ x1: x + w, y1: y,     x2: x + w, y2: y + h });
  lines.push({ x1: x + w, y1: y + h, x2: x,     y2: y + h });
  lines.push({ x1: x,     y1: y + h, x2: x,     y2: y });
}

function emitBezier(lines, x0, y0, c1x, c1y, c2x, c2y, x1, y1, segments = 8) {
  let prev = { x: x0, y: y0 };
  for (let s = 1; s <= segments; s++) {
    const t = s / segments;
    const u = 1 - t;
    const x = u*u*u*x0 + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*x1;
    const y = u*u*u*y0 + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*y1;
    lines.push({ x1: prev.x, y1: prev.y, x2: x, y2: y });
    prev = { x, y };
  }
}

async function loadPdfData(pdfPath) {
  const fs = await import('node:fs/promises');
  const buf = await fs.readFile(pdfPath);
  return new Uint8Array(buf);
}
