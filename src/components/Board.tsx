"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ClientConfig } from "@/lib/config";
import { STATUSES, type Property, type PropertyStatus } from "@/lib/types";
import { api, AppProvider, ErrorNote, fileUrl, MemberSwitch, Spinner, Stars, timeAgo, useApp, useBusy } from "./client";
import PlanEditor from "./PlanEditor";

export default function Board({ config, initial }: { config: ClientConfig; initial: Property[] }) {
  return (
    <AppProvider config={config}>
      <BoardInner initial={initial} />
    </AppProvider>
  );
}

export function Masthead({ children }: { children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-paper/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="font-display text-xl font-semibold tracking-tight">House Hunt</span>
          <span className="eyebrow hidden sm:inline">our shortlist &amp; what it could be</span>
        </Link>
        <div className="ml-auto flex items-center gap-3">
          {children}
          <MemberSwitch />
        </div>
      </div>
    </header>
  );
}

const STATUS_STYLE: Record<PropertyStatus, string> = {
  viewing: "border-line bg-card text-ink-2",
  shortlisted: "border-sage/40 bg-sage-2 text-sage",
  offer: "border-brick/30 bg-brick/10 text-brick-2",
  passed: "border-line bg-line-2 text-ink-3",
};

export function StatusChip({ status }: { status: PropertyStatus }) {
  return <span className={`chip ${STATUS_STYLE[status]}`}>{STATUSES.find((s) => s.id === status)?.label}</span>;
}

