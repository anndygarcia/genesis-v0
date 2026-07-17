// GENESIS · state
//
// The single source of truth for house geometry. Every other module
// reads from `state.house`. To swap a plan in, hand a plan object to
// `loadPlan(plan)`. The shape is the same regardless of source —
// whether the plan came from a hand-authored JSON, a YOLO-detected
// PDF, or the demo data baked below.
//
// =============================================================
//   PUBLIC STATE
// =============================================================

export const state = {
  // The current house. Replaced wholesale on `loadPlan`.
  house: null,

  // UI flags the rest of the app reads (e.g. camera mode, postprocessing)
  ui: {
    post: true,
    walkMode: false,
    measurementVisible: false,
  },

  // Floating stats the HUD reads — derived from house at load time.
  stats: {
    roomCount: 0,
    interiorWalls: 0,
    exteriorWalls: 0,
    openings: 0,
    floorAreaSqFt: 0,
  },
};

// =============================================================
//   DEMO PLAN — the default Genesis sample home
// =============================================================

export const DEMO_PLAN = {
  name: 'Sample Home',
  planNumber: 1,
  rooms: [
    { id: 'living',  name: 'Living Room',  x: 0,   z: 0,   w: 20, d: 18, h: 9, color: '#fff3e6', accent: '#d97706' },
    { id: 'kitchen', name: 'Kitchen',      x: 20,  z: 0,   w: 14, d: 18, h: 9, color: '#e6f4ff', accent: '#0369a1' },
    { id: 'master',  name: 'Master Bed',   x: 34,  z: 0,   w: 12, d: 18, h: 9, color: '#f3e8ff', accent: '#7c3aed' },
    { id: 'bed2',    name: 'Bedroom 2',    x: 0,   z: 18,  w: 14, d: 12, h: 9, color: '#f3e8ff', accent: '#7c3aed' },
    { id: 'bed3',    name: 'Bedroom 3',    x: 14,  z: 18,  w: 12, d: 12, h: 9, color: '#f3e8ff', accent: '#7c3aed' },
    { id: 'bath',    name: 'Bathroom',     x: 26,  z: 18,  w: 8,  d: 12, h: 9, color: '#e0f7fa', accent: '#0891b2' },
  ],
  doors: [
    { id: 'front-entry',   x: 6,   z: 0,    w: 3, axis: 'z', kind: 'exterior',  label: 'Front Entry' },
    { id: 'back-patio',    x: 28,  z: 30,   w: 5, axis: 'z', kind: 'exterior',  label: 'Back Patio', flip: true },
    { id: 'master-bath',   x: 40,  z: 9,    w: 3, axis: 'z', kind: 'interior',  label: 'Master Bath', interior: { room: 'master' } },
    { id: 'bed2-entry',    x: 6,   z: 18,   w: 3, axis: 'z', kind: 'interior',  label: 'Bed 2 Entry', interior: { room: 'bed2' } },
    { id: 'bed3-entry',    x: 18,  z: 18,   w: 3, axis: 'z', kind: 'interior',  label: 'Bed 3 Entry', interior: { room: 'bed3' } },
  ],
  windows: [
    { id: 'living-win-1',   x: 4,   z: 30,   w: 4, axis: 'z', label: 'Living Window' },
    { id: 'bed2-win',       x: 16,  z: 30,   w: 4, axis: 'z', label: 'Bed 2 Window' },
    { id: 'bed3-win',       x: 26,  z: 30,   w: 4, axis: 'z', label: 'Bed 3 Window' },
    { id: 'bath-win',       x: 39,  z: 30,   w: 4, axis: 'z', label: 'Bath Window' },
    { id: 'living-side',    x: 0,   z: 4,    w: 3, axis: 'x', label: 'Living Side' },
    { id: 'living-side-2',  x: 0,   z: 12,   w: 3, axis: 'x', label: 'Living Side 2' },
    { id: 'kitchen-win',    x: 14,  z: 0,    w: 3, axis: 'x', label: 'Kitchen Window' },
    { id: 'kitchen-win-2',  x: 24,  z: 0,    w: 3, axis: 'x', label: 'Kitchen Window 2' },
    { id: 'master-win',     x: 46,  z: 4,    w: 3, axis: 'x', label: 'Master Window' },
    { id: 'master-win-2',   x: 46,  z: 12,   w: 3, axis: 'x', label: 'Master Window 2' },
  ],
};

