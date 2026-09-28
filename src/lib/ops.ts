import "server-only";
// Every mutation the UI can make on a property, in one place. Each op returns
// the updated property so the client can just swap its state.

import * as z from "zod/v4";
import { AIError, analyseProperty, propertyContext, proposeScenario, traceFloorPlan, writeRenderPrompt, type ImageInput } from "./claude";
import { claudeEnabled, imageProvider } from "./config";
import { dataUrlToBuffer, normaliseImage } from "./images";
import { generateImage, ImageGenError } from "./imagegen";
import { cloneLayout, emptyLayout, newId, pruneLayout } from "./layout";
import { ListingError } from "./listing";
import { deleteUpload, getProperty, NotFoundError, readUpload, saveUpload, updateProperty } from "./store";
import type { Layout, Property, Scenario } from "./types";

export class OpError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const now = () => new Date().toISOString();
const tier = z.enum(["refresh", "reconfigure", "extend"]);

const layoutSchema: z.ZodType<Layout> = z.object({
  floors: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      level: z.number(),
      rooms: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          type: z.enum(["living", "kitchen", "dining", "kitchen_dining", "bedroom", "bathroom", "ensuite", "wc", "hall", "landing", "utility", "study", "garage", "conservatory", "storage", "other"]),
          x: z.number(),
          y: z.number(),
          w: z.number().positive(),
          d: z.number().positive(),
          finish: z.object({ wall: z.string().optional(), floor: z.enum(["oak", "walnut", "tile", "stone", "carpet", "concrete", "vinyl"]).optional() }).optional(),
          isNew: z.boolean().optional(),
        }),
      ),
    }),
  ),
  wallStates: z.record(z.string(), z.enum(["solid", "door", "window", "glazed", "open"])),
  connections: z.array(z.object({ a: z.string(), b: z.string(), kind: z.enum(["door", "open"]), side: z.enum(["top", "bottom", "left", "right"]).optional() })),
  attached: z.array(z.enum(["top", "bottom", "left", "right"])).optional(),
  ceilingHeight: z.number().min(2).max(5),
});

export function baseScenario(p: Property): Scenario | undefined {
  return p.scenarios.find((s) => s.tier === "base") ?? p.scenarios[0];
}

async function loadImages(p: Property, kinds: ("photo" | "floorplan")[], max: number, ids?: string[]): Promise<ImageInput[]> {
  let photos = p.photos.filter((ph) => kinds.includes(ph.kind));
  if (ids?.length) photos = photos.filter((ph) => ids.includes(ph.id));
  // Floor plans first, then an even spread of photos.
  const plans = photos.filter((ph) => ph.kind === "floorplan");
  const rest = photos.filter((ph) => ph.kind === "photo");
  const step = Math.max(1, rest.length / Math.max(1, max - plans.length));
  const picked = [...plans, ...rest.filter((_, i) => Math.floor(i % step) === 0)].slice(0, max);
  const out: ImageInput[] = [];
  for (const ph of picked) {
    const f = await readUpload(ph.file);
    if (f) out.push({ data: f.data, mime: f.mime, label: `${ph.kind === "floorplan" ? "Floor plan" : "Photo"}${ph.caption ? `: ${ph.caption}` : ""}` });
  }
  return out;
}

function requireClaude() {
  if (!claudeEnabled()) throw new OpError("Claude isn't configured — add ANTHROPIC_API_KEY to use AI features.", 503);
}

type Handler = (p: Property, args: Record<string, unknown>) => Promise<Property>;

