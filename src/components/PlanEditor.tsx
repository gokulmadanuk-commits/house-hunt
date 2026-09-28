"use client";
// 2D plan: draws rooms and derived walls in metres (SVG user units = metres).
// Interactive mode lets you select/drag/resize rooms and click walls.

import { useMemo, useRef, useState } from "react";
import { deriveWalls, floorBounds, ROOM_TINT, snap, type WallSegment } from "@/lib/layout";
import type { Floor, Layout, Room } from "@/lib/types";

export type Selection = { kind: "room"; id: string } | { kind: "wall"; key: string } | null;

const INK = "#1d2733";
const BLUEPRINT = "#2c5a85";
const BRICK = "#b4532a";

function WallMark({ s, highlighted }: { s: WallSegment; highlighted: boolean }) {
  const t = s.party ? 0.24 : s.exterior ? 0.2 : 0.12;
  const stroke = highlighted ? BRICK : INK;
  const along = (u: number) => (s.orient === "h" ? { x: s.x1 + u, y: s.y1 } : { x: s.x1, y: s.y1 + u });
  const line = (a: number, b: number, extra: React.SVGProps<SVGLineElement> = {}) => {
    const p = along(a), q = along(b);
    return <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={stroke} strokeWidth={t} strokeLinecap="square" {...extra} />;
  };
  const L = s.length;
  switch (s.state) {
    case "open":
      return line(0, L, { stroke: highlighted ? BRICK : "#9aa1ab", strokeWidth: 0.05, strokeDasharray: "0.18 0.14", strokeLinecap: "butt" });
    case "door": {
      const w = Math.min(0.9, Math.max(0.5, L - 0.2));
      const a = (L - w) / 2;
      const hinge = along(a);
      const tip = along(a + w);
      // Door leaf swings into the positive side of the wall.
      const leafEnd = s.orient === "h" ? { x: hinge.x, y: hinge.y + w } : { x: hinge.x + w, y: hinge.y };
      return (
        <g>
          {line(0, a)}
          {line(a + w, L)}
          <line x1={hinge.x} y1={hinge.y} x2={leafEnd.x} y2={leafEnd.y} stroke={stroke} strokeWidth={0.035} />
          <path d={`M ${leafEnd.x} ${leafEnd.y} A ${w} ${w} 0 0 ${s.orient === "h" ? 0 : 1} ${tip.x} ${tip.y}`} fill="none" stroke={stroke} strokeWidth={0.02} strokeDasharray="0.06 0.05" />
        </g>
      );
    }
    case "window": {
      const w = Math.min(L - 0.3, Math.max(0.6, L * 0.55));
      const a = (L - w) / 2;
      return (
        <g>
          {line(0, a)}
          {line(a + w, L)}
          {line(a, a + w, { stroke: highlighted ? BRICK : BLUEPRINT, strokeWidth: t * 0.7, strokeLinecap: "butt" })}
          {line(a, a + w, { stroke: "#fff", strokeWidth: t * 0.25, strokeLinecap: "butt" })}
        </g>
      );
    }
    case "glazed":
      return (
        <g>
          {line(0, L, { stroke: highlighted ? BRICK : BLUEPRINT, strokeWidth: t * 0.8 })}
          {line(0, L, { stroke: "#fff", strokeWidth: t * 0.3 })}
        </g>
      );
    default:
      return line(0, L);
  }
}

interface Props {
  layout: Layout;
  floorId: string;
  selection?: Selection;
  onSelect?: (s: Selection) => void;
  onChange?: (layout: Layout, commit: boolean) => void;
  compact?: boolean;
  className?: string;
}

