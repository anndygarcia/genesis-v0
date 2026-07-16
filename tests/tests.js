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
