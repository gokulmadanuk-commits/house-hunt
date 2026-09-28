"use client";
// 3D view of one floor: a cut-away "dollhouse" (orbit) and a first-person
// walkthrough. Geometry is generated from the same derived walls as the plan.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { deriveWalls, floorBounds, segSideOfRoom, type WallSegment } from "@/lib/layout";
import type { FloorFinish, Layout, PlanSide, Room, RoomType } from "@/lib/types";

export interface ViewerApi {
  snapshot: () => string;
  goToRoom: (roomId: string) => void;
}

interface Props {
  layout: Layout;
  floorId: string;
  mode: "orbit" | "walk";
  furniture?: boolean;
  onApi?: (api: ViewerApi | null) => void;
  className?: string;
}

const DEFAULT_WALL = "#eee8dd";
const EXTERIOR = "#cdbfaa";
const CUT_TOP = "#2b2f36";
const EYE = 1.6;
const RADIUS = 0.25;

const DEFAULT_FLOOR: Record<RoomType, FloorFinish> = {
  living: "oak", dining: "oak", kitchen: "tile", kitchen_dining: "tile", bedroom: "carpet", bathroom: "tile", ensuite: "tile", wc: "tile",
  hall: "oak", landing: "carpet", utility: "tile", study: "oak", garage: "concrete", conservatory: "stone", storage: "vinyl", other: "vinyl",
};

// ─── Procedural textures ──────────────────────────────────────────────────

const textureCache = new Map<FloorFinish, { tex: THREE.Texture; size: number }>();

function makeTexture(finish: FloorFinish) {
  const cached = textureCache.get(finish);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const planks = (base: [number, number, number], vary: number) => {
    const h = 32;
    for (let y = 0; y < 256; y += h) {
      let x = -Math.floor(rnd() * 200);
      while (x < 256) {
        const len = 140 + rnd() * 140;
        const k = 1 + (rnd() - 0.5) * vary;
        g.fillStyle = `rgb(${base[0] * k},${base[1] * k},${base[2] * k})`;
        g.fillRect(x, y, len, h);
        g.strokeStyle = "rgba(0,0,0,0.18)";
        g.lineWidth = 1.5;
        g.strokeRect(x + 0.5, y + 0.5, len, h);
        for (let i = 0; i < 5; i++) {
          g.strokeStyle = `rgba(0,0,0,${0.03 + rnd() * 0.04})`;
          g.beginPath();
          const yy = y + 4 + rnd() * (h - 8);
          g.moveTo(x, yy);
          g.bezierCurveTo(x + len / 3, yy + (rnd() - 0.5) * 6, x + (2 * len) / 3, yy + (rnd() - 0.5) * 6, x + len, yy);
          g.stroke();
        }
        x += len;
      }
    }
  };
  const tiles = (base: string, grout: string, n: number, vary: number) => {
    const s = 256 / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        g.fillStyle = base;
        g.fillRect(i * s, j * s, s, s);
        g.fillStyle = `rgba(${rnd() > 0.5 ? "255,255,255" : "0,0,0"},${rnd() * vary})`;
        g.fillRect(i * s, j * s, s, s);
      }
    g.strokeStyle = grout;
    g.lineWidth = 3;
    for (let i = 0; i <= n; i++) {
      g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, 256); g.stroke();
      g.beginPath(); g.moveTo(0, i * s); g.lineTo(256, i * s); g.stroke();
    }
  };
  const noise = (base: string, amount: number, dots = 9000) => {
    g.fillStyle = base;
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < dots; i++) {
      g.fillStyle = `rgba(${rnd() > 0.5 ? "255,255,255" : "0,0,0"},${rnd() * amount})`;
      g.fillRect(rnd() * 256, rnd() * 256, 1.5, 1.5);
    }
  };
  let size = 1.2;
  switch (finish) {
    case "oak": planks([196, 154, 108], 0.16); size = 1.6; break;
    case "walnut": planks([112, 76, 52], 0.2); size = 1.6; break;
    case "vinyl": planks([214, 206, 192], 0.06); size = 1.8; break;
    case "tile": tiles("#e7e2d8", "#cbc3b4", 4, 0.05); size = 1.2; break;
    case "stone": tiles("#bdb5a6", "#a39b8c", 2, 0.1); size = 1.2; break;
    case "carpet": noise("#cfc5b5", 0.08, 14000); size = 1; break;
    case "concrete": noise("#bab7b0", 0.06); size = 2.5; break;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const entry = { tex, size };
  textureCache.set(finish, entry);
  return entry;
}

