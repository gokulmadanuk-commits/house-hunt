"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { ClientConfig } from "@/lib/config";
import { STATUSES, type Property, type PropertyStatus } from "@/lib/types";
import { Masthead } from "./Board";
import { api, AppProvider, runOp, Stars, useApp } from "./client";
import IdeasTab from "./IdeasTab";
import OverviewTab from "./OverviewTab";
import PlansTab from "./PlansTab";
import VisualsTab from "./VisualsTab";

export type TabId = "overview" | "ideas" | "plans" | "visuals";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "ideas", label: "Ideas" },
  { id: "plans", label: "Plans & 3D" },
  { id: "visuals", label: "Visuals" },
];

export interface Handoff {
  brief?: string;
  scenarioId?: string;
  photoId?: string;
  /** JPEG data URL of a 3D view to re-imagine. */
  snapshot?: string;
}

export interface WorkspaceCtx {
  p: Property;
  setP: (p: Property) => void;
  op: (op: string, args?: Record<string, unknown>) => Promise<Property>;
  goTo: (tab: TabId, opts?: Handoff) => void;
  handoff: Handoff;
}

export default function Workspace({ config, initial }: { config: ClientConfig; initial: Property }) {
  return (
    <AppProvider config={config}>
      <WorkspaceInner initial={initial} />
    </AppProvider>
  );
}

function WorkspaceInner({ initial }: { initial: Property }) {
  const { config, member } = useApp();
  const router = useRouter();
  const [p, setP] = useState(initial);
  const [tab, setTab] = useState<TabId>("overview");
  const [handoff, setHandoff] = useState<WorkspaceCtx["handoff"]>({});

  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.slice(1) as TabId;
      if (TABS.some((t) => t.id === h)) setTab(h);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  // Pick up the other person's changes when coming back to the tab.
  useEffect(() => {
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const fresh = await api<Property>(`/api/properties/${initial.id}`);
        setP((cur) => (fresh.updatedAt > cur.updatedAt ? fresh : cur));
      } catch {
        /* offline */
      }
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [initial.id]);

  const op = useCallback(
    async (name: string, args: Record<string, unknown> = {}) => {
      const next = await runOp(p.id, name, args);
      setP(next);
      return next;
    },
    [p.id],
  );

  const goTo: WorkspaceCtx["goTo"] = (t, opts = {}) => {
    setHandoff(opts);
    setTab(t);
    window.history.replaceState(null, "", `#${t}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const ctx: WorkspaceCtx = { p, setP, op, goTo, handoff };
  const remove = async () => {
    if (!confirm(`Delete “${p.title}” and all its photos, plans and visuals?`)) return;
    await api(`/api/properties/${p.id}`, { method: "DELETE" });
    router.push("/");
  };

  return (
    <div className="min-h-screen">
      <Masthead />
      <div className="border-b border-line bg-card">
        <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="eyebrow">{p.propertyType || "House"}{p.bedrooms != null ? ` · ${p.bedrooms} bed` : ""}{p.bathrooms != null ? ` · ${p.bathrooms} bath` : ""}</p>
              <h1 className="mt-1 font-display text-3xl leading-tight font-medium sm:text-4xl">{p.title}</h1>
              <p className="mt-1 text-ink-2">
                {p.address}
                {p.price && <span className="ml-3 font-mono text-sm text-ink">{p.price}</span>}
                {p.listingUrl && (
                  <a href={p.listingUrl} target="_blank" rel="noreferrer" className="ml-3 text-sm text-blueprint underline-offset-2 hover:underline">
                    Listing ↗
                  </a>
                )}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <select
                className="input w-auto py-1.5"
                value={p.status}
                onChange={(e) => op("update", { fields: { status: e.target.value as PropertyStatus } })}
                aria-label="Status"
              >
                {STATUSES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap justify-end gap-x-4 text-sm text-ink-2">
                {config.members.map((m) => (
                  <span key={m} className="flex items-center gap-1.5">
                    {m}
                    <Stars value={p.ratings[m] ?? 0} onChange={m === member ? (v) => op("rate", { member: m, value: v }) : undefined} />
                  </span>
                ))}
              </div>
            </div>
          </div>
          <nav className="-mb-px mt-5 flex gap-1 overflow-x-auto" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => goTo(t.id)}
                className={`border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${tab === t.id ? "border-brick text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
              >
                {t.label}
                <TabCount p={p} id={t.id} />
              </button>
            ))}
          </nav>
        </div>
      </div>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {tab === "overview" && <OverviewTab ctx={ctx} onDelete={remove} />}
        {tab === "ideas" && <IdeasTab ctx={ctx} />}
        {tab === "plans" && <PlansTab ctx={ctx} />}
        {tab === "visuals" && <VisualsTab ctx={ctx} />}
      </main>
    </div>
  );
}

function TabCount({ p, id }: { p: Property; id: TabId }) {
  const n = id === "overview" ? p.photos.length : id === "ideas" ? p.wishes.length : id === "plans" ? p.scenarios.length : p.renders.length;
  if (!n) return null;
  return <span className="ml-1.5 rounded-full bg-line-2 px-1.5 py-px font-mono text-[10px] text-ink-2">{n}</span>;
}
