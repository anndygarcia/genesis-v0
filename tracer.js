// GENESIS · tracer
//
// v2.0 no-ML plan capture. The user draws polygons on top of an
// uploaded image (or a PDF page rendered to canvas) by clicking
// corners. The tracer accumulates a list of ROOM polygons, lets
// the user calibrate scale via one known dimension, and emits a
// `plan` JSON matching the state.js schema so that
// `GENESIS.loadPlan(plan)` "just works".
//
// Scope: pure data, no DOM. The viewer owns the UI (see Trace
// button + overlay in index.html + styles.css).

/**
 * Create a tracer instance.
 *
 * @param {object} [opts]
 * @param {number} [opts.minNodes=3] Minimum nodes to close a polygon.
 * @returns {{
 *   addNode: (x:number, y:number) => number, // returns node index
 *   closePolygon: (name?: string) => any,    // returns the closed room or null
 *   setScale: (pixelDistance: number, realFeet: number) => void,
 *   setOrigin: (worldX: number, worldZ: number) => void,
 *   getScale: () => number,                   // pixels per foot
 *   getOrigin: () => {x:number, z:number},
 *   exportPlan: (name?: string) => any,      // emits the canonical plan JSON
 *   reset: () => void,
 *   rooms: any[],                             // list of closed rooms so the UI can render
 *   nodes: {x:number, y:number}[],            // live list of open polygon nodes (UI cursor)
 * }}
 */
export function createTracer({ minNodes = 3 } = {}) {
  /** @type {{x:number, y:number}[]} */
  const nodes = [];
  /** @type {{name:string, polygon:{x:number, y:number}[]}[]} */
  const rooms = [];
  let pixelsPerFoot = 1;     // calibration factor; default to 1 px/ft
  let origin = { x: 0, z: 0 };

  return {
    addNode(x, y) {
      // Dedup within 8 pixels: avoid a double-click landing two nodes.
      const last = nodes[nodes.length - 1];
      if (last && Math.hypot(x - last.x, y - last.y) < 8) return nodes.length - 1;
      nodes.push({ x, y });
      return nodes.length - 1;
    },

    closePolygon(name) {
      if (nodes.length < minNodes) return null;
      const polygon = nodes.slice();
      rooms.push({ name: name || `Room ${rooms.length + 1}`, polygon });
      // A closed room becomes the start of the next open polygon, so the
      // user can keep tracing and share an edge with the previous room.
      // (For v2.0 we just clear the node list — the user explicitly starts
      // each new room.)
      nodes.length = 0;
      return rooms[rooms.length - 1];
    },

    setScale(pixelDistance, realFeet) {
      if (!pixelDistance || pixelDistance <= 0 || !realFeet) return;
      pixelsPerFoot = pixelDistance / realFeet;
    },

    setOrigin(x, z) {
      origin = { x, z };
    },

    getScale() {
      return pixelsPerFoot;
    },

    getOrigin() {
      return { ...origin };
    },

    /**
     * Emit a plan JSON compatible with state.house.plan:
     *   { name, rooms: [{id, name, x, z, w, d, color}], doors, windows }
     *
     * Each polygon's axis-aligned bounding box becomes the room rectangle.
     * Walks are emitted implicitly by state.house.plan footprint + interior
     * edge derivation in deriveWalls().
     */
    exportPlan(name) {
      if (!rooms.length) return null;
      const ppf = pixelsPerFoot || 1;
      const planRooms = rooms.map((r, i) => {
        // Convert pixel-space polygon to feet-space bounding box.
        const bbox = polygonBBox(r.polygon);
        const xFt = bbox.x / ppf;
        const zFt = bbox.y / ppf;
        const wFt = bbox.w / ppf;
        const dFt = bbox.d / ppf;
        return {
          id: slug(r.name) || `room${i + 1}`,
          name: r.name,
          x: xFt + origin.x,
          z: zFt + origin.z,
          w: wFt,
          d: dFt,
          // Default accent + a per-room cycle for visual differentiation
          color: ROOM_COLORS[i % ROOM_COLORS.length],
          h: 9,        // wall height — default; user can edit later
        };
      });
      return {
        name: name || 'Traced plan',
        rooms: planRooms,
        doors: [],
        windows: [],
        dimensions: { source: 'user-trace', pixelsPerFoot, origin },
      };
    },

    reset() {
      nodes.length = 0;
      rooms.length = 0;
      pixelsPerFoot = 1;
      origin = { x: 0, z: 0 };
    },

    // Read-only views for the UI
    get nodes() { return nodes.slice(); },
    get rooms() { return rooms.slice(); },
  };
}

// ----- helpers -----

const ROOM_COLORS = [
  0xfff3e6, // cream (living)
  0xe6f3ff, // blue (bed)
  0xf0ffe6, // green (kitchen)
  0xffe6f0, // pink (bath)
  0xf3e6ff, // lavender (master)
  0xffe6e6, // rose (other)
];

function polygonBBox(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // Caller passes pixelsPerFoot via getScale(); we operate in pixel space
  // and the conversion happens in exportPlan via translate-only for v2.0.
  return { x: minX / 1, y: minY / 1, w: maxX - minX, d: maxY - minY };
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
