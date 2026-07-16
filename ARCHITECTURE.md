# Genesis Architecture

> Read this before adding features. The codebase is structured around one
> principle: **data is the source of truth, geometry is derived from it.**

**Companion docs**
- **[ARCHITECTURE-pdf.md](ARCHITECTURE-pdf.md)** — how a real PDF
  blueprint becomes a `loadPlan(plan)`-able plan JSON. v1.x items.
- **[ARCHITECTURE-tests.md](ARCHITECTURE-tests.md)** *coming soon* —
  what `tests.html` covers, how to add tests, where it sits in CI.

```
            ┌──────────────────────────────────────┐
            │           PLAN (JSON)                │
            │  name, rooms[], doors[], windows[]   │
            └─────────────┬────────────────────────┘
                          │ validatePlan() — schema + default fill
                          ▼
            ┌──────────────────────────────────────┐
            │   CANONICAL PLAN                     │
            │   • rooms.{id,name,x,z,w,d,h,color}  │
            │   • doors.{id,x,z,w,axis,kind}       │
            │   • windows.{id,x,z,w,axis}          │
            │   • footprint.{w,d}                   │
            └─────────────┬────────────────────────┘
                          │ loadPlan() — installs into state
                          ▼
            ┌──────────────────────────────────────┐
            │   state.house                         │
            │   ├ plan                              │
            │   ├ walls[]          (4 outer)       │
            │   ├ interiorWalls[]  (8 interior)    │
            │   ├ wallsByRoom{}                     │
            │   └ openings.{doors[], windows[]}    │
            └─────────────┬────────────────────────┘
                          │ read from
                          ▼
            ┌──────────────────────────────────────┐
            │   Three.js scene                      │
            │   meshes, labels, walls, openings     │
            │   camera, lights, postprocessing     │
            └──────────────────────────────────────┘
```

## Files

| File | Purpose |
|---|---|
| `state.js` | **Pure data layer.** All plan validation + derivation. No Three.js. |
| `app.js` | **Three.js scene + UI.** Reads from `state.house`, mutates meshes. |
| `tests.html` + `tests.js` | Headless tests for the data layer. 13 assertions on the demo plan. |
| `functions/api/*` | Cloudflare Pages Functions: `waitlist`, `stats`, `visit`, `unsubscribe`. |
| `assets/sample-plan.json` | A 5-room starter template users can drop into the viewer. |

## Public API surface (`window.GENESIS`)

```js
// State bridge
GENESIS.state                 // the state module's state object
GENESIS.loadPlan(plan)        // validate, derive, install, rebuild scene + UI — throws on bad input
GENESIS.describe()            // human-readable summary of current house
GENESIS.getRoom(id)           // → room object or null
GENESIS.getWall(id)           // → wall object or null
GENESIS.getOpening(id)        // → door or window object or null

// Scene handles (devtools / 3rd-party scripts)
GENESIS.scene, camera, orbit
GENESIS.ROOMS, DOORS, WINDOWS, STATS  // live references to state

// Toggles
GENESIS.composer, ssaoPass, outlinePass
GENESIS.togglePost()          // toggle SSAO + outline on/off

// Scene rebuild — done by loadPlan(); these still exposed as escape hatches
GENESIS.rebuildSceneFromPlan(plan)  // refresh side panel + stats card
GENESIS.demoPlan()            // reload the bundled Sample Home plan
```

## Plan shape

```jsonc
{
  "name": "Sample Home",           // shown in panel titles
  "planNumber": 1,                  // shown as "Plan #1"

  "rooms": [
    {
      "id":       "living",         // stable, unique
      "name":     "Living Room",    // human-readable
      "x":          0,              // SW corner (feet)
      "z":          0,
      "w":         20,              // width east
      "d":         18,              // depth north
      "h":          9,              // wall height; defaults to 9
      "color":   "#fff3e6",         // floor tint hex
      "accent":  "#d97706"          // label tint hex
    }
  ],

  "doors": [
    {
      "id":     "front-entry",       // stable, unique
      "x":        6,                 // placement (feet, on the wall axis)
      "z":        0,
      "w":        3,                 // door width
      "axis":   "z",                 // wall it's on (x = west/east, z = north/south)
      "kind":   "exterior",          // exterior | interior
      "label":  "Front Entry",       // shown in measurement tooltips
      "host":   "living",            // optional: room it serves
      "flip":   false                // hinge direction
    }
  ],

  "windows": [
    {
      "id":    "living-win-1",
      "x":       4,
      "z":      30,
      "w":       4,
      "axis":  "z",
      "label": "Living Window",
      "host":  "living"
    }
  ]
}
```

## States of the pipeline

| Stage | What it requires | What it produces |
|---|---|---|
| `validatePlan(raw)` | A JSON-ish object | Canonical plan with defaults filled + `footprint` derived |
| `loadPlan(rawPlan)` | A plan (or raw input — auto-validates) | Installs `state.house` + recomputes `state.stats` |
| `deriveWalls(plan)` | A validated plan | `{ outer[], interior[], wallsByRoom, openings }` |
| `computeStats(plan, walls)` | Both above | `{ roomCount, floorAreaSqFt, walls..., openings, linearFt* }` |
| `buildHouse(plan)` | Both above | Three.js group (slab, floors, walls, doors, windows, foundation, labels) installed inside `houseGroup`; old geometry disposed |
| `disposeHouse()` | (none) | Recursively disposes the previous `houseGroup` children + clears `INTERACTABLE`/`WALL_MESHES` registries |

## What is NOT in scope yet (the next round)

| Item | Status | Notes |
|---|---|---|
| `buildHouse(plan)` full visual fidelity | **DONE (v1.1) structure; PARTIAL visuals.** Slab, floors, walls, openings are built from the plan. **Stub**: doors/windows are simple plane proxies, no roof gables, no baseboards/crown, no per-room furniture yet. v0.11 work. |
| Real-plan ingestion (PDF/DWG → plan) | NEXT. OCR + YOLO11 + SAM + RoomFormer. With `state.js` + `buildHouse(plan)` in place, this is a single parse function feeding `loadPlan()`. |
| Multi-floor (vertical extrusion) | Future. `plan` already has `h: number` per room; v0.11+ adds a `floors[]` array. |
| Material library beyond `color`/`accent` | Future. Current floors + walls share one PBR material family. Each room has a `materials: { wall, floor, ceiling }` slot ready. |

## Hard rules when adding features

1. **Read from state, mutate meshes.** No feature should ask "what is the room list?" — read it from `state.house.plan.rooms`.
2. **Don't add ad-hoc data.** If you need a new field, add it to the plan shape and the state. Don't keep a parallel array in app.js.
3. **Tests are the spec.** When you add a public behavior, add an assertion in `tests.js`. Run `tests.html` after every change.
4. **No secrets in code.** Pre-commit hook blocks `re_...`, `sk-...`, etc.
