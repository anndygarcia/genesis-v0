// Make a synthetic architect-style PDF with proper dimension annotations.
// pdf-lib based — draws walls + dimension lines + tick marks + labels.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  // Page is letter (8.5"x11"), 72 pt per inch.
  // Architecture page typically: 24"x36" sheet, drawn at 1/4" = 1'  →  6 pt/foot.
  // For our test we'll do 1" = 5 ft → 14.4 pt/foot.
  const PT_PER_FT = 14.4;
  const page = pdf.addPage([612, 792]);
  const { width, height } = page.getSize();

  // Building envelope: 50 ft × 67 ft
  const houseW = 50 * PT_PER_FT;
  const houseD = 67 * PT_PER_FT;
  const ox = 60;   // offset from page left
  const oy = 60;   // offset from page bottom
  const house = { x: ox, y: oy, w: houseW, d: houseD };

  function line(p1, p2, thick = 2, color = rgb(0, 0, 0)) {
    page.drawLine({ start: p1, end: p2, thickness: thick, color });
  }
  function text(s, x, y, size = 10) {
    page.drawText(s, { x, y, size, font, color: rgb(0, 0, 0) });
  }

  // Outer walls (4 segments, 4 pt thick)
  const wt = 4;
  line({ x: house.x, y: house.y }, { x: house.x + house.w, y: house.y }, wt);
  line({ x: house.x + house.w, y: house.y }, { x: house.x + house.w, y: house.y + house.d }, wt);
  line({ x: house.x + house.w, y: house.y + house.d }, { x: house.x, y: house.y + house.d }, wt);
  line({ x: house.x, y: house.y + house.d }, { x: house.x, y: house.y }, wt);

  // Inner walls
  const iwt = 2;
  // vertical: split into 3 rooms
  const v1x = house.x + 22 * PT_PER_FT;
  const v2x = house.x + 36 * PT_PER_FT;
  line({ x: v1x, y: house.y }, { x: v1x, y: house.y + 40 * PT_PER_FT }, iwt);
  line({ x: v2x, y: house.y }, { x: v2x, y: house.y + 40 * PT_PER_FT }, iwt);
  // horizontal
  const h1y = house.y + 40 * PT_PER_FT;
  line({ x: v1x, y: h1y }, { x: v2x, y: h1y }, iwt);
  const h2y = house.y + 50 * PT_PER_FT;
  line({ x: v1x, y: h2y }, { x: v2x, y: h2y }, iwt);

  // Room labels
  text('Living Room', house.x + 4, house.y + 14, 12);
  text('Kitchen', v1x + 4, house.y + 14, 12);
  text('Master Bedroom', v2x + 4, house.y + 14, 12);
  text('Bath 1', v1x + 4, h1y + 4, 10);
  text('Bath 2', v2x + 4, h1y + 4, 10);
  text('Bedroom 2', house.x + 4, house.y + 30, 10);
  text('Bedroom 3', v1x + 4, house.y + 30, 10);

  // === DIMENSION ANNOTATIONS ===
  // Bottom dimension: shows the 50'-0" width
  function dimHorizontal(x1, x2, y, offsetPx = 18) {
    const dimY = y - offsetPx;
    // dimension line
    line({ x: x1, y: dimY }, { x: x2, y: dimY }, 1, rgb(0.3, 0.3, 0.3));
    // extension lines (the tick marks going up to the wall)
    line({ x: x1, y: y }, { x: x1, y: dimY }, 1, rgb(0.3, 0.3, 0.3));
    line({ x: x2, y: y }, { x: x2, y: dimY }, 1, rgb(0.3, 0.3, 0.3));
    // arrow heads
    line({ x: x1, y: dimY }, { x: x1 + 6, y: dimY + 3 }, 1, rgb(0.3, 0.3, 0.3));
    line({ x: x1, y: dimY }, { x: x1 + 6, y: dimY - 3 }, 1, rgb(0.3, 0.3, 0.3));
    line({ x: x2, y: dimY }, { x: x2 - 6, y: dimY + 3 }, 1, rgb(0.3, 0.3, 0.3));
    line({ x: x2, y: dimY }, { x: x2 - 6, y: dimY - 3 }, 1, rgb(0.3, 0.3, 0.3));
  }
  function dimVertical(y1, y2, x, offsetPx = 18) {
    const dimX = x - offsetPx;
    line({ x: dimX, y: y1 }, { x: dimX, y: y2 }, 1, rgb(0.3, 0.3, 0.3));
    line({ x: x, y: y1 }, { x: dimX, y: y1 }, 1, rgb(0.3, 0.3, 0.3));
    line({ x: x, y: y2 }, { x: dimX, y: y2 }, 1, rgb(0.3, 0.3, 0.3));
    line({ x: dimX, y: y1 }, { x: dimX + 3, y: y1 + 6 }, 1, rgb(0.3, 0.3, 0.3));
    line({ x: dimX, y: y1 }, { x: dimX - 3, y: y1 + 6 }, 1, rgb(0.3, 0.3, 0.3));
    line({ x: dimX, y: y2 }, { x: dimX + 3, y: y2 - 6 }, 1, rgb(0.3, 0.3, 0.3));
    line({ x: dimX, y: y2 }, { x: dimX - 3, y: y2 - 6 }, 1, rgb(0.3, 0.3, 0.3));
  }

  // Bottom dimension: 50'-0" overall
  dimHorizontal(house.x, house.x + house.w, house.y, 20);
  text("50'-0\"", house.x + house.w / 2 - 12, house.y - 30, 10);

  // Sub-dimension on bottom: 22'-0" (left to first vertical wall)
  dimHorizontal(house.x, v1x, house.y, 40);
  text("22'-0\"", (house.x + v1x) / 2 - 12, house.y - 50, 10);

  // Sub-dimension 2: 14'-0" (between verticals)
  dimHorizontal(v1x, v2x, house.y, 40);
  text("14'-0\"", (v1x + v2x) / 2 - 10, house.y - 50, 10);

  // Sub-dimension 3: 14'-0" (right of last vertical to outer wall)
  dimHorizontal(v2x, house.x + house.w, house.y, 40);
  text("14'-0\"", (v2x + house.x + house.w) / 2 - 10, house.y - 50, 10);

  // Left dimension: 67'-0" overall
  dimVertical(house.y, house.y + house.d, house.x, 20);
  text("67'-0\"", house.x - 40, house.y + house.d / 2 - 4, 10);

  // Right side: 40'-0" + 27'-0" split at h1y
  dimVertical(house.y, h1y, house.x + house.w, 30);
  text("40'-0\"", house.x + house.w + 12, (house.y + h1y) / 2 - 4, 10);

  dimVertical(h1y, house.y + house.d, house.x + house.w, 30);
  text("27'-0\"", house.x + house.w + 12, (h1y + house.y + house.d) / 2 - 4, 10);

  // Door (gap + arc)
  const doorX = house.x + 6 * PT_PER_FT;
  const doorW = 3 * PT_PER_FT;
  // gap in bottom wall
  // (we don't actually punch the gap; just draw arc + leaf)
  const leafEnd = doorX + doorW;
  line({ x: doorX, y: house.y }, { x: doorX, y: house.y + doorW }, 1, rgb(0.5, 0.5, 0.5));
  line({ x: doorX, y: house.y }, { x: leafEnd, y: house.y + doorW }, 1, rgb(0.5, 0.5, 0.5));

  // Window (double line) on top wall
  const winX = house.x + 14 * PT_PER_FT;
  const winW = 4 * PT_PER_FT;
  line({ x: winX, y: house.y + house.d }, { x: winX, y: house.y + house.d + 4 }, 1, rgb(0.4, 0.4, 0.8));
  line({ x: winX + winW, y: house.y + house.d }, { x: winX + winW, y: house.y + house.d + 4 }, 1, rgb(0.4, 0.4, 0.8));

  // Title block at top-right
  page.drawRectangle({ x: 440, y: 720, width: 160, height: 60, borderWidth: 1, borderColor: rgb(0, 0, 0) });
  text('Test Plan 1', 450, 760, 12);
  text('Synthetic architect-style', 450, 745, 8);
  text('50\' x 67\' envelope', 450, 730, 8);

  const bytes = await pdf.save();
  fs.writeFileSync('/tmp/sample-arch.pdf', bytes);
  console.log('Wrote /tmp/sample-arch.pdf:', bytes.length, 'bytes');
})();