function BoardInner({ initial }: { initial: Property[] }) {
  const { config } = useApp();
  const [filter, setFilter] = useState<PropertyStatus | "all">("all");
  const [adding, setAdding] = useState(false);
  const props = initial.filter((p) => filter === "all" || p.status === filter);

  return (
    <div className="grid-paper min-h-screen">
      <Masthead>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          + Add a house
        </button>
      </Masthead>
      <main className="mx-auto max-w-7xl px-4 pt-8 pb-20 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">{initial.length} {initial.length === 1 ? "house" : "houses"} saved</p>
            <h1 className="mt-1 font-display text-3xl font-medium sm:text-4xl">The shortlist</h1>
          </div>
          {initial.length > 0 && (
            <nav className="flex flex-wrap gap-1 text-sm" aria-label="Filter by status">
              {[{ id: "all" as const, label: "All" }, ...STATUSES].map((s) => (
                <button key={s.id} onClick={() => setFilter(s.id)} className={`rounded-full px-3 py-1 ${filter === s.id ? "bg-ink text-paper" : "text-ink-2 hover:bg-line-2"}`}>
                  {s.label}
                </button>
              ))}
            </nav>
          )}
        </div>

        {initial.length === 0 ? (
          <EmptyState onAdd={() => setAdding(true)} />
        ) : (
          <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {props.map((p) => (
              <PropertyCard key={p.id} p={p} members={config.members} />
            ))}
          </div>
        )}
      </main>
      {adding && <AddDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function PropertyCard({ p, members }: { p: Property; members: string[] }) {
  const hero = p.photos.find((ph) => ph.kind === "photo") ?? p.photos[0];
  const base = p.scenarios.find((s) => s.tier === "base") ?? p.scenarios[0];
  return (
    <Link href={`/p/${p.id}`} className="card group overflow-hidden transition-shadow hover:shadow-lg hover:shadow-ink/5">
      <div className="relative aspect-[4/3] overflow-hidden border-b border-line bg-line-2">
        {hero ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl(hero.file)} alt="" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
        ) : base?.layout.floors[0]?.rooms.length ? (
          <div className="h-full w-full bg-card p-4">
            <PlanEditor layout={base.layout} floorId={base.layout.floors[0].id} compact />
          </div>
        ) : (
          <div className="grid h-full place-items-center text-ink-3">No photos yet</div>
        )}
        <div className="absolute top-3 left-3">
          <StatusChip status={p.status} />
        </div>
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-display text-lg leading-snug">{p.title}</h2>
            <p className="truncate text-sm text-ink-2">{p.address || "No address yet"}</p>
          </div>
          {p.price && <p className="shrink-0 text-right font-mono text-xs text-ink-2">{p.price}</p>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
          {p.bedrooms != null && <span>{p.bedrooms} bed</span>}
          {p.bathrooms != null && <span>{p.bathrooms} bath</span>}
          <span>{p.wishes.length} ideas</span>
          <span>{p.scenarios.length} plans</span>
          {p.renders.length > 0 && <span>{p.renders.length} visuals</span>}
          <span className="ml-auto text-ink-3">{timeAgo(p.updatedAt)}</span>
        </div>
        {members.some((m) => p.ratings[m]) && (
          <div className="mt-3 flex flex-wrap gap-x-4 border-t border-line-2 pt-3 text-xs text-ink-2">
            {members.map((m) => (
              <span key={m} className="flex items-center gap-1.5">
                {m} <Stars value={p.ratings[m] ?? 0} size="text-sm" />
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const router = useRouter();
  const { member } = useApp();
  const { busy, error, run } = useBusy();
  const demo = () =>
    run("demo", async () => {
      const p = await api<Property>("/api/properties", { method: "POST", json: { mode: "demo", author: member } });
      router.push(`/p/${p.id}`);
    });
  return (
    <div className="card mt-8 grid gap-8 p-8 sm:p-10 md:grid-cols-[1.2fr_1fr]">
      <div>
        <h2 className="font-display text-2xl">Start with a house you&rsquo;ve seen.</h2>
        <p className="mt-3 max-w-prose text-ink-2">
          Paste a PropertyPal (or Rightmove, Zoopla, agent) link and we&rsquo;ll pull in the photos, floor plan and details — or add one by hand. Then note what you&rsquo;d change, trace
          the floor plan into an editable model, try out knocking walls through or extending, and walk through the result in 3D.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button className="btn-primary" onClick={onAdd}>
            + Add a house
          </button>
          <button className="btn-ghost" onClick={demo} disabled={!!busy}>
            {busy ? <Spinner /> : null} Explore the demo house
          </button>
        </div>
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      </div>
      <ol className="space-y-4 text-sm">
        {[
          ["Save", "Photos, floor plans, price, both your ratings and viewing notes."],
          ["Imagine", "List what you'd change — refresh, reconfigure or extend — and ask Claude what's possible."],
          ["Plan", "Trace the floor plan, then knock through, add rooms and compare the numbers."],
          ["See it", "Walk through each version in 3D and generate photoreal visuals."],
        ].map(([t, d], i) => (
          <li key={t} className="flex gap-3">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line bg-paper font-mono text-xs">{i + 1}</span>
            <span>
              <strong className="font-semibold">{t}.</strong> <span className="text-ink-2">{d}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function AddDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { config } = useApp();
  const [tab, setTab] = useState<"link" | "manual">("link");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [address, setAddress] = useState("");
  const [price, setPrice] = useState("");
  const { busy, error, setError, run } = useBusy();

  const importLink = (e: React.FormEvent) => {
    e.preventDefault();
    run("import", async () => {
      const p = await api<Property>("/api/properties", { method: "POST", json: { mode: "import", url } });
      router.push(`/p/${p.id}`);
    });
  };
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    run("manual", async () => {
      const p = await api<Property>("/api/properties", { method: "POST", json: { mode: "manual", title: title || address || "New house", address, price: price || undefined, listingUrl: url || undefined } });
      router.push(`/p/${p.id}`);
    });
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/30 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="card w-full max-w-lg p-6 shadow-2xl" role="dialog" aria-modal aria-labelledby="add-title">
        <div className="flex items-center justify-between">
          <h2 id="add-title" className="font-display text-2xl">Add a house</h2>
          <button className="btn-quiet px-2" onClick={onClose} disabled={!!busy} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="mt-4 flex gap-1 rounded-lg bg-line-2 p-1 text-sm">
          {(["link", "manual"] as const).map((t) => (
            <button
              key={t}
              className={`flex-1 rounded-md py-1.5 font-medium ${tab === t ? "bg-card shadow-sm" : "text-ink-2"}`}
              onClick={() => {
                setTab(t);
                setError(null);
              }}
            >
              {t === "link" ? "From a listing link" : "Enter manually"}
            </button>
          ))}
        </div>

        {tab === "link" ? (
          <form onSubmit={importLink} className="mt-5 space-y-4">
            <div>
              <label className="label" htmlFor="url">
                Listing link
              </label>
              <input id="url" className="input" type="url" required placeholder="https://www.propertypal.com/…" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
              <p className="mt-2 text-xs text-ink-3">
                Photos and floor plans are copied into your shortlist, so they&rsquo;re kept after the listing comes down.
                {!config.claude && " Without a Claude key, import is best-effort (title, description and main images)."}
              </p>
            </div>
            <ErrorNote error={error} />
            {error && (
              <button type="button" className="text-sm text-blueprint underline" onClick={() => setTab("manual")}>
                Add it manually instead →
              </button>
            )}
            <button className="btn-primary w-full" disabled={!!busy}>
              {busy ? (
                <>
                  <Spinner /> Reading the listing and saving photos…
                </>
              ) : (
                "Import"
              )}
            </button>
          </form>
        ) : (
          <form onSubmit={create} className="mt-5 space-y-4">
            <div>
              <label className="label" htmlFor="title">
                Name
              </label>
              <input id="title" className="input" placeholder="e.g. The red-brick terrace on Ava Street" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            </div>
            <div>
              <label className="label" htmlFor="address">
                Address
              </label>
              <input id="address" className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="price">
                  Price
                </label>
                <input id="price" className="input" placeholder="£" value={price} onChange={(e) => setPrice(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="murl">
                  Listing link
                </label>
                <input id="murl" className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-ink-3">You can upload photos and the floor plan on the next screen.</p>
            <ErrorNote error={error} />
            <button className="btn-primary w-full" disabled={!!busy}>
              {busy ? <Spinner /> : null} Create
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