export default function PlanEditor({ layout, floorId, selection = null, onSelect, onChange, compact, className = "" }: Props) {
  const floor = layout.floors.find((f) => f.id === floorId) ?? layout.floors[0];
  const walls = useMemo(() => (floor ? deriveWalls(floor, layout) : []), [floor, layout]);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverWall, setHoverWall] = useState<string | null>(null);
  const drag = useRef<{ mode: "move" | "resize"; id: string; start: { x: number; y: number }; room: Room; moved: boolean } | null>(null);
  const interactive = !!onChange;

  // Keep the viewBox stable during a drag so the plan doesn't swim under the cursor.
  const [frozenBox, setFrozenBox] = useState<string | null>(null);
  if (!floor) return <div className={className} />;
  const b = floorBounds(floor);
  const all = layout.floors.flatMap((f) => f.rooms);
  const gb = all.length
    ? { minX: Math.min(b.minX, ...all.map((r) => r.x)), minY: Math.min(b.minY, ...all.map((r) => r.y)), maxX: Math.max(b.maxX, ...all.map((r) => r.x + r.w)), maxY: Math.max(b.maxY, ...all.map((r) => r.y + r.d)) }
    : b;
  const m = compact ? 0.4 : 1.4;
  const viewBox = frozenBox ?? `${gb.minX - m} ${gb.minY - m} ${gb.maxX - gb.minX + m * 2} ${gb.maxY - gb.minY + m * 2}`;

  const toPlan = (e: React.PointerEvent) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };

  const magnet = (v: number, candidates: number[]) => {
    let best = v, dist = 0.25;
    for (const c of candidates) if (Math.abs(c - v) < dist) { best = c; dist = Math.abs(c - v); }
    return best;
  };

  const updateRoom = (id: string, patch: Partial<Room>, commit: boolean) => {
    const next: Layout = {
      ...layout,
      floors: layout.floors.map((f) => (f.id !== floor.id ? f : { ...f, rooms: f.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
    };
    onChange?.(next, commit);
  };

  const onRoomDown = (e: React.PointerEvent, room: Room, mode: "move" | "resize") => {
    e.stopPropagation();
    onSelect?.({ kind: "room", id: room.id });
    if (!interactive) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { mode, id: room.id, start: toPlan(e), room: { ...room }, moved: false };
    setFrozenBox(viewBox);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toPlan(e);
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 0.08) return;
    d.moved = true;
    const others = floor.rooms.filter((r) => r.id !== d.id);
    const xs = others.flatMap((r) => [r.x, r.x + r.w]);
    const ys = others.flatMap((r) => [r.y, r.y + r.d]);
    if (d.mode === "move") {
      let x = snap(d.room.x + dx), y = snap(d.room.y + dy);
      const xl = magnet(x, xs), xr = magnet(x + d.room.w, xs) - d.room.w;
      x = Math.abs(xl - x) <= Math.abs(xr - x) && xl !== x ? xl : xr !== x ? xr : x;
      const yt = magnet(y, ys), yb = magnet(y + d.room.d, ys) - d.room.d;
      y = Math.abs(yt - y) <= Math.abs(yb - y) && yt !== y ? yt : yb !== y ? yb : y;
      updateRoom(d.id, { x: snap(x), y: snap(y) }, false);
    } else {
      const x2 = magnet(snap(d.room.x + d.room.w + dx), xs);
      const y2 = magnet(snap(d.room.y + d.room.d + dy), ys);
      updateRoom(d.id, { w: Math.max(0.6, snap(x2 - d.room.x)), d: Math.max(0.6, snap(y2 - d.room.y)) }, false);
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setFrozenBox(null);
    if (d?.moved) onChange?.(layout, true);
  };

  const selectedRoom = selection?.kind === "room" ? floor.rooms.find((r) => r.id === selection.id) : undefined;
  const fs = compact ? 0.42 : 0.26;

  return (
    <svg
      ref={svgRef}
      viewBox={viewBox}
      className={`block h-full w-full touch-none select-none ${className}`}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerDown={() => onSelect?.(null)}
      role="img"
      aria-label={`Floor plan: ${floor.name}`}
    >
      <defs>
        <pattern id="hatch-new" width="0.3" height="0.3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="0.3" stroke={BRICK} strokeWidth="0.03" strokeOpacity="0.35" />
        </pattern>
        <pattern id="grid-1m" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M 1 0 L 0 0 0 1" fill="none" stroke={BLUEPRINT} strokeOpacity="0.09" strokeWidth="0.015" />
        </pattern>
      </defs>
      {!compact && <rect x={gb.minX - 50} y={gb.minY - 50} width={gb.maxX - gb.minX + 100} height={gb.maxY - gb.minY + 100} fill="url(#grid-1m)" />}

      {/* Ghost of other floors for alignment */}
      {!compact &&
        layout.floors
          .filter((f) => f.id !== floor.id)
          .flatMap((f) => f.rooms)
          .map((r) => <rect key={`ghost-${r.id}`} x={r.x} y={r.y} width={r.w} height={r.d} fill="none" stroke={BLUEPRINT} strokeOpacity={0.14} strokeWidth={0.03} strokeDasharray="0.1 0.1" />)}

      {floor.rooms.map((r) => (
        <g key={r.id}>
          <rect
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.d}
            fill={ROOM_TINT[r.type]}
            onPointerDown={(e) => onRoomDown(e, r, "move")}
            className={interactive ? "cursor-move" : onSelect ? "cursor-pointer" : ""}
          />
          {r.isNew && <rect x={r.x} y={r.y} width={r.w} height={r.d} fill="url(#hatch-new)" pointerEvents="none" />}
        </g>
      ))}

      {walls.map((s) => (
        <g key={s.key}>
          <WallMark s={s} highlighted={hoverWall === s.key || (selection?.kind === "wall" && selection.key === s.key)} />
          {onSelect && !compact && (
            <line
              x1={s.x1}
              y1={s.y1}
              x2={s.x2}
              y2={s.y2}
              stroke="transparent"
              strokeWidth={0.4}
              className="cursor-pointer"
              onPointerEnter={() => setHoverWall(s.key)}
              onPointerLeave={() => setHoverWall(null)}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect({ kind: "wall", key: s.key });
              }}
            />
          )}
        </g>
      ))}

      {floor.rooms.map((r) => {
        // Rotate labels in long thin rooms (halls, landings) and shrink to fit.
        const vertical = r.w < 1.8 && r.d > r.w * 1.6;
        const span = (vertical ? r.d : r.w) * 0.9;
        const name = r.name;
        const nameSize = Math.min(fs, span / Math.max(4, name.length * 0.56));
        const cx = r.x + r.w / 2, cy = r.y + r.d / 2;
        const showDims = !compact && (vertical ? r.w : r.d) > 0.9 && span > 1.4;
        return (
          <g key={`label-${r.id}`} pointerEvents="none" fontFamily="var(--font-instrument), sans-serif" transform={vertical ? `rotate(-90 ${cx} ${cy})` : undefined}>
            <text x={cx} y={cy - (showDims ? fs * 0.3 : -nameSize * 0.35)} textAnchor="middle" fontSize={nameSize} fill={INK} fontWeight={600}>
              {name}
            </text>
            {showDims && (
              <text x={cx} y={cy + fs * 0.95} textAnchor="middle" fontSize={Math.min(fs * 0.72, span / 13)} fill="#4b5563" fontFamily="var(--font-jetbrains), monospace">
                {r.w.toFixed(1)}×{r.d.toFixed(1)} · {(r.w * r.d).toFixed(1)}m²
              </text>
            )}
          </g>
        );
      })}

      {selectedRoom && (
        <g>
          <rect x={selectedRoom.x} y={selectedRoom.y} width={selectedRoom.w} height={selectedRoom.d} fill="none" stroke={BLUEPRINT} strokeWidth={0.06} strokeDasharray="0.2 0.1" pointerEvents="none" />
          {interactive && (
            <rect
              x={selectedRoom.x + selectedRoom.w - 0.18}
              y={selectedRoom.y + selectedRoom.d - 0.18}
              width={0.36}
              height={0.36}
              rx={0.06}
              fill="#fff"
              stroke={BLUEPRINT}
              strokeWidth={0.05}
              className="cursor-nwse-resize"
              onPointerDown={(e) => onRoomDown(e, selectedRoom, "resize")}
            />
          )}
        </g>
      )}

      {!compact && floor.rooms.length > 0 && <Dimensions floor={floor} />}
    </svg>
  );
}