// =============================================================
//   BUILD PIPELINE
// =============================================================
//
// `buildSceneFrom(plan)` is the ONE function that converts data into
// scene geometry. Everything in the app (measurement, estimator, HUD)
// reads from `state.house` afterward. Adding new plan sources (PDF,
// YOLO, drag-drop) means writing a `plan = extractFromXxx()` step
// followed by `loadPlan(plan)`.
//
// Coordinates:
//   x ∈ [0, footprintW]  east-west in feet
//   z ∈ [0, footprintD]  north-south in feet
//   y ∈ [0, wallH]       up

const DEFAULT_FOOTPRINT = { w: 46, d: 30, wallH: 9 };

/**
 * Validate a plan, normalize fields, fill in defaults. Returns a
 * canonicalized plan or throws an Error with a descriptive message.
 *
 * @param {object} raw
 * @returns {object} canonical plan
 */
export function validatePlan(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('plan must be an object');
  if (!Array.isArray(raw.rooms)) throw new Error('plan.rooms must be an array');
  if (!Array.isArray(raw.doors)) raw.doors = [];
  if (!Array.isArray(raw.windows)) raw.windows = [];

  const rooms = raw.rooms.map((r, i) => {
    if (typeof r.x !== 'number' || typeof r.z !== 'number') {
      throw new Error(`rooms[${i}] needs numeric x and z`);
    }
    if (typeof r.w !== 'number' || typeof r.d !== 'number' || r.w <= 0 || r.d <= 0) {
      throw new Error(`rooms[${i}] needs positive w and d (width, depth in feet)`);
    }
    return {
      id:         String(r.id   || `room-${i}`),
      name:       String(r.name || `Room ${i + 1}`),
      x:          Number(r.x),
      z:          Number(r.z),
      w:          Number(r.w),
      d:          Number(r.d),
      // Ceiling height (feet). Defaults to 9ft. Two-story volumes have
      // h ≈ 18–22ft and are typically listed in plan.roofOpenRooms
      // below so the roof builder skips their footprint.
      h:          Number(r.h   || DEFAULT_FOOTPRINT.wallH),
      color:      String(r.color || '#e6edf3'),
      accent:     String(r.accent || '#666'),
      notes:      String(r.notes || ''),
      // Extra type metadata — 'stairs' triggers buildStairs() instead of
      // a floor tile; toElevation/riserFt/treadFt/direction parameterize
      // the stair geometry. Other type values fall through to the
      // standard floor-tile path.
      kind:        r.kind ? String(r.kind) : '',
      toElevation: r.toElevation != null ? Number(r.toElevation) : null,
      riserFt:     r.riserFt != null ? Number(r.riserFt) : null,
      treadFt:     r.treadFt != null ? Number(r.treadFt) : null,
      direction:   r.direction ? String(r.direction) : '',
    };
  });

  const doors = raw.doors.map((d, i) => ({
    id:     String(d.id || `door-${i}`),
    x:      Number(d.x),
    z:      Number(d.z),
    w:      Number(d.w || 3),
    axis:   (d.axis === 'x' || d.axis === 'z') ? d.axis : 'z',
    kind:   d.kind === 'interior' ? 'interior' : 'exterior',
    label:  String(d.label || 'Door'),
    host:   d.host || null,
    flip:   !!d.flip,
  }));

  const windows = raw.windows.map((w, i) => ({
    id:    String(w.id || `win-${i}`),
    x:     Number(w.x),
    z:     Number(w.z),
    w:     Number(w.w || 3),
    axis:  (w.axis === 'x' || w.axis === 'z') ? w.axis : 'z',
    label: String(w.label || 'Window'),
    host:  w.host || null,
  }));

  // Compute footprint from room extents (handles any plan size)
  let maxX = 0, maxZ = 0;
  for (const r of rooms) {
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.z + r.d > maxZ) maxZ = r.z + r.d;
  }
  // Respect caller-provided footprint when present
  const footprintW = Number(raw.footprint?.w) || Math.max(maxX, DEFAULT_FOOTPRINT.w);
  const footprintD = Number(raw.footprint?.d) || Math.max(maxZ, DEFAULT_FOOTPRINT.d);

  return {
    name:       String(raw.name || 'Untitled Home'),
    planNumber: Number(raw.planNumber || 1),
    rooms,
    doors,
    windows,
    footprint: { w: footprintW, d: footprintD },
    // ============ v1.3+ architectural extensions ============
    // Array of room IDs whose footprint should NOT receive a roof.
    // Used for two-story volumes (the dining room / foyer in the
    // Garcia residence: 22ft ceiling, open to the second floor).
    // Builder walks this list and skips those rectangles when
    // tiling the gable. Walls bounding those rooms still extend up
    // to room.h, giving the volume its tall interior.
    roofOpenRooms: Array.isArray(raw.roofOpenRooms)
      ? raw.roofOpenRooms.map(String)
      : [],
    // Optional floor-stack metadata. v2.0 only renders the first floor;
    // v2.1 will add an elevation / stack per entry.
    // Each floor: { name, rooms: [id, ...], elevation: number (y-offset, ft) }
    floors: Array.isArray(raw.floors)
      ? raw.floors.map((f, i) => ({
          name: String(f.name || `Floor ${i + 1}`),
          rooms: Array.isArray(f.rooms) ? f.rooms.map(String) : rooms.map(r => r.id),
          elevation: Number(f.elevation || 0),
        }))
      : [{ name: 'Ground', rooms: rooms.map(r => r.id), elevation: 0 }],
    // Per-axis wall heights override (rarely needed — defaults to
    // per-room h). Format: { 'south': 22, 'east': 18, ... }.
    // Used by some plans where a side wall is taller than the rooms.
    wallOverrides: raw.wallOverrides && typeof raw.wallOverrides === 'object'
      ? Object.fromEntries(Object.entries(raw.wallOverrides).map(([k, v]) => [k, Number(v)]))
      : {},
  };
}

