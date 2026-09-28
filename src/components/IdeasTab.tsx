"use client";

import { useState } from "react";
import { TIERS, type Idea, type Tier, type Wish } from "@/lib/types";
import { ErrorNote, Spinner, timeAgo, useApp, useBusy } from "./client";
import type { WorkspaceCtx } from "./Workspace";

export const TIER_STYLE: Record<Tier | "base", { chip: string; bar: string; dot: string }> = {
  base: { chip: "border-line bg-card text-ink-2", bar: "bg-ink-3", dot: "bg-ink-3" },
  refresh: { chip: "border-sage/40 bg-sage-2 text-sage", bar: "bg-sage", dot: "bg-sage" },
  reconfigure: { chip: "border-blueprint/30 bg-blueprint-2 text-blueprint", bar: "bg-blueprint", dot: "bg-blueprint" },
  extend: { chip: "border-brick/30 bg-brick/10 text-brick-2", bar: "bg-brick", dot: "bg-brick" },
};

const PRIORITY: Record<Wish["priority"], { label: string; cls: string }> = {
  must: { label: "Must", cls: "border-ink/20 bg-ink text-paper" },
  nice: { label: "Nice", cls: "border-line bg-card text-ink-2" },
  dream: { label: "Dream", cls: "border-ochre/40 bg-ochre-2 text-ochre" },
};