function Dimensions({ floor }: { floor: Floor }) {
  const b = floorBounds(floor);
  const y = b.minY - 0.6, x = b.minX - 0.6;
  const w = b.maxX - b.minX, d = b.maxY - b.minY;
  const common = { stroke: "#7b8491", strokeWidth: 0.02 };
  return (
    <g pointerEvents="none" fontFamily="var(--font-jetbrains), monospace" fontSize={0.22} fill="#7b8491">
      <line x1={b.minX} y1={y} x2={b.maxX} y2={y} {...common} />
      <line x1={b.minX} y1={y - 0.12} x2={b.minX} y2={y + 0.12} {...common} />
      <line x1={b.maxX} y1={y - 0.12} x2={b.maxX} y2={y + 0.12} {...common} />
      <text x={b.minX + w / 2} y={y - 0.14} textAnchor="middle">{w.toFixed(2)} m</text>
      <line x1={x} y1={b.minY} x2={x} y2={b.maxY} {...common} />
      <line x1={x - 0.12} y1={b.minY} x2={x + 0.12} y2={b.minY} {...common} />
      <line x1={x - 0.12} y1={b.maxY} x2={x + 0.12} y2={b.maxY} {...common} />
      <text x={x - 0.14} y={b.minY + d / 2} textAnchor="middle" transform={`rotate(-90 ${x - 0.14} ${b.minY + d / 2})`}>{d.toFixed(2)} m</text>
    </g>
  );
}
