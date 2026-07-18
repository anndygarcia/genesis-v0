// GENESIS · extract-tool/text.mjs
//
// Extract text + positions from a vector PDF page.
//
// Architect PDFs embed text as positioned glyph runs, not as raster.
// pdfjs-dist's `getTextContent()` returns every text run with its
// transform matrix, so we get exact (x, y) for each string on the page.
//
// Output: [{ str, x, y, width, height, fontSize, fontName }, ...]

export async function extractTextRuns(pdfPath, { pageIndex = 0 } = {}) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const data = await loadPdfData(pdfPath);
  const pdf = await pdfjsLib.getDocument({ data, disableFontFace: true, useSystemFonts: false }).promise;
  const page = await pdf.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  const runs = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const tr = item.transform; // [a, b, c, d, e, f]
    const x = tr[4];
    const y = tr[5];
    const fontSize = Math.hypot(tr[2], tr[3]) || tr[0];
    const fontHeight = Math.hypot(tr[1], tr[2]) || tr[3];
    runs.push({
      str: item.str,
      x,
      y,
      width: item.width,
      height: item.height,
      fontSize,
      fontHeight,
      fontName: item.fontName,
      hasEOL: !!item.hasEOL,
    });
  }
  return { runs, pageWidth: vp.width, pageHeight: vp.height };
}

async function loadPdfData(pdfPath) {
  const fs = await import('node:fs/promises');
  const buf = await fs.readFile(pdfPath);
  return new Uint8Array(buf);
}

// Detect dimension strings like 12'-4" or 30'-0" or 9'-8 1/2".
// Returns parsed inches (as a number) and the original string.
const DIM_RE = /(\d+)(?:'|ft)\s*[-]?\s*(\d+)?(?:\s*(\d+)\s*\/\s*(\d+))?(?:"|in)?/g;
export function findDimensionStrings(runs) {
  const found = [];
  for (const r of runs) {
    const matches = r.str.matchAll(/(\d+(?:'|ft)?-?\d*(?:\s*\d+\/\d+)?(?:\d*)?")/g);
    for (const m of matches) {
      const dim = parseDim(m[0]);
      if (dim != null) found.push({ str: m[0], inches: dim, x: r.x, y: r.y });
    }
  }
  return found;
}

function parseDim(s) {
  // Match patterns: 12'-4", 30', 9'-8 1/2", 5'-0", 6'-8"
  const m = s.match(/^(\d+)'(?:[\s-]*(\d+)(?:\s+(\d+)\/(\d+))?)?(?:")?$/);
  if (!m) return null;
  const feet = +m[1];
  const inches = m[2] ? +m[2] : 0;
  const frac = m[3] && m[4] ? +m[3] / +m[4] : 0;
  return (feet * 12) + inches + frac;
}