// ─── Scene building ───────────────────────────────────────────────────────

interface Collider { x1: number; z1: number; x2: number; z2: number }

interface Built {
  group: THREE.Group;
  walls: WallSegment[];
  colliders: Collider[];
  labels: CSS2DObject[];
  rooms: Room[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

function build(layout: Layout, floorId: string, furniture: boolean, walk: boolean): Built {
  const floor = layout.floors.find((f) => f.id === floorId) ?? layout.floors[0];
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const labels: CSS2DObject[] = [];
  const H = layout.ceilingHeight || 2.4;
  const rooms = floor?.rooms ?? [];
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const walls = floor ? deriveWalls(floor, layout) : [];
  const mats = new Map<string, THREE.Material>();
  const mat = (color: string, opts: THREE.MeshStandardMaterialParameters = {}) => {
    const k = color + JSON.stringify(opts);
    if (!mats.has(k)) mats.set(k, new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...opts }));
    return mats.get(k)!;
  };
  const wallColour = (roomId?: string) => (roomId ? byId.get(roomId)?.finish?.wall || DEFAULT_WALL : EXTERIOR);

  // Ground
  const b = floor ? floorBounds(floor) : { minX: 0, minY: 0, maxX: 10, maxY: 8 };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), mat("#cdd5bf", { roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((b.minX + b.maxX) / 2, -0.02, (b.minY + b.maxY) / 2);
  ground.receiveShadow = true;
  group.add(ground);

  // Floors and ceilings
  for (const r of rooms) {
    const finish = r.finish?.floor ?? DEFAULT_FLOOR[r.type];
    const { tex, size } = makeTexture(finish);
    const t = tex.clone();
    t.needsUpdate = true;
    t.repeat.set(r.w / size, r.d / size);
    const m = new THREE.MeshStandardMaterial({ map: t, roughness: finish === "tile" || finish === "stone" ? 0.55 : 0.85 });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.d), m);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(r.x + r.w / 2, 0.001, r.y + r.d / 2);
    plane.receiveShadow = true;
    group.add(plane);
    if (walk) {
      const ceil = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.d), mat("#f7f5f0"));
      ceil.rotation.x = Math.PI / 2;
      ceil.position.set(r.x + r.w / 2, H, r.y + r.d / 2);
      group.add(ceil);
    }
    const el = document.createElement("div");
    el.className = "pointer-events-none rounded-full border border-[#ddd3c2] bg-[#fbf8f2]/90 px-2 py-0.5 text-[11px] font-semibold text-[#1d2733] shadow-sm whitespace-nowrap";
    el.textContent = r.name;
    const label = new CSS2DObject(el);
    label.position.set(r.x + r.w / 2, H + 0.3, r.y + r.d / 2);
    labels.push(label);
  }

  // Walls with openings
  const piece = (s: WallSegment, from: number, to: number, y0: number, y1: number, t: number, material?: THREE.Material | THREE.Material[], collide = true) => {
    const len = to - from;
    if (len <= 0.005 || y1 - y0 <= 0.005) return;
    const geo = new THREE.BoxGeometry(s.orient === "h" ? len : t, y1 - y0, s.orient === "h" ? t : len);
    const materials = material ?? faceMaterials(s);
    const mesh = new THREE.Mesh(geo, materials);
    const mid = from + len / 2;
    mesh.position.set(s.orient === "h" ? mid : s.c, (y0 + y1) / 2, s.orient === "h" ? s.c : mid);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (collide && y0 < 1.2) {
      colliders.push(s.orient === "h" ? { x1: from, z1: s.c, x2: to, z2: s.c } : { x1: s.c, z1: from, x2: s.c, z2: to });
    }
  };
  // Box faces: +x, -x, +y, -y, +z, -z. Side A is -z (h) / -x (v).
  const faceMaterials = (s: WallSegment) => {
    const a = mat(wallColour(s.sideA)), bb = mat(wallColour(s.sideB)), top = mat(CUT_TOP), end = mat(DEFAULT_WALL);
    return s.orient === "h" ? [end, end, top, end, bb, a] : [bb, a, top, end, end, end];
  };
  const glass = new THREE.MeshStandardMaterial({ color: "#b9d3e3", transparent: true, opacity: 0.28, roughness: 0.05, metalness: 0.1, depthWrite: false });
  const frame = mat("#3a3f47", { roughness: 0.6 });

  for (const s of walls) {
    const t = s.exterior ? 0.25 : 0.1;
    const ext = s.exterior ? 0.125 : 0.05;
    const start = s.start - ext, end = s.end + ext;
    const at = (u: number) => s.start + u;
    switch (s.state) {
      case "solid":
        piece(s, start, end, 0, H, t);
        break;
      case "open":
        if (!s.exterior) piece(s, s.start, s.end, H - 0.22, H, t + 0.04, undefined, false); // downstand / beam
        break;
      case "door": {
        const dw = Math.min(0.9, Math.max(0.5, s.length - 0.2));
        const a = (s.length - dw) / 2;
        piece(s, start, at(a), 0, H, t);
        piece(s, at(a + dw), end, 0, H, t);
        piece(s, at(a), at(a + dw), Math.min(2.05, H - 0.1), H, t, undefined, false);
        break;
      }
      case "window": {
        const ww = Math.min(s.length - 0.3, Math.max(0.6, s.length * 0.55));
        const a = (s.length - ww) / 2;
        const sill = 0.85, head = Math.min(2.1, H - 0.2);
        piece(s, start, at(a), 0, H, t);
        piece(s, at(a + ww), end, 0, H, t);
        piece(s, at(a), at(a + ww), 0, sill, t);
        piece(s, at(a), at(a + ww), head, H, t, undefined, false);
        piece(s, at(a), at(a + ww), sill, head, 0.03, glass, false);
        piece(s, at(a), at(a + ww), sill, sill + 0.05, t + 0.02, frame, false);
        break;
      }
      case "glazed": {
        piece(s, start, s.start, 0, H, t);
        piece(s, s.end, end, 0, H, t);
        piece(s, s.start, s.end, H - 0.18, H, t, undefined, false);
        piece(s, s.start, s.end, 0, H - 0.18, 0.03, glass);
        const panes = Math.max(1, Math.round(s.length / 1.1));
        for (let i = 0; i <= panes; i++) {
          const u = s.start + (s.length * i) / panes;
          piece(s, u - 0.03, u + 0.03, 0, H - 0.18, 0.08, frame, false);
        }
        piece(s, s.start, s.end, 0, 0.04, 0.1, frame, false);
        break;
      }
    }
  }

  if (furniture) addFurniture(group, rooms, walls, mat);

  // Sun
  const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
  const sun = new THREE.DirectionalLight("#fff4e0", 2.2);
  sun.position.set(cx - 12, 18, cz - 8);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = true;
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2 + 4;
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 60 });
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  group.add(sun, sun.target);

  return { group, walls, colliders, labels, rooms, bounds: b };
}

