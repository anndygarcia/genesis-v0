// Make a Garcia/Caballero-style synthetic PDF — first floor plan.
//
// Layout based on the actual Garcia residence (80.5 ft × 62 ft envelope),
// but simplified to test the extract pipeline. Walls are drawn with proper
// dimension annotations.
//
// Reference: see /tmp/garcia_pages/page_03.png for the real thing.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  // 24"x36" architect sheet = 1728pt × 2592pt. We'll draw the building
  // at 1/4" = 1' scale = 18 pt/foot. Building envelope: 80.5' × 62' =
  // 1449 × 1116 pt. Plus title block + margin = 1728 × 2592.
  const PT_PER_FT = 18;
  const page = pdf.addPage([1728, 2592]);
  const { width, height } = page.getSize();

  // Building envelope: place on the lower-left of the sheet.
  const ox = 144;          // 8" margin from left
  const oy = 720;          // leave room at the top for title block
  const house = { x: ox, y: oy, w: 80.5 * PT_PER_FT, d: 62 * PT_PER_FT };

  function line(p1, p2, thick = 2, color = rgb(0, 0, 0)) {
    page.drawLine({ start: p1, end: p2, thickness: thick, color });
  }
  function text(s, x, y, size = 14) {
    page.drawText(s, { x, y, size, font, color: rgb(0, 0, 0) });
  }
  function dimH(x1, x2, y, off = 36, label = '', size = 12) {
    const dy = y - off;
    line({ x: x1, y }, { x: x1, y: dy }, 1, rgb(0.4, 0.4, 0.4));
    line({ x: x2, y }, { x: x2, y: dy }, 1, rgb(0.4, 0.4, 0.4));
    line({ x: x1, y: dy }, { x: x2, y: dy }, 1, rgb(0.4, 0.4, 0.4));
    line({ x: x1, y: dy }, { x: x1 + 6, y: dy + 3 }, 1, rgb(0.4, 0.4, 0.4));
    line({ x: x1, y: dy }, { x: x1 + 6, y: dy - 3 }, 1, rgb(0.4, 0.4, 0.4));
    line({ x: x2, y: dy }, { x: x2 - 6, y: dy + 3 }, 1, rgb(0.4, 0.4, 0.4));
    line({ x: x2, y: dy }, { x: x2 - 6, y: dy - 3 }, 1, rgb(0.4, 0.4, 0.4));
    if (label) text(label, (x1 + x2) / 2 - 12, dy - 18, size);
  }
  function dimV(y1, y2, x, off = 36, label = '', size = 12) {
    const dx = x - off;
    line({ x, y: y1 }, { x: dx, y: y1 }, 1, rgb(0.4, 0.4, 0.4));
    line({ x, y: y2 }, { x: dx, y: y2 }, 1, rgb(0.4, 0.4, 0.4));
    line({ x: dx, y: y1 }, { x: dx, y: y2 }, 1, rgb(0.4, 0.4, 0.4));
    line({ x: dx, y: y1 }, { x: dx + 3, y: y1 + 6 }, 1, rgb(0.4, 0.4, 0.4));
    line({ x: dx, y: y1 }, { x: dx - 3, y: y1 + 6 }, 1, rgb(0.4, 0.4, 0.4));
    line({ x: dx, y: y2 }, { x: dx + 3, y: y2 - 6 }, 1, rgb(0.4, 0.4, 0.4));
    line({ x: dx, y: y2 }, { x: dx - 3, y: y2 - 6 }, 1, rgb(0.4, 0.4, 0.4));
    if (label) text(label, dx - 36, (y1 + y2) / 2 - 6, size);
  }

  // === OUTER WALLS ===
  const wt = 4;
  line({ x: house.x, y: house.y }, { x: house.x + house.w, y: house.y }, wt);
  line({ x: house.x + house.w, y: house.y }, { x: house.x + house.w, y: house.y + house.d }, wt);
  line({ x: house.x + house.w, y: house.y + house.d }, { x: house.x, y: house.y + house.d }, wt);
  line({ x: house.x, y: house.y + house.d }, { x: house.x, y: house.y }, wt);

  // === COVERED PORCH (north side, 18.2' x 11', open on the north) ===
  // Drawn as a rectangle with the north wall missing
  const cpW = 18.2 * PT_PER_FT;
  const cpD = 11 * PT_PER_FT;
  line({ x: house.x, y: house.y + house.d }, { x: house.x + cpW, y: house.y + house.d }, wt);
  line({ x: house.x, y: house.y + house.d - cpD }, { x: house.x + cpW, y: house.y + house.d - cpD }, wt);
  line({ x: house.x + cpW, y: house.y + house.d - cpD }, { x: house.x + cpW, y: house.y + house.d }, wt);

  // === LAUNDRY (0..6.8, 11..20.2) ===
  const laundry = { x: house.x, y: house.y + 11*PT_PER_FT, w: 6.8*PT_PER_FT, d: 9.2*PT_PER_FT };
  line({ x: laundry.x, y: laundry.y + laundry.d }, { x: laundry.x + laundry.w, y: laundry.y + laundry.d }, 2);
  line({ x: laundry.x + laundry.w, y: laundry.y }, { x: laundry.x + laundry.w, y: laundry.y + laundry.d }, 2);

  // === BREAKFAST (6.8..19.8, 11..20.2) ===
  const breakfast = { x: house.x + 6.8*PT_PER_FT, y: house.y + 11*PT_PER_FT, w: 13*PT_PER_FT, d: 9.8*PT_PER_FT };
  line({ x: breakfast.x + breakfast.w, y: breakfast.y }, { x: breakfast.x + breakfast.w, y: breakfast.y + breakfast.d }, 2);
  line({ x: breakfast.x, y: breakfast.y + breakfast.d }, { x: breakfast.x + breakfast.w, y: breakfast.y + breakfast.d }, 2);

  // === MASTER BATH (19.8..31, 11..23.4) ===
  const mba = { x: house.x + 19.8*PT_PER_FT, y: house.y + 11*PT_PER_FT, w: 11.2*PT_PER_FT, d: 12.4*PT_PER_FT };
  line({ x: mba.x + mba.w, y: mba.y }, { x: mba.x + mba.w, y: mba.y + mba.d }, 2);
  line({ x: mba.x, y: mba.y + mba.d }, { x: mba.x + mba.w, y: mba.y + mba.d }, 2);

  // === MASTER BR (31..46.4, 41..59.2 - wait, master br is on NORTH) ===
  // Master Bedroom is 15.4' × 18.2', at north-east: x=31, z=0 (north)
  // No inner walls north of the master BR line — it's all open to the north
  const mbr = { x: house.x + 31*PT_PER_FT, y: house.y + 18.2*PT_PER_FT, w: 15.4*PT_PER_FT, d: 18.2*PT_PER_FT };
  line({ x: mbr.x, y: mbr.y + mbr.d }, { x: mbr.x + mbr.w, y: mbr.y + mbr.d }, 2);
  line({ x: mbr.x + mbr.w, y: mbr.y }, { x: mbr.x + mbr.w, y: mbr.y + mbr.d }, 2);

  // === WIC (46.4..58.4, 0..14) ===
  const wic = { x: house.x + 46.4*PT_PER_FT, y: house.y, w: 12*PT_PER_FT, d: 14*PT_PER_FT };
  line({ x: wic.x + wic.w, y: wic.y }, { x: wic.x + wic.w, y: wic.y + wic.d }, 2);
  line({ x: wic.x, y: wic.y + wic.d }, { x: wic.x + wic.w, y: wic.y + wic.d }, 2);

  // === STUDY (58.4..80.5, 0..13.4) ===
  const study = { x: house.x + 58.4*PT_PER_FT, y: house.y, w: 22.1*PT_PER_FT, d: 13.4*PT_PER_FT };
  // No east wall needed (it's the outer east wall), no south wall (open to rest)
  line({ x: study.x, y: study.y + study.d }, { x: study.x + study.w, y: study.y + study.d }, 2);

  // === PORTE-COCHERE (0..21, 20.2..43.2 - 3 sides open) ===
  const pc = { x: house.x, y: house.y + 20.2*PT_PER_FT, w: 21*PT_PER_FT, d: 23*PT_PER_FT };
  // Only the east wall (shared with family room)
  line({ x: pc.x + pc.w, y: pc.y }, { x: pc.x + pc.w, y: pc.y + pc.d }, 2);

  // === FAMILY RM (21..40.4, 20.2..39.8) ===
  const fam = { x: house.x + 21*PT_PER_FT, y: house.y + 20.2*PT_PER_FT, w: 19.4*PT_PER_FT, d: 19.6*PT_PER_FT };
  line({ x: fam.x + fam.w, y: fam.y }, { x: fam.x + fam.w, y: fam.y + fam.d }, 2);

  // === KITCHEN (40.4..53.6, 20.2..31.2) ===
  const kit = { x: house.x + 40.4*PT_PER_FT, y: house.y + 20.2*PT_PER_FT, w: 13.2*PT_PER_FT, d: 11*PT_PER_FT };
  line({ x: kit.x + kit.w, y: kit.y }, { x: kit.x + kit.w, y: kit.y + kit.d }, 2);
  line({ x: kit.x, y: kit.y + kit.d }, { x: kit.x + kit.w, y: kit.y + kit.d }, 2);

  // === PANTRY (53.6..61.6, 24.4..28.6) ===
  const pan = { x: house.x + 53.6*PT_PER_FT, y: house.y + 24.4*PT_PER_FT, w: 8*PT_PER_FT, d: 4.2*PT_PER_FT };
  line({ x: pan.x, y: pan.y }, { x: pan.x + pan.w, y: pan.y }, 2);
  line({ x: pan.x, y: pan.y }, { x: pan.x, y: pan.y + pan.d }, 2);
  line({ x: pan.x + pan.w, y: pan.y }, { x: pan.x + pan.w, y: pan.y + pan.d }, 2);
  line({ x: pan.x, y: pan.y + pan.d }, { x: pan.x + pan.w, y: pan.y + pan.d }, 2);

  // === DINING (40.4..53.4, 36.4..52.2 - TWO STORY) ===
  const din = { x: house.x + 40.4*PT_PER_FT, y: house.y + 36.4*PT_PER_FT, w: 13*PT_PER_FT, d: 15.8*PT_PER_FT };
  line({ x: din.x, y: din.y }, { x: din.x + din.w, y: din.y }, 2);
  line({ x: din.x + din.w, y: din.y }, { x: din.x + din.w, y: din.y + din.d }, 2);
  line({ x: din.x, y: din.y + din.d }, { x: din.x + din.w, y: din.y + din.d }, 2);

  // === FOYER (53.4..66.4, 36.4..52.2 - TWO STORY) ===
  const foy = { x: house.x + 53.4*PT_PER_FT, y: house.y + 36.4*PT_PER_FT, w: 13*PT_PER_FT, d: 15.8*PT_PER_FT };
  line({ x: foy.x + foy.w, y: foy.y }, { x: foy.x + foy.w, y: foy.y + foy.d }, 2);
  line({ x: foy.x, y: foy.y + foy.d }, { x: foy.x + foy.w, y: foy.y + foy.d }, 2);

  // === BR.2 (0..13, 43.2..55.8) ===
  const br2 = { x: house.x, y: house.y + 43.2*PT_PER_FT, w: 13*PT_PER_FT, d: 12.6*PT_PER_FT };
  line({ x: br2.x + br2.w, y: br2.y }, { x: br2.x + br2.w, y: br2.y + br2.d }, 2);
  line({ x: br2.x, y: br2.y + br2.d }, { x: br2.x + br2.w, y: br2.y + br2.d }, 2);

  // === BATH 2 (13..19.8, 43.2..49.2) ===
  const bath2 = { x: house.x + 13*PT_PER_FT, y: house.y + 43.2*PT_PER_FT, w: 6.8*PT_PER_FT, d: 6*PT_PER_FT };
  line({ x: bath2.x + bath2.w, y: bath2.y }, { x: bath2.x + bath2.w, y: bath2.y + bath2.d }, 2);
  line({ x: bath2.x, y: bath2.y + bath2.d }, { x: bath2.x + bath2.w, y: bath2.y + bath2.d }, 2);

  // === COURTYARD (26.6..38.6, 43.2..53.6 - OPEN AIR) ===
  // No walls around it
  const court = { x: house.x + 26.6*PT_PER_FT, y: house.y + 43.2*PT_PER_FT, w: 12*PT_PER_FT, d: 10.4*PT_PER_FT };
  // No walls (it's open air)

  // === ENTRY PORCH (0..26.6, 55.8..62 - open south) ===
  const ep = { x: house.x, y: house.y + 55.8*PT_PER_FT, w: 26.6*PT_PER_FT, d: 6.2*PT_PER_FT };
  // Only the north wall (and side walls)
  line({ x: ep.x, y: ep.y + ep.d }, { x: ep.x + ep.w, y: ep.y + ep.d }, wt);
  line({ x: ep.x + ep.w, y: ep.y }, { x: ep.x + ep.w, y: ep.y + ep.d }, 2);

  // === ROOM LABELS ===
  function label(room, name) {
    text(name, room.x + 8, room.y + room.d/2, 10);
  }
  label({x: house.x, y: house.y, w: 6.8*PT_PER_FT, d: 11*PT_PER_FT}, 'Cov. Porch');
  label(laundry, 'Laundry');
  label(breakfast, 'Breakfast Nook');
  label(mba, 'Master Bath');
  label({x: mbr.x, y: mbr.y, w: mbr.w, d: 18.2*PT_PER_FT}, 'Master BR');
  label(wic, 'Walk-in Closet');
  label(study, 'Study');
  label({x: house.x, y: house.y + 20.2*PT_PER_FT, w: 21*PT_PER_FT, d: 23*PT_PER_FT}, 'Porte-cochère');
  label(fam, 'Family Room');
  label(kit, 'Kitchen');
  label(pan, 'Pantry');
  label(din, 'Dining');
  label(foy, 'Foyer');
  label(br2, 'Bedroom 2');
  label(bath2, 'Bath 2');
  label({x: house.x, y: house.y + 43.2*PT_PER_FT, w: 26.6*PT_PER_FT, d: 10.4*PT_PER_FT}, 'Courtyard');
  label({x: house.x, y: house.y + 55.8*PT_PER_FT, w: 26.6*PT_PER_FT, d: 6.2*PT_PER_FT}, 'Entry Porch');

  // === DIMENSION ANNOTATIONS ===
  dimH(house.x, house.x + house.w, house.y, 50, "80'-6\"");
  dimH(house.x + 18.2*PT_PER_FT, house.x + 31*PT_PER_FT, house.y, 70, "13'-0\"");
  dimV(house.y, house.y + house.d, house.x, 60, "62'-0\"");
  dimV(house.y + 11*PT_PER_FT, house.y + 20.2*PT_PER_FT, house.x + 6.8*PT_PER_FT, 50, "9'-2\"");
  dimH(house.x + 21*PT_PER_FT, house.x + 40.4*PT_PER_FT, house.y + 20.2*PT_PER_FT, 60, "19'-4\"");

  // === TITLE BLOCK ===
  page.drawRectangle({ x: 1440, y: 60, width: 240, height: 120, borderWidth: 1, borderColor: rgb(0, 0, 0) });
  text('Garcia/Caballero', 1452, 145, 14);
  text('Residence', 1452, 125, 14);
  text('Plan #19 — 1st Floor', 1452, 100, 10);
  text('Synthetic test PDF', 1452, 80, 8);

  const bytes = await pdf.save();
  fs.writeFileSync('/tmp/garcia-test.pdf', bytes);
  console.log('Wrote /tmp/garcia-test.pdf:', bytes.length, 'bytes');
})();