/**
 * Derive walls from rooms. Returns the four types of walls:
 *
 * - outer:     the perimeter wall of the home (axis-aligned rectangle)
 * - interior:  shared boundaries between adjacent rooms (computed)
 * - doors:     just the door meshes (positioned on host wall)
 * - windows:   just the window meshes
 *
 * Each wall records the IDs of the rooms it divides (so a click
 * measurement can answer "which two rooms does this wall split?").
 *
 * @param {object} plan canonical plan
 * @returns {{ outer:Wall[], interior:Wall[], openings:{doors:Opening[],windows:Opening[]} }}
 */
export function deriveWalls(plan) {
  const outer = [];
  const interior = [];
  const wallsByRoom = {};  // roomId → wallIds[]

  // Outer rectangle
  const { w: W, d: D } = plan.footprint;

  // Wall heights come from the max h of any room on the *inside* of
  // that wall. For v1.3 we still treat each side as one uniform
  // height, which gives a reasonable approximation. (v2.1 will allow
  // per-segment heights.)
  // North (z = D) side rooms = rooms whose z + d == D
  // South (z = 0)  side rooms = rooms whose z == 0
  // West  (x = 0)  side rooms = rooms whose x == 0
  // East  (x = W)  side rooms = rooms whose x + w == W
  const wallHeightBySide = { n: 9, s: 9, w: 9, e: 9 };
  for (const r of plan.rooms) {
    if (r.z === 0)        wallHeightBySide.s = Math.max(wallHeightBySide.s, r.h || 9);
    if (r.z + r.d === D)  wallHeightBySide.n = Math.max(wallHeightBySide.n, r.h || 9);
    if (r.x === 0)        wallHeightBySide.w = Math.max(wallHeightBySide.w, r.h || 9);
    if (r.x + r.w === W)  wallHeightBySide.e = Math.max(wallHeightBySide.e, r.h || 9);
  }

  outer.push({
    id: 'outer-s', length: W, axis: 'x', side: 's',
    rooms: [], isOuter: true, height: wallHeightBySide.s,
  });
  outer.push({
    id: 'outer-n', length: W, axis: 'x', side: 'n',
    rooms: [], isOuter: true, height: wallHeightBySide.n,
  });
  outer.push({
    id: 'outer-w', length: D, axis: 'z', side: 'w',
    rooms: [], isOuter: true, height: wallHeightBySide.w,
  });
  outer.push({
    id: 'outer-e', length: D, axis: 'z', side: 'e',
    rooms: [], isOuter: true, height: wallHeightBySide.e,
  });

  // Interior walls — every pair of rooms that share an edge
  for (let i = 0; i < plan.rooms.length; i++) {
    const a = plan.rooms[i];
    wallsByRoom[a.id] = wallsByRoom[a.id] || [];
    for (let j = i + 1; j < plan.rooms.length; j++) {
      const b = plan.rooms[j];
      wallsByRoom[b.id] = wallsByRoom[b.id] || [];
      const shared = sharedEdge(a, b);
      if (shared) {
        const wid = `wall-${a.id}-${b.id}`;
        interior.push({
          id: wid,
          length: shared.length,
          axis: shared.axis,
          side: shared.side,
          x: shared.x, z: shared.z,
          rooms: [a.id, b.id],
          isOuter: false,
          // v1.3: wall height = max of the two rooms' ceiling heights.
          // This way a two-story room (h=22) bumps a 10ft neighbor's
          // shared wall up to 22ft, which is physically what an open
          // volume looks like in a real house.
          height: Math.max(a.h || 9, b.h || 9),
        });
        wallsByRoom[a.id].push(wid);
        wallsByRoom[b.id].push(wid);
      }
    }
  }

  return {
    outer,
    interior,
    wallsByRoom,
    openings: {
      doors:   plan.doors,
      windows: plan.windows,
    },
  };
}