type MatFn = (color: string, opts?: THREE.MeshStandardMaterialParameters) => THREE.Material;

function addFurniture(group: THREE.Group, rooms: Room[], walls: WallSegment[], mat: MatFn) {
  const box = (x: number, z: number, w: number, d: number, h: number, color: string, y0 = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, { roughness: 0.8 }));
    m.position.set(x, y0 + h / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };

  for (const r of rooms) {
    const segs = walls.filter((s) => s.sideA === r.id || s.sideB === r.id);
    const blocked = (side: PlanSide) => segs.some((s) => segSideOfRoom(s, r) === side && s.state !== "solid" && s.state !== "window");
    const solidSides = (["top", "bottom", "left", "right"] as PlanSide[]).filter((sd) => !blocked(sd));
    const cx = r.x + r.w / 2, cz = r.y + r.d / 2;
    // Place an item of size (along, deep) against a side, centred along it.
    const against = (side: PlanSide, along: number, deep: number, h: number, color: string, gap = 0.05, y0 = 0) => {
      if (side === "top") return box(cx, r.y + gap + deep / 2, along, deep, h, color, y0);
      if (side === "bottom") return box(cx, r.y + r.d - gap - deep / 2, along, deep, h, color, y0);
      if (side === "left") return box(r.x + gap + deep / 2, cz, deep, along, h, color, y0);
      return box(r.x + r.w - gap - deep / 2, cz, deep, along, h, color, y0);
    };
    const sideLen = (side: PlanSide) => (side === "top" || side === "bottom" ? r.w : r.d);
    const longest = [...solidSides].sort((a, b) => sideLen(b) - sideLen(a))[0];
    const min = Math.min(r.w, r.d);

    const table = (x: number, z: number, w: number, d: number) => {
      box(x, z, w, d, 0.04, "#8a6a4f", 0.72);
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(x + dx * (w / 2 - 0.06), z + dz * (d / 2 - 0.06), 0.05, 0.05, 0.72, "#6f5540");
      const along = w >= d;
      const n = Math.max(1, Math.floor((along ? w : d) / 0.6));
      for (let i = 0; i < n; i++) {
        const u = -((n - 1) * 0.6) / 2 + i * 0.6;
        for (const sgn of [-1, 1]) {
          if (along) box(x + u, z + sgn * (d / 2 + 0.28), 0.42, 0.42, 0.45, "#d9d2c5");
          else box(x + sgn * (w / 2 + 0.28), z + u, 0.42, 0.42, 0.45, "#d9d2c5");
        }
      }
    };

    switch (r.type) {
      case "bedroom": {
        if (!longest) break;
        const double = min >= 2.6;
        const bw = double ? 1.5 : 0.95, bl = 2.0;
        if (sideLen(longest) < bw + 0.3 || min < bl + 0.5) break;
        against(longest, bw, bl, 0.45, "#e9e4da");
        against(longest, bw, 0.5, 0.18, "#f6f3ee", 0.15, 0.45); // pillows
        against(longest, bw + 0.08, 0.08, 1.0, "#6f7a66"); // headboard
        break;
      }
      case "living": {
        if (longest && sideLen(longest) > 2.6 && min > 2.8) {
          against(longest, 2.2, 0.9, 0.42, "#7d8c78");
          against(longest, 2.2, 0.22, 0.8, "#6e7d69");
        }
        box(cx, cz, Math.min(2.4, r.w - 1), Math.min(1.7, r.d - 1), 0.01, "#b46b4a");
        box(cx, cz, 1.0, 0.55, 0.4, "#8a6a4f");
        break;
      }
      case "kitchen":
      case "kitchen_dining": {
        const run = longest ?? "top";
        const len = Math.max(0.6, sideLen(run) - 0.3);
        against(run, len, 0.62, 0.88, "#e4ddd0");
        against(run, len, 0.64, 0.04, "#3b3f45", 0.04, 0.88);
        against(run, len, 0.35, 0.7, "#e4ddd0", 0.05, 1.45); // wall cupboards
        const island = r.type === "kitchen" && min >= 3.6;
        if (island) {
          box(cx, cz, Math.min(2.2, r.w - 2.2), 0.9, 0.9, "#5c7a5e");
          box(cx, cz, Math.min(2.2, r.w - 2.2) + 0.05, 0.95, 0.04, "#f1ede6", 0.9);
        }
        if (r.type === "kitchen_dining" && r.w * r.d > 14) {
          const along = r.w >= r.d;
          const ox = along ? r.w * 0.15 : 0, oz = along ? 0 : r.d * 0.15;
          table(cx + ox, cz + oz, along ? 1.8 : 0.95, along ? 0.95 : 1.8);
        }
        break;
      }
      case "dining":
        if (min > 2.4) table(cx, cz, r.w >= r.d ? 1.6 : 0.9, r.w >= r.d ? 0.9 : 1.6);
        break;
      case "study":
        if (longest) against(longest, Math.min(1.4, sideLen(longest) - 0.3), 0.65, 0.74, "#8a6a4f");
        break;
      case "bathroom":
      case "ensuite": {
        if (longest && sideLen(longest) >= 1.6 && r.type === "bathroom") against(longest, Math.min(1.7, sideLen(longest) - 0.05), 0.72, 0.55, "#f7f7f5");
        const other = solidSides.find((s) => s !== longest);
        if (other) {
          const m = against(other, 0.5, 0.42, 0.85, "#f7f7f5");
          if (m) m.position.add(new THREE.Vector3(other === "top" || other === "bottom" ? -0.4 : 0, 0, other === "left" || other === "right" ? -0.4 : 0));
        }
        break;
      }
      case "wc":
        if (longest) against(longest, 0.4, 0.62, 0.42, "#f7f7f5");
        break;
    }
  }
}

