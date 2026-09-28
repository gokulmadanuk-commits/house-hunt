import assert from "node:assert/strict";
import { test } from "node:test";
import { costLines, DEFAULT_RATES } from "../src/lib/costs.ts";
import { applyWallInstructions, deriveWalls, layoutStats, pruneLayout, tidyLayout } from "../src/lib/layout.ts";
import { sampleBaseLayout, sampleExtendedLayout } from "../src/lib/sample.ts";
import type { Layout } from "../src/lib/types.ts";

const pair = (a?: string, b?: string) => [a, b].sort().join("|");

test("interior walls separate exactly the rooms that touch", () => {
  const l = sampleBaseLayout();
  const walls = deriveWalls(l.floors[0], l);
  const between = walls.filter((s) => pair(s.sideA, s.sideB) === pair("dining", "kitchen"));
  assert.equal(between.length, 1);
  assert.equal(between[0].length, 3);
  assert.equal(between[0].exterior, false);
});

test("connections become doors and the front door lands on the street side", () => {
  const l = sampleBaseLayout();
  const walls = deriveWalls(l.floors[0], l);
  const front = walls.find((s) => s.exterior && (s.sideA === "hall" || s.sideB === "hall") && s.state === "door");
  assert.ok(front, "hall should have an external door");
  assert.equal(front.planSide, "top");
  assert.equal(walls.find((s) => pair(s.sideA, s.sideB) === pair("hall", "living"))?.state, "door");
});

test("party walls never get windows", () => {
  const l = sampleBaseLayout();
  for (const f of l.floors) {
    for (const s of deriveWalls(f, l).filter((w) => w.party)) assert.equal(s.state, "solid");
  }
  const detached: Layout = { ...l, attached: [] };
  const sideWindows = deriveWalls(detached.floors[0], detached).filter((s) => s.planSide === "left" && s.state === "window");
  assert.ok(sideWindows.length > 0, "detached houses get side windows");
});

test("extension scenario opens up the back and adds area", () => {
  const base = sampleBaseLayout();
  const ext = sampleExtendedLayout(base);
  const s0 = layoutStats(base), s1 = layoutStats(ext);
  assert.equal(s1.newArea, 17.5);
  assert.equal(s1.totalArea - s0.totalArea, 17.5);
  assert.equal(s1.openedWalls, 2);
  const lines = costLines(base, ext, DEFAULT_RATES);
  assert.ok(lines.find((l) => l.key === "extensionPerM2" && l.qty === 17.5));
  assert.ok(lines.find((l) => l.key === "structuralOpening" && l.qty === 2));
});

test("tidy snaps near-miss edges so rooms share walls", () => {
  const l: Layout = {
    ceilingHeight: 2.4,
    wallStates: {},
    connections: [],
    floors: [
      {
        id: "g",
        name: "G",
        level: 0,
        rooms: [
          { id: "a", name: "A", type: "living", x: 0.3, y: 0.2, w: 4.0, d: 3.0 },
          { id: "b", name: "B", type: "kitchen", x: 4.42, y: 0.25, w: 3.0, d: 2.9 },
        ],
      },
    ],
  };
  const t = tidyLayout(l);
  const [a, b] = t.floors[0].rooms;
  assert.equal(a.x, 0);
  assert.ok(Math.abs(a.x + a.w - b.x) < 1e-9, "a's right edge meets b's left edge");
  const shared = deriveWalls(t.floors[0], t).filter((s) => !s.exterior);
  assert.equal(shared.length, 1);
});

test("wall instructions translate room pairs into wall states", () => {
  const base = sampleBaseLayout();
  const out = applyWallInstructions(base, [
    { floorId: "gf", roomA: "living", roomB: "dining", state: "open" },
    { floorId: "gf", roomA: "kitchen", roomB: "outside", side: "bottom", state: "glazed" },
  ]);
  const walls = deriveWalls(out.floors[0], out);
  assert.equal(walls.find((s) => pair(s.sideA, s.sideB) === pair("living", "dining"))?.state, "open");
  assert.equal(walls.find((s) => s.exterior && s.sideA === "kitchen" && s.planSide === "bottom")?.state, "glazed");
});

test("prune drops states for walls that no longer exist", () => {
  const base = sampleBaseLayout();
  const withState: Layout = { ...base, wallStates: { "gf:h:99.00:0.00-1.00": "open" } };
  assert.deepEqual(pruneLayout(withState).wallStates, {});
});