export default function IdeasTab({ ctx }: { ctx: WorkspaceCtx }) {
  const { config, member } = useApp();
  const { p, op, goTo } = ctx;
  const { busy, error, setError, run } = useBusy();
  const base = p.scenarios.find((s) => s.tier === "base") ?? p.scenarios[0];
  const roomNames = [...new Set(base?.layout.floors.flatMap((f) => f.rooms.map((r) => r.name)) ?? [])];

  const draftPlan = (key: string, args: { ideaId?: string; brief?: string }) =>
    run(key, async () => {
      const before = new Set(p.scenarios.map((s) => s.id));
      const next = await op("propose", { author: member, ...args });
      const created = next.scenarios.find((s) => !before.has(s.id));
      goTo("plans", { scenarioId: created?.id });
    });

  return (
    <div className="space-y-8">
      <Wishlist ctx={ctx} roomNames={roomNames} onDraft={(w) => draftPlan(`wish-${w.id}`, { brief: `${w.room ? w.room + ": " : ""}${w.text}` })} busy={busy} canDraft={config.claude && !!base} />
      <ErrorNote error={error} onClose={() => setError(null)} />

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow">Claude as your architect</p>
            <h2 className="mt-1 font-display text-2xl">What&rsquo;s possible here?</h2>
            <p className="mt-1 max-w-2xl text-sm text-ink-2">
              Reads the photos, floor plan, your wishes and viewing notes, then suggests what could be done at each level — with rough cost bands, likely consents and what to check before offering.
            </p>
          </div>
          <button className="btn-primary" disabled={!config.claude || !!busy} onClick={() => run("analyse", () => op("analyse"))}>
            {busy === "analyse" ? (
              <>
                <Spinner /> Thinking it through (about a minute)…
              </>
            ) : p.analysis ? (
              "Ask again"
            ) : (
              "Ask Claude"
            )}
          </button>
        </div>
        {!config.claude && <p className="mt-3 text-sm text-ink-3">Add an ANTHROPIC_API_KEY to the server&rsquo;s environment to turn this on.</p>}

        {p.analysis && (
          <div className="mt-5 space-y-5">
            <div className="card border-l-4 border-l-ink p-5">
              <p className="font-display text-lg leading-relaxed">{p.analysis.overview}</p>
              <p className="mt-2 text-xs text-ink-3">Generated {timeAgo(p.analysis.createdAt)} · cost bands are indicative only, not quotes</p>
            </div>
            <div className="grid gap-5 lg:grid-cols-3">
              {TIERS.map((t) => (
                <div key={t.id}>
                  <TierHeading tier={t.id} />
                  <div className="mt-3 space-y-3">
                    {p.analysis!.ideas.filter((i) => i.tier === t.id).map((i) => (
                      <IdeaCard
                        key={i.id}
                        idea={i}
                        busy={busy}
                        canDraft={!!base && i.tier !== "refresh"}
                        onDraft={() => draftPlan(`idea-${i.id}`, { ideaId: i.id })}
                        onVisualise={() => goTo("visuals", { brief: i.visualBrief })}
                        onWish={() => run(`w-${i.id}`, () => op("addWish", { author: member, tier: i.tier, room: i.rooms[0], text: i.title + " — " + i.summary, priority: "nice" }))}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {p.analysis.caveats.length > 0 && (
              <div className="card p-5">
                <h3 className="font-display text-lg">Before you offer, check</h3>
                <ul className="mt-2 space-y-1.5 text-sm text-ink-2">
                  {p.analysis.caveats.map((c) => (
                    <li key={c} className="flex gap-2">
                      <span className="text-brick">□</span>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function TierHeading({ tier }: { tier: Tier }) {
  const t = TIERS.find((x) => x.id === tier)!;
  return (
    <div className="flex items-start gap-3">
      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${TIER_STYLE[tier].dot}`} />
      <div>
        <h3 className="font-display text-lg leading-tight">{t.label}</h3>
        <p className="text-xs text-ink-3">{t.blurb}</p>
      </div>
    </div>
  );
}

function IdeaCard({ idea, busy, canDraft, onDraft, onVisualise, onWish }: { idea: Idea; busy: string | null; canDraft: boolean; onDraft: () => void; onVisualise: () => void; onWish: () => void }) {
  return (
    <article className="card overflow-hidden">
      <div className={`h-1 ${TIER_STYLE[idea.tier].bar}`} />
      <div className="p-4">
        <h4 className="font-semibold leading-snug">{idea.title}</h4>
        <p className="mt-1.5 text-sm text-ink-2">{idea.summary}</p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-ink-3">Cost</dt>
          <dd className="font-mono">{idea.costBand}</dd>
          <dt className="text-ink-3">Effort</dt>
          <dd className="capitalize">{idea.complexity}</dd>
        </dl>
        <details className="mt-2 text-xs text-ink-2">
          <summary className="cursor-pointer text-ink-3 hover:text-ink">Impact, consents &amp; risks</summary>
          <p className="mt-2"><strong className="text-ink">Impact.</strong> {idea.impact}</p>
          <p className="mt-1.5"><strong className="text-ink">Consents.</strong> {idea.permissions}</p>
          <p className="mt-1.5"><strong className="text-ink">Risks.</strong> {idea.risks}</p>
        </details>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {canDraft && (
            <button className="btn-ghost px-2.5 py-1 text-xs" disabled={!!busy} onClick={onDraft}>
              {busy === `idea-${idea.id}` ? <><Spinner /> Drawing…</> : "Draft as a plan"}
            </button>
          )}
          <button className="btn-ghost px-2.5 py-1 text-xs" onClick={onVisualise}>Visualise</button>
          <button className="btn-quiet px-2.5 py-1 text-xs" disabled={!!busy} onClick={onWish}>+ Wishlist</button>
        </div>
      </div>
    </article>
  );
}

function Wishlist({ ctx, roomNames, onDraft, busy: outerBusy, canDraft }: { ctx: WorkspaceCtx; roomNames: string[]; onDraft: (w: Wish) => void; busy: string | null; canDraft: boolean }) {
  const { member } = useApp();
  const { p, op } = ctx;
  const [tier, setTier] = useState<Tier>("refresh");
  const [room, setRoom] = useState("");
  const [text, setText] = useState("");
  const [priority, setPriority] = useState<Wish["priority"]>("nice");
  const { busy, error, run } = useBusy();

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    run("add", async () => {
      await op("addWish", { author: member, tier, room: room || undefined, text: text.trim(), priority });
      setText("");
    });
  };

  return (
    <section>
      <p className="eyebrow">Our wishlist</p>
      <h2 className="mt-1 font-display text-2xl">What would we change?</h2>
      <form onSubmit={add} className="card mt-4 grid gap-3 p-4 md:grid-cols-[auto_1fr_auto] md:items-end">
        <div>
          <span className="label">Level</span>
          <div className="flex gap-1 rounded-lg bg-line-2 p-1 text-sm">
            {TIERS.map((t) => (
              <button type="button" key={t.id} onClick={() => setTier(t.id)} className={`rounded-md px-2.5 py-1 font-medium ${tier === t.id ? "bg-card shadow-sm" : "text-ink-2"}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
          <div>
            <label className="label" htmlFor="wish-room">Room</label>
            <input id="wish-room" className="input" list="rooms" placeholder="Any" value={room} onChange={(e) => setRoom(e.target.value)} />
            <datalist id="rooms">{roomNames.map((r) => <option key={r} value={r} />)}</datalist>
          </div>
          <div>
            <label className="label" htmlFor="wish-text">Idea</label>
            <input id="wish-text" className="input" placeholder={tier === "refresh" ? "e.g. Sage green kitchen, brass handles, oak worktops" : tier === "reconfigure" ? "e.g. Knock kitchen through to dining" : "e.g. Single-storey rear extension with roof lights"} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2">
          <select className="input w-auto" value={priority} onChange={(e) => setPriority(e.target.value as Wish["priority"])} aria-label="Priority">
            <option value="must">Must</option>
            <option value="nice">Nice</option>
            <option value="dream">Dream</option>
          </select>
          <button className="btn-primary" disabled={!!busy || !text.trim()}>Add</button>
        </div>
      </form>
      <ErrorNote error={error} />
      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        {TIERS.map((t) => {
          const wishes = p.wishes.filter((w) => w.tier === t.id);
          return (
            <div key={t.id}>
              <TierHeading tier={t.id} />
              <ul className="mt-3 space-y-2">
                {wishes.map((w) => (
                  <li key={w.id} className="group card p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className={`chip ${PRIORITY[w.priority].cls}`}>{PRIORITY[w.priority].label}</span>
                      {w.room && <span className="chip border-line bg-paper text-ink-2">{w.room}</span>}
                      <span className="ml-auto text-ink-3">{w.author}</span>
                    </div>
                    <p className="mt-2">{w.text}</p>
                    <div className="mt-2 flex gap-3 text-xs opacity-70 group-hover:opacity-100">
                      {canDraft && t.id !== "refresh" && (
                        <button className="text-blueprint hover:underline disabled:opacity-50" disabled={!!outerBusy} onClick={() => onDraft(w)}>
                          {outerBusy === `wish-${w.id}` ? "Drawing…" : "Draft as a plan"}
                        </button>
                      )}
                      <button className="text-ink-3 hover:text-brick" onClick={() => op("deleteWish", { wishId: w.id })}>Remove</button>
                    </div>
                  </li>
                ))}
                {!wishes.length && <li className="rounded-lg border border-dashed border-line p-3 text-xs text-ink-3">Nothing yet.</li>}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