/** Where to stand to see a room: just inside its main doorway, facing in. */
function entryPose(room: Room, walls: WallSegment[], preferExterior = false) {
  const mine = walls.filter((s) => (s.sideA === room.id || s.sideB === room.id) && ["door", "open"].includes(s.state));
  const ranked = [...mine].sort((a, b) => Number(b.exterior && preferExterior) - Number(a.exterior && preferExterior) || Number(b.state === "door") - Number(a.state === "door"));
  const cx = room.x + room.w / 2, cz = room.y + room.d / 2;
  const s = ranked[0];
  if (!s) return { x: cx, z: cz, yaw: 0 };
  const side = segSideOfRoom(s, room);
  const mid = (s.start + s.end) / 2;
  const inset = Math.min(0.7, (side === "top" || side === "bottom" ? room.d : room.w) / 2);
  let x = cx, z = cz;
  if (side === "top") { x = mid; z = s.c + inset; }
  else if (side === "bottom") { x = mid; z = s.c - inset; }
  else if (side === "left") { x = s.c + inset; z = mid; }
  else if (side === "right") { x = s.c - inset; z = mid; }
  // Face along the room's long axis from the doorway, towards its far end.
  const far = side === "top" ? { x: cx, z: room.y + room.d } : side === "bottom" ? { x: cx, z: room.y } : side === "left" ? { x: room.x + room.w, z: cz } : { x: room.x, z: cz };
  return { x, z, yaw: Math.atan2(-(far.x - x), -(far.z - z)) };
}

