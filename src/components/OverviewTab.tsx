"use client";

import { useRef, useState } from "react";
import type { Photo, Property } from "@/lib/types";
import { api, ErrorNote, fileUrl, Spinner, timeAgo, useApp, useBusy } from "./client";
import type { WorkspaceCtx } from "./Workspace";

export default function OverviewTab({ ctx, onDelete }: { ctx: WorkspaceCtx; onDelete: () => void }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Gallery ctx={ctx} />
      <div className="space-y-6">
        <Notes ctx={ctx} />
        <Details ctx={ctx} onDelete={onDelete} />
      </div>
    </div>
  );
}

function Gallery({ ctx }: { ctx: WorkspaceCtx }) {
  const { p, setP, goTo } = ctx;
  const [filter, setFilter] = useState<"photo" | "floorplan">("photo");
  const [open, setOpen] = useState<Photo | null>(null);
  const { busy, error, setError, run } = useBusy();
  const photoInput = useRef<HTMLInputElement>(null);
  const planInput = useRef<HTMLInputElement>(null);
  const items = p.photos.filter((ph) => ph.kind === filter);
  const counts = { photo: p.photos.filter((x) => x.kind === "photo").length, floorplan: p.photos.filter((x) => x.kind === "floorplan").length };

  const upload = (files: FileList | null, kind: "photo" | "floorplan") => {
    if (!files?.length) return;
    run("upload", async () => {
      const form = new FormData();
      form.set("kind", kind);
      for (const f of Array.from(files)) form.append("files", f);
      setP(await api<Property>(`/api/properties/${p.id}/upload`, { method: "POST", body: form }));
      setFilter(kind);
    });
  };

  return (
    <section className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-line-2 p-1 text-sm">
          {(["photo", "floorplan"] as const).map((k) => (
            <button key={k} onClick={() => setFilter(k)} className={`rounded-md px-3 py-1 font-medium ${filter === k ? "bg-card shadow-sm" : "text-ink-2"}`}>
              {k === "photo" ? "Photos" : "Floor plans"} <span className="font-mono text-xs text-ink-3">{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => { upload(e.target.files, "photo"); e.target.value = ""; }} />
          <input ref={planInput} type="file" accept="image/*" multiple hidden onChange={(e) => { upload(e.target.files, "floorplan"); e.target.value = ""; }} />
          <button className="btn-ghost" onClick={() => photoInput.current?.click()} disabled={!!busy}>
            {busy ? <Spinner /> : "+"} Photos
          </button>
          <button className="btn-ghost" onClick={() => planInput.current?.click()} disabled={!!busy}>
            + Floor plan
          </button>
        </div>
      </div>
      <div className="mt-3">
        <ErrorNote error={error} onClose={() => setError(null)} />
      </div>
      {items.length ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((ph, i) => (
            <button key={ph.id} onClick={() => setOpen(ph)} className={`group relative overflow-hidden rounded-lg border border-line bg-line-2 ${i === 0 && filter === "photo" ? "col-span-2 row-span-2" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fileUrl(ph.file)} alt={ph.caption || ""} loading="lazy" className={`h-full w-full ${filter === "floorplan" ? "aspect-[4/3] bg-white object-contain" : "aspect-[4/3] object-cover"} transition-transform duration-300 group-hover:scale-[1.02]`} />
              {ph.caption && <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-ink/70 to-transparent px-2 pt-6 pb-1.5 text-left text-xs text-white">{ph.caption}</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-4 grid place-items-center rounded-lg border border-dashed border-line py-16 text-center text-sm text-ink-2">
          {filter === "photo" ? "No photos yet — add the listing photos or your own from the viewing." : "No floor plan yet — upload the agent's floor plan to trace it into 3D."}
        </div>
      )}
      {open && (
        <Lightbox
          photo={open}
          onClose={() => setOpen(null)}
          ctx={ctx}
          onReimagine={() => {
            setOpen(null);
            goTo("visuals", { photoId: open.id });
          }}
        />
      )}
    </section>
  );
}

function Lightbox({ photo, onClose, ctx, onReimagine }: { photo: Photo; onClose: () => void; ctx: WorkspaceCtx; onReimagine: () => void }) {
  const [caption, setCaption] = useState(photo.caption ?? "");
  const { busy, error, run } = useBusy();
  const save = (args: Record<string, unknown>) => run("save", () => ctx.op("updatePhoto", { photoId: photo.id, ...args }));
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink/85 p-3 backdrop-blur-sm sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={fileUrl(photo.file)} alt={photo.caption || ""} className={`max-h-full max-w-full rounded-lg ${photo.kind === "floorplan" ? "bg-white" : ""}`} />
        </div>
        <div className="card mt-3 flex flex-wrap items-center gap-2 p-3">
          <input className="input min-w-40 flex-1" placeholder="Caption, e.g. Kitchen from the back door" value={caption} onChange={(e) => setCaption(e.target.value)} onBlur={() => caption !== (photo.caption ?? "") && save({ caption })} />
          <button className="btn-ghost" disabled={!!busy} onClick={() => save({ kind: photo.kind === "photo" ? "floorplan" : "photo" }).then(onClose)}>
            {photo.kind === "photo" ? "It's a floor plan" : "It's a photo"}
          </button>
          {photo.kind === "photo" && (
            <button className="btn-primary" onClick={onReimagine}>
              Re-imagine this room
            </button>
          )}
          <button
            className="btn-quiet text-brick"
            disabled={!!busy}
            onClick={() => confirm("Delete this image?") && run("del", () => ctx.op("deletePhoto", { photoId: photo.id })).then(onClose)}
          >
            Delete
          </button>
          <button className="btn-quiet" onClick={onClose}>
            Close
          </button>
          <div className="w-full">
            <ErrorNote error={error} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Notes({ ctx }: { ctx: WorkspaceCtx }) {
  const { member } = useApp();
  const [text, setText] = useState("");
  const { busy, error, run } = useBusy();
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    run("add", async () => {
      await ctx.op("addNote", { author: member, text: text.trim() });
      setText("");
    });
  };
  return (
    <section className="card p-4 sm:p-5">
      <h2 className="font-display text-xl">Viewing notes</h2>
      <p className="mt-0.5 text-xs text-ink-3">First impressions, questions for the agent, things to check at a second viewing.</p>
      <form onSubmit={add} className="mt-3 space-y-2">
        <textarea className="input min-h-20" placeholder={`${member}: what did you notice?`} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex items-center justify-between">
          <ErrorNote error={error} />
          <button className="btn-primary ml-auto" disabled={!!busy || !text.trim()}>
            Add note
          </button>
        </div>
      </form>
      <ul className="mt-4 space-y-3">
        {[...ctx.p.notes].reverse().map((n) => (
          <li key={n.id} className="group rounded-lg border border-line-2 bg-white/60 p-3 text-sm">
            <div className="flex items-center gap-2 text-xs text-ink-3">
              <strong className="font-semibold text-ink">{n.author}</strong>
              <span>{timeAgo(n.createdAt)}</span>
              <button className="ml-auto opacity-0 group-hover:opacity-100 hover:text-brick" onClick={() => ctx.op("deleteNote", { noteId: n.id })} aria-label="Delete note">
                ✕
              </button>
            </div>
            <p className="mt-1 whitespace-pre-wrap">{n.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Details({ ctx, onDelete }: { ctx: WorkspaceCtx; onDelete: () => void }) {
  const { p } = ctx;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState(() => toForm(p));
  const { busy, error, run } = useBusy();
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    run("save", async () => {
      await ctx.op("update", {
        fields: {
          title: f.title || "Untitled property",
          address: f.address,
          price: f.price,
          listingUrl: f.listingUrl,
          propertyType: f.propertyType,
          bedrooms: f.bedrooms === "" ? null : Number(f.bedrooms),
          bathrooms: f.bathrooms === "" ? null : Number(f.bathrooms),
          description: f.description,
          features: f.features.split("\n").map((s) => s.trim()).filter(Boolean),
        },
      });
      setEditing(false);
    });
  };
  if (!editing)
    return (
      <section className="card p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl">Details</h2>
          <button className="btn-quiet py-1" onClick={() => { setF(toForm(p)); setEditing(true); }}>
            Edit
          </button>
        </div>
        {p.description ? <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-ink-2">{p.description}</p> : <p className="mt-3 text-sm text-ink-3">No description yet.</p>}
        {p.features.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {p.features.map((x) => (
              <li key={x} className="flex gap-2">
                <span className="text-brick">—</span>
                {x}
              </li>
            ))}
          </ul>
        )}
        <button className="mt-5 text-xs text-ink-3 hover:text-brick" onClick={onDelete}>
          Delete this house
        </button>
      </section>
    );
  const field = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label className="label" htmlFor={`f-${k}`}>{label}</label>
      <input id={`f-${k}`} className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} />
    </div>
  );
  return (
    <form onSubmit={save} className="card space-y-3 p-4 sm:p-5">
      <h2 className="font-display text-xl">Edit details</h2>
      {field("title", "Name")}
      {field("address", "Address")}
      <div className="grid grid-cols-2 gap-3">
        {field("price", "Price")}
        {field("propertyType", "Type")}
        {field("bedrooms", "Bedrooms", { type: "number", min: 0 })}
        {field("bathrooms", "Bathrooms", { type: "number", min: 0 })}
      </div>
      {field("listingUrl", "Listing link", { type: "url" })}
      <div>
        <label className="label" htmlFor="f-desc">Description</label>
        <textarea id="f-desc" className="input min-h-28" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="f-feat">Key features (one per line)</label>
        <textarea id="f-feat" className="input min-h-20" value={f.features} onChange={(e) => setF({ ...f, features: e.target.value })} />
      </div>
      <ErrorNote error={error} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-quiet" onClick={() => setEditing(false)}>Cancel</button>
        <button className="btn-primary" disabled={!!busy}>{busy && <Spinner />} Save</button>
      </div>
    </form>
  );
}

function toForm(p: Property) {
  return {
    title: p.title,
    address: p.address,
    price: p.price ?? "",
    listingUrl: p.listingUrl ?? "",
    propertyType: p.propertyType ?? "",
    bedrooms: p.bedrooms?.toString() ?? "",
    bathrooms: p.bathrooms?.toString() ?? "",
    description: p.description ?? "",
    features: p.features.join("\n"),
  };
}
