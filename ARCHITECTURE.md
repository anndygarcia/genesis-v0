# Genesis Architecture

> Read this before adding features. The codebase is structured around one
> principle: **data is the source of truth, geometry is derived from it.**

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
GENESIS.loadPlan(plan)        // validate, derive, install — throws on bad input
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

// Scene rebuild (v0.10+ — currently refreshes side-panel UI only)
GENESIS.rebuildSceneFromPlan(plan)

// Demo fixture
GENESIS.demoPlan()            // load the bundled Sample Home plan
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
| `buildSceneFrom(plan)` | **NEXT STEP — v0.10** | New Three.js meshes that replace the current scene |

## What is NOT in scope yet (the next round)

- `buildSceneFrom(plan)` — currently the **side-panel updates** when a new plan is loaded, but the **3D meshes don't get replaced**. Adding this is the obvious next foundation item. Cleanly bounded because the data layer above it is already done.
- Multi-floor (vertical Y extrusion).
- Material assignment beyond `color`/`accent` (PBR textures).
- Real blueprint parsing (PDF → plan via OCR/YOLO).

## Hard rules when adding features

1. **Read from state, mutate meshes.** No feature should ask "what is the room list?" — read it from `state.house.plan.rooms`.
2. **Don't add ad-hoc data.** If you need a new field, add it to the plan shape and the state. Don't keep a parallel array in app.js.
3. **Tests are the spec.** When you add a public behavior, add an assertion in `tests.js`. Run `tests.html` after every change.
4. **No secrets in code.** Pre-commit hook blocks `re_...`, `sk-...`, etc.