const ops: Record<string, Handler> = {
  async update(p, args) {
    const fields = z
      .object({
        title: z.string().min(1).optional(),
        address: z.string().optional(),
        price: z.string().optional(),
        listingUrl: z.string().optional(),
        bedrooms: z.number().nullable().optional(),
        bathrooms: z.number().nullable().optional(),
        propertyType: z.string().optional(),
        description: z.string().optional(),
        features: z.array(z.string()).optional(),
        status: z.enum(["viewing", "shortlisted", "offer", "passed"]).optional(),
      })
      .parse(args.fields);
    return updateProperty(p.id, (q) => {
      for (const [k, v] of Object.entries(fields)) (q as unknown as Record<string, unknown>)[k] = v ?? undefined;
    });
  },

  async rate(p, args) {
    const { member, value } = z.object({ member: z.string().min(1), value: z.number().min(0).max(5) }).parse(args);
    return updateProperty(p.id, (q) => {
      q.ratings[member] = value;
    });
  },

  async addNote(p, args) {
    const { author, text } = z.object({ author: z.string(), text: z.string().min(1) }).parse(args);
    return updateProperty(p.id, (q) => {
      q.notes.push({ id: newId("n"), author, text, createdAt: now() });
    });
  },

  async deleteNote(p, args) {
    const { noteId } = z.object({ noteId: z.string() }).parse(args);
    return updateProperty(p.id, (q) => {
      q.notes = q.notes.filter((n) => n.id !== noteId);
    });
  },

  async addWish(p, args) {
    const w = z.object({ author: z.string(), tier, room: z.string().optional(), text: z.string().min(1), priority: z.enum(["must", "nice", "dream"]) }).parse(args);
    return updateProperty(p.id, (q) => {
      q.wishes.push({ ...w, id: newId("w"), createdAt: now() });
    });
  },

  async updateWish(p, args) {
    const { wishId, ...rest } = z.object({ wishId: z.string(), tier: tier.optional(), room: z.string().optional(), text: z.string().optional(), priority: z.enum(["must", "nice", "dream"]).optional() }).parse(args);
    return updateProperty(p.id, (q) => {
      const w = q.wishes.find((x) => x.id === wishId);
      if (w) Object.assign(w, rest);
    });
  },

  async deleteWish(p, args) {
    const { wishId } = z.object({ wishId: z.string() }).parse(args);
    return updateProperty(p.id, (q) => {
      q.wishes = q.wishes.filter((w) => w.id !== wishId);
    });
  },

  async updatePhoto(p, args) {
    const { photoId, caption, kind } = z.object({ photoId: z.string(), caption: z.string().optional(), kind: z.enum(["photo", "floorplan"]).optional() }).parse(args);
    return updateProperty(p.id, (q) => {
      const ph = q.photos.find((x) => x.id === photoId);
      if (!ph) return;
      if (caption !== undefined) ph.caption = caption;
      if (kind) ph.kind = kind;
    });
  },

  async movePhoto(p, args) {
    const { photoId, toIndex } = z.object({ photoId: z.string(), toIndex: z.number().int().min(0) }).parse(args);
    return updateProperty(p.id, (q) => {
      const i = q.photos.findIndex((x) => x.id === photoId);
      if (i < 0) return;
      const [ph] = q.photos.splice(i, 1);
      q.photos.splice(Math.min(toIndex, q.photos.length), 0, ph);
    });
  },

  async deletePhoto(p, args) {
    const { photoId } = z.object({ photoId: z.string() }).parse(args);
    const ph = p.photos.find((x) => x.id === photoId);
    const out = await updateProperty(p.id, (q) => {
      q.photos = q.photos.filter((x) => x.id !== photoId);
    });
    if (ph && !out.renders.some((r) => r.sourceFile === ph.file)) await deleteUpload(ph.file);
    return out;
  },

  async createScenario(p, args) {
    const { name, tier: t, description, fromScenarioId, author } = z
      .object({ name: z.string().min(1), tier: z.enum(["base", "refresh", "reconfigure", "extend"]), description: z.string().default(""), fromScenarioId: z.string().optional(), author: z.string() })
      .parse(args);
    const from = fromScenarioId ? p.scenarios.find((s) => s.id === fromScenarioId) : baseScenario(p);
    return updateProperty(p.id, (q) => {
      q.scenarios.push({
        id: newId("s"),
        name,
        tier: t,
        description,
        layout: from ? cloneLayout(from.layout) : emptyLayout(),
        createdBy: author,
        createdAt: now(),
        source: "manual",
      });
    });
  },

  async saveScenario(p, args) {
    const s = z
      .object({ id: z.string(), name: z.string().min(1), tier: z.enum(["base", "refresh", "reconfigure", "extend"]), description: z.string(), layout: layoutSchema })
      .parse(args.scenario);
    return updateProperty(p.id, (q) => {
      const existing = q.scenarios.find((x) => x.id === s.id);
      if (!existing) throw new OpError("Scenario not found", 404);
      Object.assign(existing, { ...s, layout: pruneLayout(s.layout) });
    });
  },

  async deleteScenario(p, args) {
    const { scenarioId } = z.object({ scenarioId: z.string() }).parse(args);
    return updateProperty(p.id, (q) => {
      q.scenarios = q.scenarios.filter((s) => s.id !== scenarioId);
    });
  },

  async deleteRender(p, args) {
    const { renderId } = z.object({ renderId: z.string() }).parse(args);
    const r = p.renders.find((x) => x.id === renderId);
    const out = await updateProperty(p.id, (q) => {
      q.renders = q.renders.filter((x) => x.id !== renderId);
    });
    if (r) {
      await deleteUpload(r.file);
      if (r.sourceFile && !r.sourcePhotoId) await deleteUpload(r.sourceFile);
    }
    return out;
  },

  async trace(p, args) {
    requireClaude();
    const { author, photoIds } = z.object({ author: z.string(), photoIds: z.array(z.string()).optional() }).parse(args);
    const images = await loadImages(p, ["floorplan"], 6, photoIds);
    if (!images.length) throw new OpError("Add a floor plan image first (upload it and mark it as a floor plan).");
    const { layout, confidence } = await traceFloorPlan(images, propertyContext(p));
    return updateProperty(p.id, (q) => {
      const base = q.scenarios.find((s) => s.tier === "base");
      if (base) {
        base.layout = layout;
        base.description = `Traced from the floor plan. ${confidence}`;
        base.source = "trace";
        base.createdAt = now();
      } else {
        q.scenarios.unshift({ id: newId("s"), name: "As it stands", tier: "base", description: `Traced from the floor plan. ${confidence}`, layout, createdBy: author, createdAt: now(), source: "trace" });
      }
    });
  },

  async analyse(p) {
    requireClaude();
    const images = await loadImages(p, ["floorplan", "photo"], 12);
    const analysis = await analyseProperty(p, images, baseScenario(p)?.layout);
    return updateProperty(p.id, (q) => {
      q.analysis = analysis;
    });
  },

  async propose(p, args) {
    requireClaude();
    const { author, brief, ideaId, fromScenarioId } = z.object({ author: z.string(), brief: z.string().default(""), ideaId: z.string().optional(), fromScenarioId: z.string().optional() }).parse(args);
    const from = (fromScenarioId && p.scenarios.find((s) => s.id === fromScenarioId)) || baseScenario(p);
    if (!from || !from.layout.floors.some((f) => f.rooms.length)) throw new OpError("Trace or sketch the current plan first — scenarios are drafted from it.");
    const idea = ideaId ? p.analysis?.ideas.find((i) => i.id === ideaId) : undefined;
    const fullBrief = [idea && `${idea.title} (${idea.tier}): ${idea.summary}`, brief].filter(Boolean).join("\n");
    if (!fullBrief.trim()) throw new OpError("Describe what the scenario should do.");
    const images = await loadImages(p, ["floorplan"], 3);
    const draft = await proposeScenario(p, from.layout, fullBrief, images);
    return updateProperty(p.id, (q) => {
      q.scenarios.push({ id: newId("s"), ...draft, createdBy: author, createdAt: now(), source: "ai" });
    });
  },

  async render(p, args) {
    requireClaude();
    if (!imageProvider()) throw new OpError("No image model configured — add GEMINI_API_KEY or OPENAI_API_KEY to generate visuals.", 503);
    const { author, brief, photoId, snapshot, scenarioId } = z
      .object({ author: z.string(), brief: z.string().min(3), photoId: z.string().optional(), snapshot: z.string().optional(), scenarioId: z.string().optional() })
      .parse(args);
    let source: { data: Buffer; mime: string };
    let sourceFile: string;
    if (photoId) {
      const ph = p.photos.find((x) => x.id === photoId);
      const f = ph && (await readUpload(ph.file));
      if (!ph || !f) throw new OpError("Photo not found", 404);
      source = f;
      sourceFile = ph.file;
    } else if (snapshot) {
      const raw = dataUrlToBuffer(snapshot);
      source = { data: await normaliseImage(raw.data, 1600), mime: "image/jpeg" };
      sourceFile = await saveUpload(p.id, source.data, source.mime, "view");
    } else {
      throw new OpError("Pick a photo or a 3D view to start from.");
    }
    const scenario = scenarioId ? p.scenarios.find((s) => s.id === scenarioId) : undefined;
    const context = [propertyContext(p), scenario && `Scenario: ${scenario.name} — ${scenario.description}`].filter(Boolean).join("\n");
    const prompt = await writeRenderPrompt(source, brief, context, !photoId);
    const img = await generateImage(source, prompt);
    const file = await saveUpload(p.id, await normaliseImage(img.data, 2000, 90), "image/jpeg", "render");
    return updateProperty(p.id, (q) => {
      q.renders.unshift({ id: newId("r"), file, sourcePhotoId: photoId, sourceFile, scenarioId, prompt, brief, createdBy: author, createdAt: now(), provider: img.provider });
    });
  },
};

export async function runOp(id: string, op: string, args: Record<string, unknown>): Promise<Property> {
  const handler = ops[op];
  if (!handler) throw new OpError(`Unknown operation: ${op}`);
  const p = await getProperty(id);
  if (!p) throw new OpError("Property not found", 404);
  return handler(p, args);
}

export function errorResponse(err: unknown) {
  if (err instanceof OpError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof AIError || err instanceof ImageGenError) return Response.json({ error: err.message }, { status: 502 });
  if (err instanceof z.ZodError) return Response.json({ error: "Invalid input", details: err.issues }, { status: 400 });
  if (err instanceof ListingError) return Response.json({ error: err.message }, { status: 422 });
  if (err instanceof NotFoundError) return Response.json({ error: err.message }, { status: 404 });
  console.error(err);
  return Response.json({ error: "Something went wrong on the server." }, { status: 500 });
}