/**
 * Compute derived stats. Pure function — no side effects.
 */
export function computeStats(plan, walls) {
  const floorArea = plan.rooms.reduce((s, r) => s + r.w * r.d, 0);
  const interiorLF = walls.interior.reduce((s, w) => s + w.length, 0);
  const exteriorLF = walls.outer.reduce((s, w) => s + w.length, 0);

  return {
    roomCount:        plan.rooms.length,
    interiorWalls:    walls.interior.length,
    exteriorWalls:    walls.outer.length,
    openings:         plan.doors.length + plan.windows.length,
    floorAreaSqFt:    Math.round(floorArea),
    linearFtInterior: Math.round(interiorLF),
    linearFtExterior: Math.round(exteriorLF),
  };
}

// =============================================================
//   HELPERS
// =============================================================

/**
 * Find a room by id (string). Returns null if not found.
 */
export function getRoom(id) {
  if (!state.house) return null;
  return state.house.plan.rooms.find(r => r.id === id) || null;
}

/**
 * Find a wall by id. Searches both outer walls (state.house.walls)
 * and interior walls (state.house.interiorWalls). Returns null if not found.
 */
export function getWall(id) {
  if (!state.house) return null;
  return (
    (state.house.walls || []).find(w => w.id === id) ||
    (state.house.interiorWalls || []).find(w => w.id === id) ||
    null
  );
}

