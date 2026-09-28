"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { costLines, DEFAULT_RATES, formatGBP, RATE_LABELS, type Rates } from "@/lib/costs";
import { deriveWalls, floorBounds, layoutStats, newId, ROOM_LABEL, snap } from "@/lib/layout";
import { FLOOR_FINISHES, ROOM_TYPES, TIERS, WALL_STATES, type Floor, type Layout, type PlanSide, type Room, type Scenario } from "@/lib/types";
import { ErrorNote, fileUrl, Spinner, useApp, useBusy } from "./client";
import { TIER_STYLE } from "./IdeasTab";
import PlanEditor, { type Selection } from "./PlanEditor";
import type { ViewerApi } from "./Viewer3D";
import type { WorkspaceCtx } from "./Workspace";

const Viewer3D = dynamic(() => import("./Viewer3D"), { ssr: false, loading: () => <div className="grid h-full place-items-center text-sm text-ink-3">Loading 3D…</div> });

type View = "plan" | "dollhouse" | "walk";

const PAINTS = ["#eee8dd", "#f6f3ec", "#dce3d5", "#c9d4c0", "#e8d9c4", "#d9c2a7", "#dfe5ea", "#b8c7d3", "#e9d6cf", "#cfc6bb", "#8a9a86", "#44505c"];

export default function PlansTab({ ctx }: { ctx: WorkspaceCtx }) {
  const { config, member } = useApp();
  const { p, op, handoff, goTo } = ctx;
  const base = p.scenarios.find((s) => s.tier === "base") ?? p.scenarios[0];
  const [selectedId, setSelectedId] = useState<string | undefined>(handoff.scenarioId ?? base?.id);
  const scenario = p.scenarios.find((s) => s.id === selectedId) ?? base;

  const { busy, error, setError, run } = useBusy();

  if (!scenario) return <EmptyPlans ctx={ctx} />;

  return (
    <div className="space-y-4">
      <ScenarioBar
        ctx={ctx}
        current={scenario}
        onSelect={setSelectedId}
        busy={busy}
        onNew={(from) =>
          run("new", async () => {
            const before = new Set(p.scenarios.map((s) => s.id));
            const next = await op("createScenario", {
              name: from ? `${from.name} (copy)` : "New idea",
              tier: from?.tier === "base" || !from ? "reconfigure" : from.tier,
              description: "",
              fromScenarioId: from?.id,
              author: member,
            });
            setSelectedId(next.scenarios.find((s) => !before.has(s.id))?.id);
          })
        }
        onDraft={(brief) =>
          run("draft", async () => {
            const before = new Set(p.scenarios.map((s) => s.id));
            const next = await op("propose", { author: member, brief, fromScenarioId: scenario.id });
            setSelectedId(next.scenarios.find((s) => !before.has(s.id))?.id);
          })
        }
        claude={config.claude}
      />
      <ErrorNote error={error} onClose={() => setError(null)} />
      <ScenarioEditor key={`${scenario.id}:${scenario.createdAt}`} ctx={ctx} scenario={scenario} base={base!} onSnapshot={(img) => goTo("visuals", { snapshot: img, scenarioId: scenario.id })} />
    </div>
  );
}

// ─── Scenario list ────────────────────────────────────────────────────────

