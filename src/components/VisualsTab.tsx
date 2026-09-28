"use client";

import { useState } from "react";
import type { Render } from "@/lib/types";
import { ErrorNote, fileUrl, Spinner, timeAgo, useApp, useBusy } from "./client";
import type { WorkspaceCtx } from "./Workspace";

export default function VisualsTab({ ctx }: { ctx: WorkspaceCtx }) {
  const { config, member } = useApp();
  const { p, op, handoff } = ctx;
  const photos = p.photos.filter((ph) => ph.kind === "photo");
  const [snapshot, setSnapshot] = useState<string | undefined>(handoff.snapshot);
  const [photoId, setPhotoId] = useState<string | undefined>(handoff.snapshot ? undefined : handoff.photoId ?? photos[0]?.id);
  const [brief, setBrief] = useState(handoff.brief ?? "");
  const [scenarioId, setScenarioId] = useState<string | undefined>(handoff.scenarioId);
  const { busy, error, setError, run } = useBusy();
  const ready = config.claude && !!config.images;

  const generate = (e: React.FormEvent) => {
    e.preventDefault();
    run("render", () => op("render", { author: member, brief, photoId: snapshot ? undefined : photoId, snapshot, scenarioId }));
  };

  const suggestions = [
    ...p.wishes.map((w) => (w.room ? `${w.room}: ${w.text}` : w.text)),
    ...(p.analysis?.ideas.map((i) => i.visualBrief) ?? []),
  ].slice(0, 12);

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <form onSubmit={generate} className="card h-fit space-y-4 p-4 sm:p-5 lg:sticky lg:top-20">
        <div>
          <p className="eyebrow">New visual</p>
          <h2 className="mt-1 font-display text-2xl">Show us what it could be</h2>
        </div>

        <div>
          <span className="label">Start from</span>
          {snapshot && (
            <button type="button" onClick={() => setPhotoId(undefined)} className="relative mb-2 block w-full overflow-hidden rounded-lg border-2 border-blueprint">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={snapshot} alt="3D view" className="aspect-video w-full object-cover" />
              <span className="absolute top-2 left-2 chip border-blueprint/30 bg-card text-blueprint">3D view</span>
              <span
                role="button"
                tabIndex={0}
                className="absolute top-2 right-2 rounded-full bg-card px-2 text-xs text-ink-2"
                onClick={(e) => {
                  e.stopPropagation();
                  setSnapshot(undefined);
                  setPhotoId(photos[0]?.id);
                }}
              >
                ✕
              </span>
            </button>
          )}
          {!snapshot && (
            photos.length ? (
              <div className="grid max-h-56 grid-cols-4 gap-1.5 overflow-y-auto">
                {photos.map((ph) => (
                  <button type="button" key={ph.id} onClick={() => setPhotoId(ph.id)} className={`overflow-hidden rounded-md border-2 ${photoId === ph.id ? "border-blueprint" : "border-transparent"}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={fileUrl(ph.file)} alt={ph.caption || ""} className="aspect-square w-full object-cover" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-3">Add photos on the Overview tab, or use “Make this view photoreal” from the 3D view of a plan.</p>
            )
          )}
          {!snapshot && <p className="mt-1.5 text-xs text-ink-3">Tip: for rooms that don&rsquo;t exist yet, open a plan in 3D or Walk through, frame a view, and press “Make this view photoreal”.</p>}
        </div>

        <div>
          <label className="label" htmlFor="brief">What should change?</label>
          <textarea id="brief" className="input min-h-28" required placeholder="e.g. Knock through to the dining room, sage shaker kitchen with oak worktops, pale limestone floor, big roof lantern" value={brief} onChange={(e) => setBrief(e.target.value)} />
          {suggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {suggestions.map((s) => (
                <button type="button" key={s} className="max-w-full truncate rounded-full border border-line px-2 py-0.5 text-left text-[11px] text-ink-2 hover:border-ink-3" title={s} onClick={() => setBrief((b) => (b ? `${b}\n${s}` : s))}>
                  + {s.length > 48 ? s.slice(0, 46) + "…" : s}
                </button>
              ))}
            </div>
          )}
        </div>

        {p.scenarios.length > 0 && (
          <div>
            <label className="label" htmlFor="scn">For plan (optional)</label>
            <select id="scn" className="input" value={scenarioId ?? ""} onChange={(e) => setScenarioId(e.target.value || undefined)}>
              <option value="">—</option>
              {p.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}

        <ErrorNote error={error} onClose={() => setError(null)} />
        <button className="btn-primary w-full" disabled={!ready || !!busy || (!photoId && !snapshot) || brief.trim().length < 3}>
          {busy ? <><Spinner /> Claude is writing the brief, then rendering (30–90s)…</> : "Generate visual"}
        </button>
        {!ready && (
          <p className="text-xs text-ink-3">
            Needs {!config.claude ? "ANTHROPIC_API_KEY" : ""}{!config.claude && !config.images ? " and " : ""}{!config.images ? "GEMINI_API_KEY or OPENAI_API_KEY" : ""} on the server.
          </p>
        )}
      </form>

      <section>
        {p.renders.length ? (
          <div className="space-y-6">
            {p.renders.map((r) => (
              <RenderCard key={r.id} r={r} onDelete={() => confirm("Delete this visual?") && op("deleteRender", { renderId: r.id })} scenarioName={p.scenarios.find((s) => s.id === r.scenarioId)?.name} />
            ))}
          </div>
        ) : (
          <div className="grid h-full min-h-72 place-items-center rounded-xl border border-dashed border-line p-8 text-center text-sm text-ink-2">
            <div className="max-w-sm">
              <p className="font-display text-xl text-ink">No visuals yet</p>
              <p className="mt-2">Pick a photo, describe the change, and Claude writes a precise brief for the image model — keeping the camera, windows and proportions true to the real room.</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function RenderCard({ r, onDelete, scenarioName }: { r: Render; onDelete: () => void; scenarioName?: string }) {
  const [split, setSplit] = useState(50);
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <article className="card overflow-hidden">
      <div className="relative select-none bg-ink">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={fileUrl(r.file)} alt={r.brief} className="block w-full" />
        {r.sourceFile && (
          <>
            <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fileUrl(r.sourceFile)} alt="Before" className="h-full w-full object-cover" />
            </div>
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${split}%` }} />
            <span className="absolute top-3 left-3 chip border-transparent bg-ink/70 text-white">Before</span>
            <span className="absolute top-3 right-3 chip border-transparent bg-brick text-white">After</span>
            <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} className="absolute inset-x-4 bottom-3 accent-brick" aria-label="Before / after" />
          </>
        )}
      </div>
      <div className="p-4">
        <p className="text-sm whitespace-pre-wrap">{r.brief}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
          <span>{r.createdBy} · {timeAgo(r.createdAt)}</span>
          {scenarioName && <span>Plan: {scenarioName}</span>}
          <span className="font-mono">{r.provider}</span>
          <button className="hover:text-ink" onClick={() => setShowPrompt((v) => !v)}>{showPrompt ? "Hide" : "Show"} prompt</button>
          <a className="hover:text-ink" href={fileUrl(r.file)} download>Download</a>
          <button className="ml-auto hover:text-brick" onClick={onDelete}>Delete</button>
        </div>
        {showPrompt && <p className="mt-2 rounded-md bg-paper p-3 font-mono text-xs text-ink-2">{r.prompt}</p>}
      </div>
    </article>
  );
}
