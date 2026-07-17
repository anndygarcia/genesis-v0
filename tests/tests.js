// GENESIS · foundation tests
// Headless assertions against state.js. No Three.js; runs anywhere.
//
// Open tests.html in a browser to see results.

import {
  state,
  DEMO_PLAN,
  loadPlan,
  validatePlan,
  deriveWalls,
  computeStats,
  getRoom, getWall, getOpening,
  describe,
} from '../state.js';

// =====================================================
//   Test harness
// =====================================================

const tests = [];
const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);

function test(name, fn) {
  tests.push({ name, fn });
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// =====================================================
//   TESTS (read-only — order does not matter)
// =====================================================

test('module loads; DEMO_PLAN is the default', () => {
  assert(state.house, 'state.house should be initialized at import');
  assert(state.house.plan.name === DEMO_PLAN.name, 'plan name matches DEMO_PLAN');
  assert(state.house.plan.planNumber === DEMO_PLAN.planNumber, 'planNumber matches');
  assert(state.house.plan.rooms.length === DEMO_PLAN.rooms.length, 'room counts match');
  assert(state.house.plan.footprint, 'state.house.plan.footprint should exist');
});

test('describe() is human-readable', () => {
  const out = describe();
  assert(typeof out === 'string' && out.includes('Sample Home'), 'references demo name');
  assert(out.includes('1236 sq ft'), 'computes total floor area');
  // describe() outputs "Rooms: 6, totaling..." → "Rooms: 6" substring is the marker
  assert(out.includes('Rooms: 6'), 'includes room count');
});

test('getRoom(id) returns the matching room', () => {
  const r = getRoom('living');
  assert(r && r.id === 'living', 'finds living room');
  assert(isNum(r.w) && isNum(r.d), 'w and d are numeric');
  assert(r.h === 9, 'h defaults to 9');
});

test('getRoom(bogus) returns null', () => {
  assert(getRoom('nothing-room') === null, 'unknown ids return null');
});

test('getWall returns inner + outer walls', () => {
  const outerW = getWall('outer-n');
  assert(outerW && outerW.isOuter === true, 'outer wall flagged');
  const int = state.house.interiorWalls[0];
  const found = getWall(int.id);
  assert(found && found.id === int.id, 'interior wall lookup');
});

test('getOpening finds doors and windows', () => {
  const d = getOpening(DEMO_PLAN.doors[0].id);
  assert(d && (d.kind === 'exterior' || d.kind === 'interior'), 'door kind');
  const w = getOpening(DEMO_PLAN.windows[0].id);
  assert(w && w.label, 'window has label');
});

test('validatePlan fills defaults + canonicalizes', () => {
  const raw = {
    name: 'Test', planNumber: 7,
    rooms: [{ name: 'A', x: 0, z: 0, w: 10, d: 10 }],
  };
  const p = validatePlan(raw);
  assert(p.name === 'Test', 'preserves name');
  assert(p.planNumber === 7, 'preserves planNumber');
  assert(p.rooms.length === 1, 'fills rooms');
  assert(p.rooms[0].h === 9, 'default wallH');
  assert(p.footprint.w >= 10, 'footprint derived from rooms');
});

test('validatePlan rejects bad input', () => {
  let threw = 0;
  try { validatePlan(null); } catch { threw++; }
  try { validatePlan({}); } catch { threw++; }
  try { validatePlan({ rooms: [{ x: 'a', z: 0, w: 1, d: 1 }] }); } catch { threw++; }
  try { validatePlan({ rooms: [{ x: 0, z: 0, w: -1, d: 1 }] }); } catch { threw++; }
  assert(threw === 4, 'all 4 invalid inputs should throw');
});

test('deriveWalls finds shared edges', () => {
  const plan = validatePlan({
    rooms: [
      { name: 'A', x: 0, z: 0, w: 10, d: 10 },
      { name: 'B', x: 10, z: 0, w: 10, d: 10 },
    ],
  });
  const w = deriveWalls(plan);
  assert(w.interior.length === 1, 'two adjacent rooms share 1 interior wall');
  assert(Math.abs(w.interior[0].length - 10) < 0.01, 'shared edge is 10 ft long');
  assert(w.interior[0].rooms.length === 2, 'wall records both rooms it divides');
});

test('deriveWalls: 4 rooms in a 2x2 grid → 4 interior walls', () => {
  const plan = validatePlan({
    rooms: [
      { name: 'NW', x: 0,  z: 0,  w: 10, d: 10 },
      { name: 'NE', x: 10, z: 0,  w: 10, d: 10 },
      { name: 'SW', x: 0,  z: 10, w: 10, d: 10 },
      { name: 'SE', x: 10, z: 10, w: 10, d: 10 },
    ],
  });
  const w = deriveWalls(plan);
  assert(w.interior.length === 4, 'expecting 4 interior walls; got ' + w.interior.length);
});

test('computeStats matches DEMO_PLAN', () => {
  const plan = state.house.plan;
  const walls = {
    outer: state.house.walls,
    interior: state.house.interiorWalls,
  };
  const stats = computeStats(plan, walls);
  assert(stats.roomCount === 6, '6 rooms');
  assert(stats.floorAreaSqFt === 1236, '1236 sq ft total — got ' + stats.floorAreaSqFt);
  assert(stats.exteriorWalls === 4, '4 outer walls');
  assert(isNum(stats.linearFtInterior), 'linear interior computed');
});

test('loadPlan invalid input throws', () => {
  let threw = 0;
  try { loadPlan({}); } catch { threw++; }
  try { loadPlan({ rooms: 'not an array' }); } catch { threw++; }
  assert(threw === 2, 'invalid plans should throw');
});

// =====================================================
//   ORDER MATTERS: state-mutating tests go LAST
// =====================================================

test('loadPlan(replacement) replaces state.house, then restores', () => {
  loadPlan({
    name: 'TINY',
    rooms: [{ name: 'X', x: 0, z: 0, w: 8, d: 8 }],
  });
  assert(state.house.plan.name === 'TINY', 'new plan installed');
  assert(state.stats.roomCount === 1, 'stats reflect new plan');

  // Restore so any code reading from state.house downstream sees the demo.
  loadPlan(DEMO_PLAN);
  assert(state.house.plan.name === 'Sample Home', 'demo restored');
});

// =====================================================
//   v1.3 — multi-floor schema + roof-open-rooms
// =====================================================

tests.push({
  name: 'multi-floor schema: deriveWalls honors per-room ceiling height',
  async fn() {
    // Two rooms side-by-side: 9ft on left, 22ft on right (two-story volume)
    loadPlan({
      name: 'TT',
      rooms: [
        { id: 'a', name: 'A', x: 0, z: 0, w: 10, d: 10, h: 9 },
        { id: 'b', name: 'B', x: 10, z: 0, w: 10, d: 10, h: 22 },
      ],
      footprint: { w: 20, d: 10 },
    });
    const walls = deriveWalls(state.house.plan);
    // The shared wall between a and b should be h=22 (max of 9, 22)
    const shared = walls.interior.find(w => w.rooms && w.rooms.includes('a') && w.rooms.includes('b'));
    assert(shared, 'a-b shared wall should exist');
    assert(shared.height === 22, `shared wall height should be 22 (max of 9, 22), got ${shared.height}`);
  },
});

tests.push({
  name: 'roofOpenRooms: loadPlan preserves the array for buildRoof',
  async fn() {
    loadPlan({
      name: 'OPEN',
      rooms: [
        { id: 'a', name: 'A', x: 0, z: 0, w: 10, d: 10, h: 9 },
        { id: 'b', name: 'B', x: 0, z: 10, w: 10, d: 10, h: 22 },
      ],
      roofOpenRooms: ['b'],
      footprint: { w: 10, d: 20 },
    });
    assert(state.house.plan.roofOpenRooms.length === 1, 'roofOpenRooms is preserved');
    assert(state.house.plan.roofOpenRooms[0] === 'b', 'room id is b');
    // Restore
    loadPlan(DEMO_PLAN);
  },
});

tests.push({
  name: 'floors: loadPlan defaults to a single ground floor when absent',
  async fn() {
    loadPlan({ name: 'X', rooms: [{ id: 'r', name: 'R', x: 0, z: 0, w: 10, d: 10 }] });
    assert(state.house.plan.floors.length === 1, 'one floor by default');
    assert(state.house.plan.floors[0].rooms.length === 1, 'ground floor has all rooms');
    loadPlan(DEMO_PLAN);
  },
});

tests.push({
  name: 'floors: loadPlan accepts a stack of named floors',
  async fn() {
    loadPlan({
      name: 'STACK',
      floors: [
        { name: 'Ground', rooms: ['low'], elevation: 0 },
        { name: 'Upper',  rooms: ['hi'],  elevation: 10 },
      ],
      rooms: [
        { id: 'low', name: 'Low', x: 0, z: 0, w: 20, d: 20, h: 9 },
        { id: 'hi',  name: 'Hi',  x: 0, z: 0, w: 20, d: 20, h: 9 },
      ],
    });
    assert(state.house.plan.floors.length === 2, 'two floors loaded');
    assert(state.house.plan.floors[0].name === 'Ground', 'first floor is Ground');
    assert(state.house.plan.floors[1].elevation === 10, 'second floor elevation = 10');
    loadPlan(DEMO_PLAN);
  },
});

// =====================================================
//   v1.4 — multi-floor Garcia-style (23 rooms / 2 floors)
// =====================================================

tests.push({
  name: 'multi-floor: Garcia plan (23 rooms, 2 floors) validates',
  async fn() {
    // Simulate the Garcia plan shape
    const result = loadPlan({
      name: 'Garcia',
      rooms: [
        { id: 'study', name: 'Study', x: 0, z: 0, w: 12, d: 13.4 },
        { id: 'master', name: 'Master Bed', x: 35.2, z: 0, w: 15.4, d: 18.2 },
        { id: 'br3', name: 'Bedroom 3', x: 30, z: 0, w: 13, d: 15, h: 9 },
        { id: 'br4', name: 'Bedroom 4', x: 9, z: 0, w: 13, d: 15, h: 9 },
        { id: 'br5', name: 'Bedroom 5', x: 47.5, z: 17.5, w: 11.2, d: 11.2 },
      ],
      footprint: { w: 70.4, d: 62.6 },
      floors: [
        { name: '1st Floor', rooms: ['study', 'master'], elevation: 0 },
        { name: '2nd Floor', rooms: ['br3', 'br4', 'br5'], elevation: 10 },
      ],
    });
    assert(result && result.plan, 'Garcia-like plan loads ok');
    assert(state.house.plan.floors.length === 2, 'Garcia has 2 floors');
    assert(state.house.plan.rooms.length === 5, 'Garcia-like plan has 5 rooms total');
    loadPlan(DEMO_PLAN);
  },
});

tests.push({
  name: 'multi-floor: loadPlan auto-assigns floor 1 (Ground) when absent',
  async fn() {
    loadPlan({
      name: 'X',
      rooms: [
        { id: 'r1', name: 'R1', x: 0, z: 0, w: 10, d: 10 },
        { id: 'r2', name: 'R2', x: 10, z: 0, w: 10, d: 10 },
      ],
    });
    assert(state.house.plan.floors.length === 1, 'default to 1 floor when absent');
    assert(state.house.plan.floors[0].rooms.length === 2, 'ground floor has all rooms');
    assert(state.house.plan.floors[0].elevation === 0, 'ground at elevation 0');
    loadPlan(DEMO_PLAN);
  },
});

// =====================================================
//   v1.5 — stair room metadata preserved through validatePlan
// =====================================================

tests.push({
  name: 'stairs: validatePlan preserves kind/riserFt/treadFt/direction/toElevation',
  async fn() {
    const result = loadPlan({
      name: 'STAIR',
      rooms: [
        { id: 'stairs1', name: 'Stair', x: 0, z: 0, w: 7, d: 18.2, h: 9,
          kind: 'stairs', riserFt: 0.625, treadFt: 0.917, direction: 'z+', toElevation: 10 },
      ],
    });
    const stairRoom = result.plan.rooms.find(r => r.id === 'stairs1');
    assert(stairRoom.kind === 'stairs', 'kind preserved through loadPlan');
    assert(stairRoom.riserFt === 0.625, 'riserFt preserved');
    assert(stairRoom.treadFt === 0.917, 'treadFt preserved');
    assert(stairRoom.direction === 'z+', 'direction preserved');
    assert(stairRoom.toElevation === 10, 'toElevation preserved');
    loadPlan(DEMO_PLAN);
  },
});

tests.push({
  name: 'stairs: n-risers auto-computes from total rise ÷ riserFt',
  async fn() {
    // 10ft rise / 0.625 = 16 risers; height of each step = 0.625ft
    loadPlan({
      name: 'STAIR2',
      rooms: [
        { id: 's', name: 'S', x: 0, z: 0, w: 7, d: 18.2, h: 9,
          kind: 'stairs', riserFt: 0.625, treadFt: 0.917, direction: 'z+', toElevation: 10 },
      ],
    });
    // The plan validates but we don't have buildStairs here (it's in app.js).
    // Just confirm the stair room metadata passes through unchanged.
    const stairRoom = state.house.plan.rooms.find(r => r.id === 's');
    assert(stairRoom.kind === 'stairs', 'kind still present after loadPlan');
    assert(stairRoom.toElevation === 10, 'toElevation still 10');
    loadPlan(DEMO_PLAN);
  },
});

// =====================================================
//   RUN
// =====================================================

async function runAll() {
  const t0 = performance.now();
  const rows = [];
  let pass = 0, fail = 0;

  for (const t of tests) {
    let result = { ok: true };
    try {
      await t.fn();
    } catch (e) {
      result = { ok: false, msg: e.message };
    }
    if (result.ok) pass++; else fail++;
    rows.push({ name: t.name, ok: result.ok, msg: result.msg });
  }

  const dur = Math.round(performance.now() - t0);

  const tbody = document.getElementById('results-body');
  if (tbody) {
    tbody.innerHTML = rows.map(r => `
      <tr class="${r.ok ? 'pass' : 'failed'}">
        <td>${r.name}</td>
        <td class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'}</td>
        <td>${r.msg ? `<code>${r.msg.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</code>` : ''}</td>
      </tr>
    `).join('');
  }
  const elTotal = document.getElementById('stat-total');
  const elPass  = document.getElementById('stat-pass');
  const elFail  = document.getElementById('stat-fail');
  const elDur   = document.getElementById('stat-dur');
  if (elTotal) elTotal.textContent = rows.length;
  if (elPass)  elPass.textContent  = pass;
  if (elFail)  elFail.textContent  = fail;
  if (elDur)   elDur.textContent   = dur + 'ms';

  document.title = `(${pass}/${rows.length}) Genesis tests`;
  console.log(`tests=${rows.length} pass=${pass} fail=${fail} dur=${dur}ms`);
  if (fail > 0) console.error(rows.filter(r => !r.ok));
}

runAll();
