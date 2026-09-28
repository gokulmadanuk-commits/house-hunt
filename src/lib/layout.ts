// Plan geometry: derives walls from room rectangles, picks sensible default
// doors/windows, and computes area stats. Shared by the 2D editor, the 3D
// viewer and the server (AI output is normalised through here).

import type { Connection, Floor, Layout, PlanSide, Room, RoomType, WallState } from "./types";

export const GRID = 0.05;
export const snap = (v: number) => Math.round(Math.round(v / GRID) * GRID * 100) / 100;
const r2 = (v: number) => Math.round(v * 100) / 100;
const fmt = (v: number) => snap(v).toFixed(2);

export function newId(prefix = "") {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
    : Math.random().toString(36).slice(2, 12);
  return prefix + rand;
}

export interface WallSegment {
  key: string;
  floorId: string;
  orient: "h" | "v";
  /** Fixed coordinate (y for horizontal, x for vertical). */
  c: number;
  start: number;
  end: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
  /** Room on the negative side (above for h, left for v). */
  sideA?: string;
  /** Room on the positive side (below for h, right for v). */
  sideB?: string;
  exterior: boolean;
  /** Exterior wall shared with a neighbouring building. */
  party: boolean;
  /** Which side of the plan's bounding box this exterior wall sits on, if any. */
  planSide?: PlanSide;
  state: WallState;
  defaultState: WallState;
}

export function wallKey(floorId: string, orient: "h" | "v", c: number, start: number, end: number) {
  return `${floorId}:${orient}:${fmt(c)}:${fmt(start)}-${fmt(end)}`;
}

type RawSeg = Omit<WallSegment, "state" | "defaultState" | "party" | "planSide">;
type Seg = Omit<WallSegment, "state" | "defaultState">;

interface Edge {
  c: number;
  start: number;
  end: number;
  roomId: string;
  side: "a" | "b";
}

function segmentsForAxis(floorId: string, orient: "h" | "v", edges: Edge[]) {
  const byLine = new Map<string, Edge[]>();
  for (const e of edges) {
    const k = fmt(e.c);
    const list = byLine.get(k) ?? [];
    list.push(e);
    byLine.set(k, list);
  }
  const out: RawSeg[] = [];
  for (const [ck, list] of byLine) {
    const c = Number(ck);
    const pts = [...new Set(list.flatMap((e) => [fmt(e.start), fmt(e.end)]))].map(Number).sort((a, b) => a - b);
    let cur: { start: number; end: number; a?: string; b?: string } | null = null;
    const flush = () => {
      if (cur && cur.end - cur.start > 0.01) {
        const { start, end, a, b } = cur;
        out.push({
          key: wallKey(floorId, orient, c, start, end),
          floorId,
          orient,
          c,
          start,
          end,
          x1: orient === "h" ? start : c,
          y1: orient === "h" ? c : start,
          x2: orient === "h" ? end : c,
          y2: orient === "h" ? c : end,
          length: r2(end - start),
          sideA: a,
          sideB: b,
          exterior: !(a && b),
        });
      }
      cur = null;
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const s = pts[i];
      const e = pts[i + 1];
      const mid = (s + e) / 2;
      const covering = list.filter((ed) => ed.start - 0.001 <= mid && ed.end + 0.001 >= mid);
      if (!covering.length) {
        flush();
        continue;
      }
      const a = covering.find((ed) => ed.side === "a")?.roomId;
      const b = covering.find((ed) => ed.side === "b")?.roomId;
      if (cur && cur.a === a && cur.b === b && Math.abs(cur.end - s) < 0.001) {
        cur.end = e;
      } else {
        flush();
        cur = { start: s, end: e, a, b };
      }
    }
    flush();
  }
  return out;
}

const WINDOWLESS: RoomType[] = ["hall", "landing", "storage", "garage"];
const CIRCULATION: RoomType[] = ["hall", "landing"];