function dispose(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

function segDist(px: number, pz: number, c: Collider) {
  const dx = c.x2 - c.x1, dz = c.z2 - c.z1;
  const len2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - c.x1) * dx + (pz - c.z1) * dz) / len2));
  return Math.hypot(px - (c.x1 + t * dx), pz - (c.z1 + t * dz));
}

// ─── Component ────────────────────────────────────────────────────────────

export default function Viewer3D({ layout, floorId, mode, furniture = true, onApi, className = "" }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const state = useRef<{
    renderer: THREE.WebGLRenderer;
    labelRenderer: CSS2DRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    orbit: OrbitControls;
    built: Built | null;
    yaw: number;
    pitch: number;
    keys: Set<string>;
    move: { f: number; r: number };
    mode: "orbit" | "walk";
  } | null>(null);
  const [hint, setHint] = useState(true);

  // One-time renderer setup.
  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = "none";

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.style.position = "absolute";
    labelRenderer.domElement.style.inset = "0";
    labelRenderer.domElement.style.pointerEvents = "none";
    host.appendChild(labelRenderer.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#ffffff", "#d8cfc0", 1.4));
    scene.add(new THREE.AmbientLight("#ffffff", 0.35));
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 300);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.maxPolarAngle = Math.PI / 2.05;

    const s = { renderer, labelRenderer, scene, camera, orbit, built: null as Built | null, yaw: 0, pitch: 0, keys: new Set<string>(), move: { f: 0, r: 0 }, mode: "orbit" as "orbit" | "walk" };
    state.current = s;

    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight;
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // Walk controls: drag to look, WASD/arrows or on-screen pad to move, wheel to step.
    let dragging: { x: number; y: number; id: number } | null = null;
    const down = (e: PointerEvent) => {
      if (s.mode !== "walk") return;
      dragging = { x: e.clientX, y: e.clientY, id: e.pointerId };
      renderer.domElement.setPointerCapture(e.pointerId);
      setHint(false);
    };
    const moveP = (e: PointerEvent) => {
      if (!dragging || s.mode !== "walk" || e.pointerId !== dragging.id) return;
      s.yaw -= (e.clientX - dragging.x) * 0.0045;
      s.pitch = Math.max(-1.2, Math.min(1.2, s.pitch - (e.clientY - dragging.y) * 0.0045));
      dragging.x = e.clientX;
      dragging.y = e.clientY;
    };
    const up = () => (dragging = null);
    const wheel = (e: WheelEvent) => {
      if (s.mode !== "walk") return;
      e.preventDefault();
      step(-Math.sign(e.deltaY) * 0.35, 0);
    };
    const key = (e: KeyboardEvent, on: boolean) => {
      if (s.mode !== "walk" || (e.target as HTMLElement)?.closest?.("input,textarea,select")) return;
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "shift"].includes(k)) {
        if (on) s.keys.add(k);
        else s.keys.delete(k);
        if (k.startsWith("arrow")) e.preventDefault();
        setHint(false);
      }
    };
    const kd = (e: KeyboardEvent) => key(e, true);
    const ku = (e: KeyboardEvent) => key(e, false);
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointermove", moveP);
    renderer.domElement.addEventListener("pointerup", up);
    renderer.domElement.addEventListener("pointercancel", up);
    renderer.domElement.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);

    const step = (forward: number, right: number) => {
      const cols = s.built?.colliders ?? [];
      const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
      const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
      const dx = fx * forward + rx * right, dz = fz * forward + rz * right;
      const p = camera.position;
      const free = (x: number, z: number) => cols.every((c) => segDist(x, z, c) > RADIUS);
      if (free(p.x + dx, p.z)) p.x += dx;
      if (free(p.x, p.z + dz)) p.z += dz;
    };

    const clock = new THREE.Clock();
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, clock.getDelta());
      if (s.mode === "orbit") {
        orbit.update();
      } else {
        const k = s.keys;
        const speed = (k.has("shift") ? 3.2 : 1.6) * dt;
        const f = (k.has("w") || k.has("arrowup") ? 1 : 0) - (k.has("s") || k.has("arrowdown") ? 1 : 0) + s.move.f;
        const r = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0) + s.move.r;
        if (k.has("arrowleft")) s.yaw += 1.8 * dt;
        if (k.has("arrowright")) s.yaw -= 1.8 * dt;
        if (f || r) step(f * speed, r * speed);
        camera.rotation.set(s.pitch, s.yaw, 0, "YXZ");
      }
      renderer.render(scene, camera);
      if (s.mode === "orbit") labelRenderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      orbit.dispose();
      if (s.built) dispose(s.built.group);
      renderer.dispose();
      host.removeChild(renderer.domElement);
      host.removeChild(labelRenderer.domElement);
      state.current = null;
    };
  }, []);

  // Rebuild geometry when the plan changes.
  const firstBuild = useRef(true);
  const lastFloor = useRef<string | null>(null);
  useEffect(() => {
    const s = state.current;
    if (!s) return;
    if (s.built) {
      s.scene.remove(s.built.group);
      for (const l of s.built.labels) l.removeFromParent();
      dispose(s.built.group);
    }
    const built = build(layout, floorId, furniture, mode === "walk");
    s.built = built;
    s.scene.add(built.group);
    if (mode === "orbit") for (const l of built.labels) built.group.add(l);
    const b = built.bounds;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 4);
    const resetView = firstBuild.current || lastFloor.current !== floorId || s.mode !== mode;
    s.mode = mode;
    s.scene.background = new THREE.Color(mode === "walk" ? "#e6ecf0" : "#f4efe6");
    s.orbit.enabled = mode === "orbit";
    if (resetView) {
      if (mode === "orbit") {
        s.camera.fov = 45;
        s.orbit.target.set(cx, 0, cz);
        s.camera.position.set(cx + span * 0.55, span * 1.05, cz + span * 0.95);
      } else {
        s.camera.fov = 70;
        const start = built.rooms.find((r) => r.type === "hall") ?? built.rooms.find((r) => r.type === "landing") ?? built.rooms.find((r) => r.type === "living") ?? built.rooms[0];
        if (start) {
          const pose = entryPose(start, built.walls, true);
          s.camera.position.set(pose.x, EYE, pose.z);
          s.yaw = pose.yaw;
          s.pitch = -0.05;
        }
      }
      s.camera.updateProjectionMatrix();
    }
    firstBuild.current = false;
    lastFloor.current = floorId;
  }, [layout, floorId, furniture, mode]);

  // Expose snapshot + teleport.
  useEffect(() => {
    if (!onApi) return;
    onApi({
      snapshot: () => {
        const s = state.current!;
        s.renderer.render(s.scene, s.camera);
        return s.renderer.domElement.toDataURL("image/jpeg", 0.9);
      },
      goToRoom: (id) => {
        const s = state.current;
        const r = s?.built?.rooms.find((x) => x.id === id);
        if (!s || !r) return;
        if (s.mode === "walk") {
          const pose = entryPose(r, s.built!.walls);
          s.camera.position.set(pose.x, EYE, pose.z);
          s.yaw = pose.yaw;
          s.pitch = -0.08;
        } else {
          s.orbit.target.set(r.x + r.w / 2, 0, r.y + r.d / 2);
        }
      },
    });
    return () => onApi(null);
  }, [onApi]);

  const pad = (f: number, r: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      if (state.current) state.current.move = { f, r };
      setHint(false);
    },
    onPointerUp: () => state.current && (state.current.move = { f: 0, r: 0 }),
    onPointerLeave: () => state.current && (state.current.move = { f: 0, r: 0 }),
  });

  return (
    <div className={`relative overflow-hidden ${className}`}>
      <div ref={hostRef} className="absolute inset-0" />
      {mode === "walk" && (
        <>
          {hint && (
            <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-ink/75 px-3 py-1.5 text-xs text-paper">
              Drag to look · W A S D / arrows to walk · Shift to hurry · scroll to step
            </div>
          )}
          <div className="absolute right-3 bottom-3 grid grid-cols-3 gap-1 select-none" aria-label="Movement pad">
            <span />
            <button className="h-11 w-11 rounded-md bg-card/90 text-lg shadow" aria-label="Forward" {...pad(1, 0)}>▲</button>
            <span />
            <button className="h-11 w-11 rounded-md bg-card/90 text-lg shadow" aria-label="Step left" {...pad(0, -1)}>◀</button>
            <button className="h-11 w-11 rounded-md bg-card/90 text-lg shadow" aria-label="Back" {...pad(-1, 0)}>▼</button>
            <button className="h-11 w-11 rounded-md bg-card/90 text-lg shadow" aria-label="Step right" {...pad(0, 1)}>▶</button>
          </div>
        </>
      )}
    </div>
  );
}