/**
 * Find any opening by id (door or window). Returns null if not found.
 */
export function getOpening(id) {
  if (!state.house) return null;
  return (
    state.house.plan.doors.find(d => d.id === id) ||
    state.house.plan.windows.find(w => w.id === id) ||
    null
  );
}

/**
 * Pretty-print the current state. Useful for devtools + tests.
 */
export function describe() {
  if (!state.house) return '<no house loaded>';
  const h = state.house;
  const s = state.stats;
  return `${h.plan.name} (Plan #${h.plan.planNumber})
  Footprint: ${h.plan.footprint.w}'×${h.plan.footprint.d}'
  Rooms: ${s.roomCount}, totaling ${s.floorAreaSqFt} sq ft
  Walls: ${s.interiorWalls} interior, ${s.exteriorWalls} exterior
  Openings: ${s.openings} (${h.plan.doors.length} doors, ${h.plan.windows.length} windows)`;
}

// =============================================================
//   INTERNAL — shared edges between rooms
// =============================================================

/**
 * Returns null or { x, z, length, axis, side } describing the
 * shared edge between two rooms.
 */
function sharedEdge(a, b) {
  // East-west shared edge (both rooms span z ∈ [z1, z2], x is shared)
  // b to the east of a, sharing x = a.x + a.w
  if (
    Math.abs((a.x + a.w) - b.x) < 0.01 &&
    intervalsOverlap(a.z, a.z + a.d, b.z, b.z + b.d)
  ) {
    const lo = Math.max(a.z, b.z);
    const hi = Math.min(a.z + a.d, b.z + b.d);
    return { x: a.x + a.w, z: lo, length: hi - lo, axis: 'z', side: 'e' };
  }
  if (
    Math.abs((b.x + b.w) - a.x) < 0.01 &&
    intervalsOverlap(a.z, a.z + a.d, b.z, b.z + b.d)
  ) {
    const lo = Math.max(a.z, b.z);
    const hi = Math.min(a.z + a.d, b.z + b.d);
    return { x: b.x + b.w, z: lo, length: hi - lo, axis: 'z', side: 'w' };
  }
  // North-south shared edge
  if (
    Math.abs((a.z + a.d) - b.z) < 0.01 &&
    intervalsOverlap(a.x, a.x + a.w, b.x, b.x + b.w)
  ) {
    const lo = Math.max(a.x, b.x);
    const hi = Math.min(a.x + a.w, b.x + b.w);
    return { x: lo, z: a.z + a.d, length: hi - lo, axis: 'x', side: 'n' };
  }
  if (
    Math.abs((b.z + b.d) - a.z) < 0.01 &&
    intervalsOverlap(a.x, a.x + a.w, b.x, b.x + b.w)
  ) {
    const lo = Math.max(a.x, b.x);
    const hi = Math.min(a.x + a.w, b.x + b.w);
    return { x: lo, z: b.z + b.d, length: hi - lo, axis: 'x', side: 's' };
  }
  return null;
}

function intervalsOverlap(a1, a2, b1, b2) {
  return Math.max(a1, b1) < Math.min(a2, b2);
}

// =============================================================
//   PUBLIC — load a plan into state
// =============================================================

/**
 * Validate + derive + install. Returns the new `state.house`.
 * Throws on invalid plan input.
 */
export function loadPlan(rawPlan) {
  const plan = validatePlan(rawPlan);
  const walls = deriveWalls(plan);
  const stats = computeStats(plan, walls);

  state.house = {
    plan,
    walls: walls.outer,            // for code that iterates all walls
    interiorWalls: walls.interior,
    wallsByRoom: walls.wallsByRoom,
    openings: walls.openings,
  };
  state.stats = stats;

  return state.house;
}

// =============================================================
//   INIT — load the demo plan so callers reading state.house
//   synchronously right after import get sensible defaults.
// =============================================================

loadPlan(DEMO_PLAN);