/** Picks door/window defaults when the user hasn't set a wall explicitly. */
function defaultStates(floor: Floor, segs: Seg[], connections: Connection[]): Map<string, WallState> {
  const rooms = new Map(floor.rooms.map((r) => [r.id, r]));
  const result = new Map<string, WallState>();
  const pairKey = (a: string, b: string) => [a, b].sort().join("|");

  // Interior segments grouped by the pair of rooms they separate.
  const byPair = new Map<string, typeof segs>();
  for (const s of segs) {
    if (s.exterior || !s.sideA || !s.sideB) continue;
    const k = pairKey(s.sideA, s.sideB);
    const list = byPair.get(k) ?? [];
    list.push(s);
    byPair.set(k, list);
  }
  const longest = <T extends { length: number }>(xs: T[]) => xs.reduce((m, s) => (s.length > m.length ? s : m), xs[0]);

  const floorConns = connections.filter((c) => rooms.has(c.a) && (c.b === "outside" || rooms.has(c.b)));
  const interiorConns = floorConns.filter((c) => c.b !== "outside");

  const wanted = new Map<string, "door" | "open">();
  if (interiorConns.length) {
    for (const c of interiorConns) wanted.set(pairKey(c.a, c.b), c.kind);
  } else {
    // Heuristic: every room gets a door to a neighbouring hall/landing, else to its best-connected neighbour.
    const neighbours = (id: string) =>
      [...byPair.entries()]
        .filter(([k]) => k.split("|").includes(id))
        .map(([k, list]) => ({ other: k.split("|").find((x) => x !== id)!, len: longest(list).length, key: k }))
        .filter((n) => n.len >= 0.7);
    for (const room of floor.rooms) {
      const ns = neighbours(room.id);
      if (!ns.length) continue;
      if (CIRCULATION.includes(room.type)) {
        for (const n of ns) if (CIRCULATION.includes(rooms.get(n.other)!.type)) wanted.set(n.key, "open");
        continue;
      }
      const circ = ns.filter((n) => CIRCULATION.includes(rooms.get(n.other)!.type));
      const prefer = room.type === "ensuite" ? ns.filter((n) => rooms.get(n.other)!.type === "bedroom") : circ;
      const pool = prefer.length ? prefer : ns;
      const already = ns.some((n) => wanted.has(n.key));
      if (!already || prefer.length) wanted.set(longest(pool.map((n) => ({ ...n, length: n.len }))).key, "door");
    }
  }
  for (const [k, kind] of wanted) {
    const list = byPair.get(k);
    if (list?.length) result.set(longest(list).key, kind === "open" ? "open" : "door");
  }

  // Exterior: entrance door + windows.
  const exteriorByRoom = new Map<string, typeof segs>();
  for (const s of segs) {
    if (!s.exterior) continue;
    const rid = s.sideA ?? s.sideB!;
    const list = exteriorByRoom.get(rid) ?? [];
    list.push(s);
    exteriorByRoom.set(rid, list);
  }
  let entrances = floorConns.filter((c) => c.b === "outside").map((c) => c.a);
  if (!entrances.length && floor.level === 0) {
    const hall = floor.rooms.find((r) => r.type === "hall" && exteriorByRoom.has(r.id));
    if (hall) entrances = [hall.id];
  }
  for (const rid of entrances) {
    const side = floorConns.find((c) => c.a === rid && c.b === "outside")?.side;
    const list = (exteriorByRoom.get(rid) ?? []).filter((s) => !s.party && s.length >= 0.8);
    const onSide = side ? list.filter((s) => segSideOfRoom(s, rooms.get(rid)!) === side) : [];
    const pool = onSide.length ? onSide : list;
    // Front doors usually sit in the shortest usable run of external wall (e.g. the end of a hall).
    if (pool.length) result.set(pool.reduce((m, s) => (s.length < m.length ? s : m), pool[0]).key, "door");
  }
  for (const s of segs) {
    if (!s.exterior || s.party || result.has(s.key)) continue;
    const room = rooms.get(s.sideA ?? s.sideB!);
    if (!room || WINDOWLESS.includes(room.type) || s.length < 0.9) continue;
    result.set(s.key, room.type === "conservatory" ? "glazed" : "window");
  }
  return result;
}

export function layoutBounds(layout: Pick<Layout, "floors">) {
  const all = layout.floors.flatMap((f) => f.rooms);
  if (!all.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: snap(Math.min(...all.map((r) => r.x))),
    minY: snap(Math.min(...all.map((r) => r.y))),
    maxX: snap(Math.max(...all.map((r) => r.x + r.w))),
    maxY: snap(Math.max(...all.map((r) => r.y + r.d))),
  };
}

export function deriveWalls(
  floor: Floor,
  layout: Pick<Layout, "wallStates" | "connections" | "attached" | "floors">,
): WallSegment[] {
  const h: Edge[] = [];
  const v: Edge[] = [];
  for (const r of floor.rooms) {
    const x1 = snap(r.x), y1 = snap(r.y), x2 = snap(r.x + r.w), y2 = snap(r.y + r.d);
    h.push({ c: y1, start: x1, end: x2, roomId: r.id, side: "b" });
    h.push({ c: y2, start: x1, end: x2, roomId: r.id, side: "a" });
    v.push({ c: x1, start: y1, end: y2, roomId: r.id, side: "b" });
    v.push({ c: x2, start: y1, end: y2, roomId: r.id, side: "a" });
  }
  const b = layoutBounds(layout);
  const attached = new Set(layout.attached ?? []);
  const eq = (p: number, q: number) => Math.abs(p - q) < 0.01;
  const segs: Seg[] = [...segmentsForAxis(floor.id, "h", h), ...segmentsForAxis(floor.id, "v", v)].map((s) => {
    let planSide: PlanSide | undefined;
    if (s.exterior) {
      if (s.orient === "h" && eq(s.c, b.minY)) planSide = "top";
      else if (s.orient === "h" && eq(s.c, b.maxY)) planSide = "bottom";
      else if (s.orient === "v" && eq(s.c, b.minX)) planSide = "left";
      else if (s.orient === "v" && eq(s.c, b.maxX)) planSide = "right";
    }
    return { ...s, planSide, party: !!planSide && attached.has(planSide) };
  });
  const defaults = defaultStates(floor, segs, layout.connections ?? []);
  return segs.map((s) => {
    const defaultState = defaults.get(s.key) ?? "solid";
    let state = layout.wallStates?.[s.key] ?? defaultState;
    if (s.exterior && state === "open") state = "solid"; // can't remove an external wall into nothing
    if (s.party) state = "solid";
    return { ...s, defaultState, state };
  });
}