function ScenarioBar({ ctx, current, onSelect, onNew, onDraft, busy, claude }: { ctx: WorkspaceCtx; current: Scenario; onSelect: (id: string) => void; onNew: (from?: Scenario) => void; onDraft: (brief: string) => void; busy: string | null; claude: boolean }) {
  const [brief, setBrief] = useState("");
  const [showDraft, setShowDraft] = useState(false);
  return (
    <div className="card p-3">
      <div className="flex flex-wrap items-center gap-2">
        {ctx.p.scenarios.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${s.id === current.id ? "border-ink bg-ink text-paper" : "border-line bg-paper text-ink hover:border-ink-3"}`}
          >
            <span className={`h-2 w-2 rounded-full ${TIER_STYLE[s.tier].dot}`} />
            {s.name}
            {s.source === "ai" && <span className="font-mono text-[10px] opacity-60">AI</span>}
          </button>
        ))}
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost py-1.5" disabled={!!busy} onClick={() => onNew(current)}>
            {busy === "new" ? <Spinner /> : "+"} Copy this plan
          </button>
          {claude && (
            <button className="btn-primary py-1.5" onClick={() => setShowDraft((v) => !v)}>
              Draft with Claude
            </button>
          )}
        </div>
      </div>
      {showDraft && (
        <form
          className="mt-3 flex flex-col gap-2 border-t border-line-2 pt-3 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (brief.trim()) onDraft(brief.trim());
          }}
        >
          <input
            className="input flex-1"
            autoFocus
            placeholder={`Starting from “${current.name}”, e.g. “Open kitchen into dining, add a 4m rear extension with roof lights and a utility off the side”`}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
          <button className="btn-primary" disabled={!!busy || !brief.trim()}>
            {busy === "draft" ? (
              <>
                <Spinner /> Drawing it up…
              </>
            ) : (
              "Draw it"
            )}
          </button>
        </form>
      )}
    </div>
  );
}

// ─── Editor ───────────────────────────────────────────────────────────────

function ScenarioEditor({ ctx, scenario, base, onSnapshot }: { ctx: WorkspaceCtx; scenario: Scenario; base: Scenario; onSnapshot: (img: string) => void }) {
  const { config } = useApp();
  const [draft, setDraft] = useState<Scenario>(scenario);
  const [floorId, setFloorId] = useState(scenario.layout.floors[0]?.id ?? "");
  const [selection, setSelection] = useState<Selection>(null);
  const [view, setView] = useState<View>("plan");
  const [furniture, setFurniture] = useState(true);
  const [saveState, setSaveState] = useState<"saved" | "pending" | "saving" | "error">("saved");
  const [showRef, setShowRef] = useState(false);
  const history = useRef<Layout[]>([]);
  const future = useRef<Layout[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(draft);
  latest.current = draft;
  const viewer = useRef<ViewerApi | null>(null);
  const onApi = useCallback((api: ViewerApi | null) => (viewer.current = api), []);
  const { busy, error, setError, run } = useBusy();

  const persist = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    setSaveState("saving");
    try {
      const s = latest.current;
      await ctx.op("saveScenario", { scenario: { id: s.id, name: s.name, tier: s.tier, description: s.description, layout: s.layout } });
      setSaveState("saved");
    } catch (e) {
      setSaveState("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [ctx.op, setError]);

  const schedule = () => {
    setSaveState("pending");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(persist, 900);
  };

  // Flush on unmount (switching scenario/tab).
  useEffect(() => () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      void persist();
    }
  }, [persist]);

  const setLayout = (layout: Layout, commit = true) => {
    if (commit) {
      history.current.push(latest.current.layout);
      if (history.current.length > 60) history.current.shift();
      future.current = [];
    }
    setDraft((d) => ({ ...d, layout }));
    if (commit) schedule();
  };

  // Plan drags stream uncommitted updates; the final commit records history.
  const dragStart = useRef<Layout | null>(null);
  const onPlanChange = (layout: Layout, commit: boolean) => {
    if (!commit) {
      dragStart.current ??= latest.current.layout;
      setDraft((d) => ({ ...d, layout }));
      return;
    }
    if (dragStart.current) {
      history.current.push(dragStart.current);
      dragStart.current = null;
      future.current = [];
      setDraft((d) => ({ ...d, layout }));
      schedule();
    }
  };

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev) return;
    future.current.push(latest.current.layout);
    setDraft((d) => ({ ...d, layout: prev }));
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    history.current.push(latest.current.layout);
    setDraft((d) => ({ ...d, layout: next }));
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input,textarea,select")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selection?.kind === "room") {
        e.preventDefault();
        removeRoom(selection.id);
      }
      if (e.key === "Escape") setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const layout = draft.layout;
  const floor = layout.floors.find((f) => f.id === floorId) ?? layout.floors[0];

  const updateFloor = (fn: (f: Floor) => Floor) => setLayout({ ...layout, floors: layout.floors.map((f) => (f.id === floor.id ? fn(f) : f)) });
  const updateRoom = (id: string, patch: Partial<Room>) => updateFloor((f) => ({ ...f, rooms: f.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  const removeRoom = (id: string) => {
    updateFloor((f) => ({ ...f, rooms: f.rooms.filter((r) => r.id !== id) }));
    setSelection(null);
  };
  const addRoom = () => {
    const b = floorBounds(floor);
    const room: Room = {
      id: newId("r"),
      name: draft.tier === "extend" ? "Extension" : "New room",
      type: draft.tier === "extend" ? "kitchen_dining" : "other",
      x: floor.rooms.length ? snap(b.minX) : 0,
      y: floor.rooms.length ? snap(b.maxY) : 0,
      w: 3,
      d: 3,
      ...(draft.tier === "extend" ? { isNew: true } : {}),
    };
    updateFloor((f) => ({ ...f, rooms: [...f.rooms, room] }));
    setSelection({ kind: "room", id: room.id });
    setView("plan");
  };

  const floorplans = ctx.p.photos.filter((ph) => ph.kind === "floorplan");
  const stats = useMemo(() => layoutStats(layout), [layout]);
  const baseStats = useMemo(() => layoutStats(base.layout), [base.layout]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="space-y-3">
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <div className="flex gap-1 rounded-lg bg-line-2 p-1 text-sm" role="tablist">
              {([
                ["plan", "Plan"],
                ["dollhouse", "3D"],
                ["walk", "Walk through"],
              ] as const).map(([v, label]) => (
                <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`rounded-md px-3 py-1 font-medium ${view === v ? "bg-card shadow-sm" : "text-ink-2"}`}>
                  {label}
                </button>
              ))}
            </div>
            {layout.floors.length > 1 && (
              <div className="flex gap-1 text-sm">
                {layout.floors.map((f) => (
                  <button key={f.id} onClick={() => { setFloorId(f.id); setSelection(null); }} className={`rounded-full border px-2.5 py-1 ${f.id === floor.id ? "border-blueprint bg-blueprint-2 text-blueprint" : "border-line text-ink-2"}`}>
                    {f.name}
                  </button>
                ))}
              </div>
            )}
            <div className="ml-auto flex items-center gap-2 text-xs text-ink-3">
              {view !== "plan" && (
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={furniture} onChange={(e) => setFurniture(e.target.checked)} /> Furniture
                </label>
              )}
              {view === "plan" && (
                <>
                  <button className="btn-quiet px-2 py-1" onClick={undo} title="Undo (Ctrl/Cmd+Z)" disabled={!history.current.length}>↶</button>
                  <button className="btn-quiet px-2 py-1" onClick={redo} title="Redo (Shift+Ctrl/Cmd+Z)" disabled={!future.current.length}>↷</button>
                </>
              )}
              <SaveBadge state={saveState} />
            </div>
          </div>
          <div className="relative h-[62vh] min-h-[420px] bg-paper">
            {view === "plan" ? (
              floor.rooms.length ? (
                <PlanEditor layout={layout} floorId={floor.id} selection={selection} onSelect={setSelection} onChange={onPlanChange} />
              ) : (
                <div className="grid h-full place-items-center p-6 text-center text-sm text-ink-2">
                  <div>
                    <p>This floor is empty.</p>
                    <button className="btn-primary mt-3" onClick={addRoom}>+ Add a room</button>
                  </div>
                </div>
              )
            ) : (
              <Viewer3D layout={layout} floorId={floor.id} mode={view === "walk" ? "walk" : "orbit"} furniture={furniture} onApi={onApi} className="h-full w-full" />
            )}
            {view === "plan" && showRef && floorplans[0] && (
              <div className="absolute top-3 right-3 w-[42%] max-w-md overflow-hidden rounded-lg border border-line bg-white shadow-lg">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fileUrl(floorplans[0].file)} alt="Agent floor plan" className="w-full" />
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-sm">
            {view === "plan" ? (
              <>
                <button className="btn-ghost py-1" onClick={addRoom}>+ Room</button>
                {floorplans.length > 0 && (
                  <button className="btn-quiet py-1" onClick={() => setShowRef((v) => !v)}>
                    {showRef ? "Hide" : "Show"} agent&rsquo;s plan
                  </button>
                )}
                <span className="ml-auto text-xs text-ink-3">Drag rooms to move (edges snap together) · corner handle resizes · click a wall to change it</span>
              </>
            ) : (
              <>
                <span className="text-xs text-ink-3">Jump to:</span>
                {floor.rooms.map((r) => (
                  <button key={r.id} className="rounded-full border border-line px-2 py-0.5 text-xs hover:border-ink-3" onClick={() => viewer.current?.goToRoom(r.id)}>
                    {r.name}
                  </button>
                ))}
                <button
                  className="btn-primary ml-auto py-1"
                  disabled={!config.images}
                  title={config.images ? "Turn this view into a photoreal visual" : "Add an image model key to enable"}
                  onClick={() => {
                    const img = viewer.current?.snapshot();
                    if (img) onSnapshot(img);
                  }}
                >
                  Make this view photoreal
                </button>
              </>
            )}
          </div>
        </div>
        <ScenarioMeta draft={draft} setDraft={(d) => { setDraft(d); schedule(); }} ctx={ctx} busy={busy} run={run} isBase={draft.id === base.id} />
        <ErrorNote error={error} onClose={() => setError(null)} />
      </div>

      <aside className="space-y-4">
        <Inspector
          layout={layout}
          floor={floor}
          selection={selection}
          setSelection={setSelection}
          updateRoom={updateRoom}
          removeRoom={removeRoom}
          setLayout={setLayout}
          setFloorId={setFloorId}
          addRoom={addRoom}
        />
        <Numbers stats={stats} baseStats={baseStats} isBase={draft.id === base.id} />
        {draft.id !== base.id && <Costs base={base.layout} layout={layout} />}
      </aside>
    </div>
  );
}

function SaveBadge({ state }: { state: "saved" | "pending" | "saving" | "error" }) {
  const label = { saved: "Saved", pending: "Unsaved…", saving: "Saving…", error: "Not saved" }[state];
  return <span className={`font-mono ${state === "error" ? "text-brick" : ""}`}>{label}</span>;
}

function ScenarioMeta({ draft, setDraft, ctx, busy, run, isBase }: { draft: Scenario; setDraft: (s: Scenario) => void; ctx: WorkspaceCtx; busy: string | null; run: ReturnType<typeof useBusy>["run"]; isBase: boolean }) {
  const { config, member } = useApp();
  const floorplans = ctx.p.photos.filter((ph) => ph.kind === "floorplan");
  return (
    <div className="card grid gap-3 p-4 sm:grid-cols-[1fr_180px]">
      <div className="space-y-2">
        <input className="input font-display text-lg" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Plan name" />
        <textarea className="input min-h-16 text-sm" placeholder="What changes in this version?" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label="Description" />
      </div>
      <div className="space-y-2">
        <select className="input" value={draft.tier} onChange={(e) => setDraft({ ...draft, tier: e.target.value as Scenario["tier"] })} aria-label="Level">
          <option value="base">As it stands</option>
          {TIERS.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
        {isBase && config.claude && floorplans.length > 0 && (
          <button
            className="btn-ghost w-full"
            disabled={!!busy}
            onClick={() => confirm("Re-trace from the floor plan? This replaces the current layout of this plan.") && run("trace", () => ctx.op("trace", { author: member }))}
          >
            {busy === "trace" ? <><Spinner /> Tracing…</> : "Re-trace floor plan"}
          </button>
        )}
        <button
          className="btn-quiet w-full text-brick"
          onClick={() => confirm(`Delete “${draft.name}”?`) && run("del", () => ctx.op("deleteScenario", { scenarioId: draft.id }))}
        >
          Delete plan
        </button>
      </div>
    </div>
  );
}

// ─── Inspector ────────────────────────────────────────────────────────────

function Inspector(props: {
  layout: Layout;
  floor: Floor;
  selection: Selection;
  setSelection: (s: Selection) => void;
  updateRoom: (id: string, patch: Partial<Room>) => void;
  removeRoom: (id: string) => void;
  setLayout: (l: Layout) => void;
  setFloorId: (id: string) => void;
  addRoom: () => void;
}) {
  const { layout, floor, selection, updateRoom, removeRoom, setLayout, setFloorId } = props;
  const room = selection?.kind === "room" ? floor.rooms.find((r) => r.id === selection.id) : undefined;
  const wall = selection?.kind === "wall" ? deriveWalls(floor, layout).find((s) => s.key === selection.key) : undefined;

  if (room) {
    const num = (k: "x" | "y" | "w" | "d", label: string) => (
      <div>
        <label className="label" htmlFor={`r-${k}`}>{label}</label>
        <input
          id={`r-${k}`}
          className="input font-mono"
          type="number"
          step={0.05}
          min={k === "w" || k === "d" ? 0.5 : undefined}
          value={room[k]}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) updateRoom(room.id, { [k]: Math.round(v * 100) / 100 });
          }}
        />
      </div>
    );
    return (
      <div className="card space-y-3 p-4">
        <div className="flex items-center justify-between">
          <p className="eyebrow">Room</p>
          <button className="text-xs text-ink-3 hover:text-ink" onClick={() => props.setSelection(null)}>Done</button>
        </div>
        <input className="input font-semibold" value={room.name} onChange={(e) => updateRoom(room.id, { name: e.target.value })} aria-label="Room name" />
        <select className="input" value={room.type} onChange={(e) => updateRoom(room.id, { type: e.target.value as Room["type"] })} aria-label="Room type">
          {ROOM_TYPES.map((t) => <option key={t} value={t}>{ROOM_LABEL[t]}</option>)}
        </select>
        <div className="grid grid-cols-2 gap-2">
          {num("w", "Width (m)")}
          {num("d", "Depth (m)")}
          {num("x", "Left (m)")}
          {num("y", "Top (m)")}
        </div>
        <p className="font-mono text-xs text-ink-3">{(room.w * room.d).toFixed(1)} m² · {(room.w * room.d * 10.764).toFixed(0)} ft²</p>
        <div>
          <span className="label">Wall colour</span>
          <div className="flex flex-wrap gap-1.5">
            {PAINTS.map((c) => (
              <button
                key={c}
                className={`h-7 w-7 rounded-full border ${room.finish?.wall === c ? "ring-2 ring-blueprint ring-offset-2" : "border-line"}`}
                style={{ background: c }}
                aria-label={`Paint ${c}`}
                onClick={() => updateRoom(room.id, { finish: { ...room.finish, wall: c } })}
              />
            ))}
            <input type="color" className="h-7 w-9 cursor-pointer rounded border border-line bg-white" value={room.finish?.wall ?? "#eee8dd"} onChange={(e) => updateRoom(room.id, { finish: { ...room.finish, wall: e.target.value } })} aria-label="Custom colour" />
          </div>
        </div>
        <div>
          <span className="label">Floor</span>
          <div className="flex flex-wrap gap-1">
            {FLOOR_FINISHES.map((f) => (
              <button key={f} onClick={() => updateRoom(room.id, { finish: { ...room.finish, floor: f } })} className={`rounded-full border px-2.5 py-0.5 text-xs capitalize ${room.finish?.floor === f ? "border-ink bg-ink text-paper" : "border-line text-ink-2 hover:border-ink-3"}`}>
                {f}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!room.isNew} onChange={(e) => updateRoom(room.id, { isNew: e.target.checked || undefined })} />
          New build (counts as extension)
        </label>
        <button className="btn-quiet w-full text-brick" onClick={() => removeRoom(room.id)}>Remove room</button>
      </div>
    );
  }

  if (wall) {
    const names = [wall.sideA, wall.sideB].map((id) => (id ? floor.rooms.find((r) => r.id === id)?.name : "Outside") ?? "Outside");
    return (
      <div className="card space-y-3 p-4">
        <div className="flex items-center justify-between">
          <p className="eyebrow">{wall.party ? "Party wall" : wall.exterior ? "External wall" : "Internal wall"}</p>
          <button className="text-xs text-ink-3 hover:text-ink" onClick={() => props.setSelection(null)}>Done</button>
        </div>
        <p className="text-sm">
          {names[0]} ↔ {names[1]} · <span className="font-mono">{wall.length.toFixed(2)} m</span>
        </p>
        {wall.party ? (
          <p className="text-sm text-ink-2">Shared with the neighbours — no openings. Change which sides are attached in the floor settings.</p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {WALL_STATES.filter((s) => !(wall.exterior && s.id === "open")).map((s) => (
              <button
                key={s.id}
                onClick={() => setLayout({ ...layout, wallStates: { ...layout.wallStates, [wall.key]: s.id } })}
                className={`rounded-md border px-2 py-1.5 text-xs font-medium ${wall.state === s.id ? "border-ink bg-ink text-paper" : "border-line hover:border-ink-3"}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        {!wall.exterior && wall.state === "open" && (
          <p className="text-xs text-ink-3">If this wall is load-bearing it will need a steel beam and building control sign-off — the 3D view shows a downstand where the beam would sit.</p>
        )}
        {layout.wallStates[wall.key] && layout.wallStates[wall.key] !== wall.defaultState && (
          <button
            className="text-xs text-blueprint hover:underline"
            onClick={() => {
              const ws = { ...layout.wallStates };
              delete ws[wall.key];
              setLayout({ ...layout, wallStates: ws });
            }}
          >
            Reset to automatic
          </button>
        )}
      </div>
    );
  }

  const toggleSide = (side: PlanSide) => {
    const cur = new Set(layout.attached ?? []);
    if (cur.has(side)) cur.delete(side);
    else cur.add(side);
    setLayout({ ...layout, attached: [...cur] });
  };
  return (
    <div className="card space-y-3 p-4">
      <p className="eyebrow">Floor &amp; house</p>
      <input className="input" value={floor.name} onChange={(e) => setLayout({ ...layout, floors: layout.floors.map((f) => (f.id === floor.id ? { ...f, name: e.target.value } : f)) })} aria-label="Floor name" />
      <div className="flex flex-wrap gap-2">
        <button
          className="btn-ghost py-1 text-xs"
          onClick={() => {
            const top = Math.max(...layout.floors.map((f) => f.level));
            const f: Floor = { id: newId("f"), name: top < 0 ? "Ground floor" : top === 0 ? "First floor" : top === 1 ? "Second floor" : top === 2 ? "Attic" : `Level ${top + 1}`, level: top + 1, rooms: [] };
            setLayout({ ...layout, floors: [...layout.floors, f] });
            setFloorId(f.id);
          }}
        >
          + Floor above
        </button>
        {layout.floors.length > 1 && (
          <button
            className="btn-quiet py-1 text-xs text-brick"
            onClick={() => {
              if (!confirm(`Remove ${floor.name} and its rooms?`)) return;
              const rest = layout.floors.filter((f) => f.id !== floor.id);
              setLayout({ ...layout, floors: rest });
              setFloorId(rest[0].id);
            }}
          >
            Remove floor
          </button>
        )}
      </div>
      <div>
        <span className="label">Joined to neighbours on</span>
        <div className="flex flex-wrap gap-1">
          {(["left", "right", "top", "bottom"] as PlanSide[]).map((s) => (
            <button key={s} onClick={() => toggleSide(s)} className={`rounded-full border px-2.5 py-0.5 text-xs capitalize ${layout.attached?.includes(s) ? "border-ink bg-ink text-paper" : "border-line text-ink-2"}`}>
              {s}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-ink-3">Terrace: left + right. Semi: one side. Detached: none.</p>
      </div>
      <div>
        <label className="label" htmlFor="ceil">Ceiling height (m)</label>
        <input id="ceil" className="input font-mono" type="number" step={0.05} min={2} max={4} value={layout.ceilingHeight} onChange={(e) => { const v = parseFloat(e.target.value); if (v >= 2 && v <= 5) setLayout({ ...layout, ceilingHeight: v }); }} />
      </div>
      <p className="text-xs text-ink-3">Select a room or wall on the plan to edit it.</p>
    </div>
  );
}

// ─── Numbers & costs ──────────────────────────────────────────────────────

function Numbers({ stats, baseStats, isBase }: { stats: ReturnType<typeof layoutStats>; baseStats: ReturnType<typeof layoutStats>; isBase: boolean }) {
  const delta = (a: number, b: number, unit = "") => {
    if (isBase) return null;
    const d = Math.round((a - b) * 10) / 10;
    if (!d) return <span className="text-ink-3">—</span>;
    return <span className={d > 0 ? "text-sage" : "text-brick"}>{d > 0 ? "+" : ""}{d}{unit}</span>;
  };
  const row = (label: string, v: React.ReactNode, d: React.ReactNode) => (
    <tr className="border-t border-line-2">
      <td className="py-1.5 text-ink-2">{label}</td>
      <td className="py-1.5 text-right font-mono">{v}</td>
      {!isBase && <td className="w-16 py-1.5 text-right font-mono text-xs">{d}</td>}
    </tr>
  );
  return (
    <div className="card p-4">
      <p className="eyebrow">{isBase ? "The house today" : "Versus today"}</p>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {row("Internal area", `${stats.totalArea} m²`, delta(stats.totalArea, baseStats.totalArea, "m²"))}
          {stats.floors.map((f) => row(`· ${f.name}`, `${f.area} m²`, delta(f.area, baseStats.floors.find((b) => b.id === f.id)?.area ?? 0)))}
          {row("Bedrooms", stats.bedrooms, delta(stats.bedrooms, baseStats.bedrooms))}
          {row("Bathrooms", stats.bathrooms, delta(stats.bathrooms, baseStats.bathrooms))}
          {row("Open-plan links", stats.openedWalls, delta(stats.openedWalls, baseStats.openedWalls))}
          {!isBase && row("New-build area", `${stats.newArea} m²`, null)}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-3">Areas are room-by-room internal floor area from the plan model — approximate, walls excluded.</p>
    </div>
  );
}

function Costs({ base, layout }: { base: Layout; layout: Layout }) {
  const [rates, setRates] = useState<Rates>(DEFAULT_RATES);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("hh_rates");
      if (saved) setRates({ ...DEFAULT_RATES, ...JSON.parse(saved) });
    } catch {
      /* ignore */
    }
  }, []);
  const saveRates = (r: Rates) => {
    setRates(r);
    try {
      localStorage.setItem("hh_rates", JSON.stringify(r));
    } catch {
      /* ignore */
    }
  };
  const lines = useMemo(() => costLines(base, layout, rates), [base, layout, rates]);
  const total = lines.reduce((s, l) => ({ low: s.low + l.low, high: s.high + l.high }), { low: 0, high: 0 });
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Rough build cost</p>
        <button className="text-xs text-blueprint hover:underline" onClick={() => setEditing((v) => !v)}>{editing ? "Done" : "Edit rates"}</button>
      </div>
      {editing ? (
        <div className="mt-3 space-y-2">
          {(Object.keys(RATE_LABELS) as (keyof Rates)[]).map((k) => (
            <div key={k}>
              <span className="text-xs text-ink-2">{RATE_LABELS[k].label} <span className="text-ink-3">({RATE_LABELS[k].unit})</span></span>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {(["low", "high"] as const).map((lh) => (
                  <input key={lh} className="input py-1 font-mono text-xs" type="number" min={0} value={rates[k][lh]} aria-label={`${RATE_LABELS[k].label} ${lh}`} onChange={(e) => saveRates({ ...rates, [k]: { ...rates[k], [lh]: Number(e.target.value) || 0 } })} />
                ))}
              </div>
            </div>
          ))}
          <button className="text-xs text-ink-3 hover:text-ink" onClick={() => saveRates(DEFAULT_RATES)}>Reset to defaults</button>
        </div>
      ) : lines.length ? (
        <>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {lines.map((l) => (
                <tr key={l.key} className="border-t border-line-2">
                  <td className="py-1.5 text-ink-2">{RATE_LABELS[l.key].label}<span className="block font-mono text-[11px] text-ink-3">{l.qty} {l.unit}</span></td>
                  <td className="py-1.5 text-right font-mono text-xs">{formatGBP(l.low)}–{formatGBP(l.high)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-ink">
                <td className="py-2 font-semibold">Total (build only)</td>
                <td className="py-2 text-right font-mono font-semibold">{formatGBP(total.low)}–{formatGBP(total.high)}</td>
              </tr>
            </tbody>
          </table>
        </>
      ) : (
        <p className="mt-2 text-sm text-ink-3">No building work detected versus today yet.</p>
      )}
      <p className="mt-2 text-xs text-ink-3">Starting assumptions, not quotes — excludes kitchens, bathrooms, fees, VAT and contingency. Replace the rates with your builder&rsquo;s numbers.</p>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────

function EmptyPlans({ ctx }: { ctx: WorkspaceCtx }) {
  const { config, member } = useApp();
  const { busy, error, run } = useBusy();
  const floorplans = ctx.p.photos.filter((ph) => ph.kind === "floorplan");
  return (
    <div className="card grid gap-8 p-6 sm:p-8 md:grid-cols-2">
      <div>
        <p className="eyebrow">Step one</p>
        <h2 className="mt-1 font-display text-2xl">Get the current layout into the model</h2>
        <p className="mt-2 text-sm text-ink-2">
          Everything else — knocking through, extending, the 3D walkthrough, the numbers — builds on an editable model of the house as it is today.
        </p>
        <div className="mt-5 space-y-3">
          <button
            className="btn-primary w-full justify-start"
            disabled={!config.claude || !floorplans.length || !!busy}
            onClick={() => run("trace", () => ctx.op("trace", { author: member }))}
          >
            {busy === "trace" ? <><Spinner /> Reading the floor plan (up to a minute)…</> : "Trace the floor plan with Claude"}
          </button>
          {!floorplans.length && <p className="text-xs text-ink-3">Upload the agent&rsquo;s floor plan on the Overview tab first.</p>}
          {!config.claude && <p className="text-xs text-ink-3">Needs an ANTHROPIC_API_KEY on the server.</p>}
          <button
            className="btn-ghost w-full justify-start"
            disabled={!!busy}
            onClick={() => run("blank", () => ctx.op("createScenario", { name: "As it stands", tier: "base", description: "Sketched by hand.", author: member }))}
          >
            Sketch it by hand
          </button>
          <ErrorNote error={error} />
        </div>
      </div>
      {floorplans[0] ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={fileUrl(floorplans[0].file)} alt="Floor plan" className="w-full rounded-lg border border-line bg-white" />
      ) : (
        <div className="grid place-items-center rounded-lg border border-dashed border-line p-8 text-center text-sm text-ink-3">No floor plan uploaded yet.</div>
      )}
    </div>
  );
}