/** Which edge of `room` a wall segment lies on (if any). */
export function segSideOfRoom(s: Pick<WallSegment, "orient" | "c">, room: Room): PlanSide | undefined {
  const eq = (p: number, q: number) => Math.abs(p - snap(q)) < 0.01;
  if (s.orient === "h") return eq(s.c, room.y) ? "top" : eq(s.c, room.y + room.d) ? "bottom" : undefined;
  return eq(s.c, room.x) ? "left" : eq(s.c, room.x + room.w) ? "right" : undefined;
}

export interface WallInstruction {
  floorId: string;
  roomA: string;
  /** Another room id, or "outside". */
  roomB: string;
  /** For outside walls: which edge of roomA. */
  side?: PlanSide | null;
  state: WallState;
}

/**
 * Applies room-pair wall instructions (the form the AI works in) to a layout,
 * translating them into connections and per-segment wall states.
 */
export function applyWallInstructions(layout: Layout, instructions: WallInstruction[]): Layout {
  const out = cloneLayout(layout);
  const pairKey = (a: string, b: string) => [a, b].sort().join("|");
  for (const ins of instructions) {
    const floor = out.floors.find((f) => f.id === ins.floorId);
    if (!floor) continue;
    const roomA = floor.rooms.find((r) => r.id === ins.roomA);
    if (!roomA) continue;
    if (ins.roomB === "outside") {
      let segs = deriveWalls(floor, out).filter((s) => s.exterior && (s.sideA === roomA.id || s.sideB === roomA.id) && !s.party);
      if (ins.side) segs = segs.filter((s) => segSideOfRoom(s, roomA) === ins.side);
      if (!segs.length) continue;
      const targets = ins.state === "door" ? [segs.reduce((m, s) => (s.length > m.length ? s : m), segs[0])] : segs;
      for (const s of targets) out.wallStates[s.key] = ins.state === "open" ? "glazed" : ins.state;
      continue;
    }
    if (!floor.rooms.some((r) => r.id === ins.roomB)) continue;
    const k = pairKey(ins.roomA, ins.roomB);
    out.connections = out.connections.filter((c) => pairKey(c.a, c.b) !== k);
    const shared = deriveWalls(floor, out).filter((s) => !s.exterior && pairKey(s.sideA!, s.sideB!) === k);
    for (const s of shared) delete out.wallStates[s.key];
    if (ins.state === "door") out.connections.push({ a: ins.roomA, b: ins.roomB, kind: "door" });
    else if (ins.state === "open") {
      out.connections.push({ a: ins.roomA, b: ins.roomB, kind: "open" });
      for (const s of shared) out.wallStates[s.key] = "open";
    } else {
      for (const s of shared) out.wallStates[s.key] = ins.state;
      if (ins.state === "glazed") out.connections.push({ a: ins.roomA, b: ins.roomB, kind: "door" });
    }
  }
  return out;
}

/** Drops wall states / connections that no longer match the current geometry. */
export function pruneLayout(layout: Layout): Layout {
  const out = cloneLayout(layout);
  const keys = new Set(out.floors.flatMap((f) => deriveWalls(f, { ...out, wallStates: {} }).map((s) => s.key)));
  for (const k of Object.keys(out.wallStates)) if (!keys.has(k)) delete out.wallStates[k];
  const ids = new Set(out.floors.flatMap((f) => f.rooms.map((r) => r.id)));
  out.connections = out.connections.filter((c) => ids.has(c.a) && (c.b === "outside" || ids.has(c.b)));
  return out;
}

export function roomArea(r: Room) {
  return r.w * r.d;
}

export interface LayoutStats {
  totalArea: number;
  newArea: number;
  bedrooms: number;
  bathrooms: number;
  rooms: number;
  openedWalls: number;
  floors: { id: string; name: string; area: number }[];
}

export function layoutStats(layout: Layout): LayoutStats {
  let totalArea = 0, newArea = 0, bedrooms = 0, bathrooms = 0, rooms = 0, openedWalls = 0;
  const floors = layout.floors.map((f) => {
    const area = f.rooms.reduce((s, r) => s + roomArea(r), 0);
    totalArea += area;
    for (const r of f.rooms) {
      rooms++;
      if (r.isNew) newArea += roomArea(r);
      if (r.type === "bedroom") bedrooms++;
      if (r.type === "bathroom" || r.type === "ensuite") bathrooms++;
    }
    openedWalls += deriveWalls(f, layout).filter((s) => !s.exterior && s.state === "open").length;
    return { id: f.id, name: f.name, area: r2(area) };
  });
  return { totalArea: r2(totalArea), newArea: r2(newArea), bedrooms, bathrooms, rooms, openedWalls, floors };
}

export function emptyLayout(): Layout {
  return {
    floors: [{ id: newId("f"), name: "Ground floor", level: 0, rooms: [] }],
    wallStates: {},
    connections: [],
    attached: [],
    ceilingHeight: 2.4,
  };
}

export function cloneLayout(l: Layout): Layout {
  return JSON.parse(JSON.stringify(l));
}

/** Snap nearly-aligned room edges together so walls line up (AI traces are rarely exact). */
export function tidyLayout(layout: Layout, tolerance = 0.2): Layout {
  const out = cloneLayout(layout);
  const cluster = (vals: number[]) => {
    const sorted = [...vals].sort((a, b) => a - b);
    const map = new Map<number, number>();
    let group: number[] = [];
    const close = () => {
      if (!group.length) return;
      const mean = snap(group.reduce((s, x) => s + x, 0) / group.length);
      for (const g of group) map.set(g, mean);
      group = [];
    };
    for (const v of sorted) {
      if (group.length && v - group[group.length - 1] > tolerance) close();
      group.push(v);
    }
    close();
    return map;
  };
  for (const f of out.floors) {
    const xs = cluster(f.rooms.flatMap((r) => [r.x, r.x + r.w]));
    const ys = cluster(f.rooms.flatMap((r) => [r.y, r.y + r.d]));
    for (const r of f.rooms) {
      const x1 = xs.get(r.x)!, x2 = xs.get(r.x + r.w)!, y1 = ys.get(r.y)!, y2 = ys.get(r.y + r.d)!;
      if (x2 - x1 >= 0.5) { r.x = x1; r.w = r2(x2 - x1); }
      if (y2 - y1 >= 0.5) { r.y = y1; r.d = r2(y2 - y1); }
    }
  }
  // Shift so the plan starts at the origin (keeping floors aligned with each other).
  const all = out.floors.flatMap((f) => f.rooms);
  if (all.length) {
    const minX = Math.min(...all.map((r) => r.x));
    const minY = Math.min(...all.map((r) => r.y));
    for (const r of all) { r.x = snap(r.x - minX); r.y = snap(r.y - minY); }
  }
  return out;
}

export function floorBounds(floor: Floor) {
  if (!floor.rooms.length) return { minX: 0, minY: 0, maxX: 10, maxY: 8 };
  return {
    minX: Math.min(...floor.rooms.map((r) => r.x)),
    minY: Math.min(...floor.rooms.map((r) => r.y)),
    maxX: Math.max(...floor.rooms.map((r) => r.x + r.w)),
    maxY: Math.max(...floor.rooms.map((r) => r.y + r.d)),
  };
}

export const ROOM_LABEL: Record<RoomType, string> = {
  living: "Living",
  kitchen: "Kitchen",
  dining: "Dining",
  kitchen_dining: "Kitchen / dining",
  bedroom: "Bedroom",
  bathroom: "Bathroom",
  ensuite: "En-suite",
  wc: "WC",
  hall: "Hall",
  landing: "Landing",
  utility: "Utility",
  study: "Study",
  garage: "Garage",
  conservatory: "Conservatory",
  storage: "Store",
  other: "Other",
};

/** Plan colours per room type (2D) — muted, drawn from the app palette. */
export const ROOM_TINT: Record<RoomType, string> = {
  living: "#E9D8BF",
  kitchen: "#D8E3D2",
  dining: "#E6DCC9",
  kitchen_dining: "#D8E3D2",
  bedroom: "#DCE3EC",
  bathroom: "#D4E4E6",
  ensuite: "#D4E4E6",
  wc: "#D4E4E6",
  hall: "#EEE8DC",
  landing: "#EEE8DC",
  utility: "#E3E1D6",
  study: "#E8DFD2",
  garage: "#DDDBD5",
  conservatory: "#E1EAD9",
  storage: "#E7E3DA",
  other: "#E7E3DA",
};
