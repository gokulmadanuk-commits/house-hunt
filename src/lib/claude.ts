import "server-only";
// All Claude calls live here: reading floor plans, importing listings,
// suggesting renovation ideas, drafting scenario plans and writing image
// prompts. Every call returns schema-validated JSON (structured outputs).

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { applyWallInstructions, cloneLayout, deriveWalls, layoutStats, newId, pruneLayout, tidyLayout } from "./layout";
import type { Analysis, Layout, PlanSide, Property, RoomType, Tier, WallState } from "./types";
import { ROOM_TYPES } from "./types";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
// Server-side refusal fallback is only offered on the newest models.
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"]);

let client: Anthropic | null = null;
function anthropic() {
  client ??= new Anthropic({ timeout: 10 * 60 * 1000 });
  return client;
}

export class AIError extends Error {}

export interface ImageInput {
  data: Buffer;
  mime: string;
  label?: string;
}

function imageBlocks(images: ImageInput[]): Anthropic.Beta.BetaContentBlockParam[] {
  return images.flatMap((img) => {
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (img.label) blocks.push({ type: "text", text: img.label });
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mime as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
        data: img.data.toString("base64"),
      },
    });
    return blocks;
  });
}

interface CallOptions<T extends z.ZodType> {
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  schema: T;
  effort?: "low" | "medium" | "high" | "xhigh";
  tools?: Anthropic.Beta.BetaToolUnion[];
}

/** One structured-output request, streamed, with pause_turn continuation for server tools. */
async function structured<T extends z.ZodType>(opts: CallOptions<T>): Promise<z.infer<T>> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: opts.content }];
  const useFallback = FALLBACK_MODELS.has(MODEL);
  for (let turn = 0; turn < 5; turn++) {
    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = anthropic().beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        system: opts.system,
        thinking: { type: "adaptive" },
        output_config: { effort: opts.effort ?? "high", format: zodOutputFormat(opts.schema) },
        messages,
        ...(opts.tools ? { tools: opts.tools } : {}),
        ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new AIError("Claude rejected the API key — check ANTHROPIC_API_KEY.");
      if (err instanceof Anthropic.RateLimitError) throw new AIError("Claude is rate-limiting requests — try again in a minute.");
      if (err instanceof Anthropic.BadRequestError) throw new AIError(`Claude couldn't process that request: ${err.message}`);
      if (err instanceof Anthropic.APIError) throw new AIError(`Claude API error (${err.status ?? "network"}): ${err.message}`);
      throw err;
    }
    if (message.stop_reason === "refusal") {
      throw new AIError("Claude declined this request.");
    }
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
      continue;
    }
    if (message.stop_reason === "max_tokens") throw new AIError("Claude's answer was cut off (too long). Try with fewer images.");
    const text = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AIError("Claude returned an unreadable answer — please try again.");
    }
    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) throw new AIError(`Claude's answer didn't match the expected shape: ${parsed.error.message.slice(0, 300)}`);
    return parsed.data;
  }
  throw new AIError("Claude took too many steps without finishing.");
}

// ─── Schemas ─────────────────────────────────────────────────────────────

// Plain strings in the wire schema (structured outputs can't express Zod
// transforms); values are normalised after parsing.
const roomTypeSchema = z.string();
const sideSchema = z.string().nullable();
const wallStateSchema = z.string();
const tierSchema = z.string();

const asRoomType = (t: string): RoomType => ((ROOM_TYPES as string[]).includes(t) ? (t as RoomType) : "other");
const asSide = (s: string | null): PlanSide | null => (s && ["top", "bottom", "left", "right"].includes(s) ? (s as PlanSide) : null);
const asWallState = (s: string): WallState => (["solid", "door", "window", "glazed", "open"].includes(s) ? (s as WallState) : "solid");
const asTier = (t: string): Tier => (["refresh", "reconfigure", "extend"].includes(t) ? (t as Tier) : "refresh");

const tracedRoom = z.object({
  id: z.string().describe("short slug, unique across the whole house, e.g. 'kitchen', 'bed2'"),
  name: z.string().describe("room name as labelled on the plan"),
  type: roomTypeSchema.describe(`one of: ${ROOM_TYPES.join(", ")}`),
  x: z.number().describe("left edge, metres from the plan's left"),
  y: z.number().describe("top edge, metres from the plan's top"),
  w: z.number().describe("width along x, metres"),
  d: z.number().describe("depth along y, metres"),
});

const traceSchema = z.object({
  floors: z.array(
    z.object({
      id: z.string().describe("short slug e.g. 'gf', 'ff'"),
      name: z.string(),
      level: z.number().describe("0 = ground floor, 1 = first, -1 = basement"),
      rooms: z.array(tracedRoom),
    }),
  ),
  connections: z.array(
    z.object({
      a: z.string().describe("room id"),
      b: z.string().describe("room id, or 'outside' for an external door"),
      kind: z.string().describe("'door' or 'open' (archway / open-plan with no door)"),
      side: sideSchema.describe("only for b='outside': which edge of room a (top/bottom/left/right), else null"),
    }),
  ),
  attached: z.array(z.string()).describe("plan sides where the building is joined to a neighbour (party walls): subset of top/bottom/left/right; empty for detached"),
  ceilingHeight: z.number().describe("typical ceiling height in metres; 2.4 if unknown"),
  confidence: z.string().describe("one or two sentences on how reliable this trace is and what was estimated"),
});

const TRACE_SYSTEM = `You convert estate-agent floor plans into a precise rectangular room model used to build a 3D walkthrough.

Coordinate system: metres; origin at the top-left of the plan image as drawn; x increases to the right, y increases downward. Keep the plan's orientation exactly as drawn.

Rules:
- Every room is an axis-aligned rectangle. Split L-shaped or irregular rooms into two or more rectangles that share the same name (add " (part)" to the smaller one) and connect them with kind "open".
- Treat walls as zero-thickness lines: rooms that are separated by a wall must share exactly the same edge coordinate, so adjacent rectangles touch with no gaps or overlaps. The union of rooms should form the building's footprint.
- Use the printed room dimensions (metric or imperial; 1 ft = 0.3048 m) as the primary source; infer positions from the drawing. When dimensions are missing, estimate from proportions relative to measured rooms.
- Include halls, landings, stairwells (as part of the hall/landing), WCs, utility rooms, cupboards over ~1 m². Exclude gardens, patios and external outbuildings.
- If several floors are shown (one image or several), output one floor per level, aligned to each other (the same external walls should have the same coordinates on each floor).
- connections: list every door or opening between rooms that you can see (door swings or gaps in walls), plus the front/back doors to 'outside'.
- attached: for terraces include both party-wall sides; for semi-detached the one shared side; detached → [].
- Be honest in 'confidence' about anything estimated.`;

export async function traceFloorPlan(images: ImageInput[], context: string): Promise<{ layout: Layout; confidence: string }> {
  const result = await structured({
    system: TRACE_SYSTEM,
    effort: "high",
    schema: traceSchema,
    content: [
      ...imageBlocks(images),
      { type: "text", text: `Property context:\n${context}\n\nTrace the floor plan(s) above into the room model.` },
    ],
  });
  const ids = new Set<string>();
  const layout: Layout = {
    ceilingHeight: Math.min(4, Math.max(2.1, result.ceilingHeight || 2.4)),
    wallStates: {},
    attached: result.attached.filter((s): s is "top" | "bottom" | "left" | "right" => ["top", "bottom", "left", "right"].includes(s)),
    connections: result.connections.map((c) => ({
      a: c.a,
      b: c.b,
      kind: c.kind === "open" ? ("open" as const) : ("door" as const),
      ...(c.b === "outside" && asSide(c.side) ? { side: asSide(c.side)! } : {}),
    })),
    floors: result.floors
      .sort((a, b) => a.level - b.level)
      .map((f) => ({
        id: f.id || newId("f"),
        name: f.name,
        level: f.level,
        rooms: f.rooms
          .filter((r) => r.w > 0.3 && r.d > 0.3)
          .map((r) => {
            let id = r.id.replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || newId("r");
            while (ids.has(id)) id = `${id}_${ids.size}`;
            ids.add(id);
            return { ...r, id, type: asRoomType(r.type) };
          }),
      })),
  };
  return { layout: pruneLayout(tidyLayout(layout)), confidence: result.confidence };
}

// ─── Listing import ──────────────────────────────────────────────────────

const listingSchema = z.object({
  found: z.boolean().describe("false if this doesn't look like a property listing"),
  title: z.string().describe("short title, e.g. '3 bed terrace, Ormeau Road'"),
  address: z.string(),
  price: z.string().describe("as displayed, e.g. 'Offers around £245,000', or '' if absent"),
  bedrooms: z.number().nullable(),
  bathrooms: z.number().nullable(),
  propertyType: z.string().describe("e.g. Terrace, Semi-detached, Detached, Apartment, Bungalow"),
  description: z.string().describe("the agent's description, lightly cleaned, max ~250 words"),
  features: z.array(z.string()).describe("key features bullets"),
  photoUrls: z.array(z.string()).describe("absolute URLs of the property photos, largest available size, in listing order"),
  floorplanUrls: z.array(z.string()).describe("absolute URLs of floor plan images (not EPC graphs or maps)"),
});
export type ListingData = z.infer<typeof listingSchema>;

const LISTING_SYSTEM = `You extract structured data from UK/Irish property listing pages (PropertyPal, Rightmove, Zoopla, agents' own sites). Use only what is on the page — never invent details. For images, prefer the highest-resolution variant of each URL present in the data, keep listing order, and separate floor plans from photos (floor plans are line drawings with room labels and dimensions; URLs or JSON keys often mention 'floor' or 'plan'). Exclude logos, agent photos, maps, EPC charts and brochure thumbnails.`;

export async function extractListing(url: string, pageDigest: string): Promise<ListingData> {
  return structured({
    system: LISTING_SYSTEM,
    effort: "medium",
    schema: listingSchema,
    content: [{ type: "text", text: `Listing URL: ${url}\n\nPage data (may be truncated):\n${pageDigest}` }],
  });
}

/** Fallback when our server can't fetch the page directly: Claude fetches it. */
export async function extractListingViaWebFetch(url: string): Promise<ListingData> {
  return structured({
    system: LISTING_SYSTEM,
    effort: "medium",
    schema: listingSchema,
    tools: [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 }],
    content: [{ type: "text", text: `Fetch this property listing and extract its details: ${url}` }],
  });
}

// ─── Renovation ideas ────────────────────────────────────────────────────

const ideaSchema = z.object({
  tier: tierSchema.describe("refresh | reconfigure | extend"),
  title: z.string(),
  summary: z.string().describe("2-4 sentences: what changes and why it helps this particular house"),
  rooms: z.array(z.string()).describe("room names affected"),
  impact: z.string().describe("what it does for how the house lives: light, flow, space, value"),
  costBand: z.string().describe("rough order-of-magnitude band with a clear 'indicative' caveat, e.g. '£15k–£30k (indicative)'"),
  complexity: z.string().describe("low | medium | high"),
  permissions: z.string().describe("likely consents: planning / permitted development / building control / listed-building / party wall; say what to check"),
  risks: z.string().describe("structural, damp, services, budget risks or unknowns to investigate at a second viewing"),
  visualBrief: z.string().describe("one vivid sentence an image model could use to show the finished room"),
});

const analysisSchema = z.object({
  overview: z.string().describe("3-5 sentences: the house's potential and the main trade-offs"),
  ideas: z.array(ideaSchema).describe("6-12 ideas spanning all three tiers, the couple's wishes first"),
  caveats: z.array(z.string()).describe("things that can't be judged from photos/plans and need a surveyor, engineer or the council"),
});

const ANALYSIS_SYSTEM = `You are a pragmatic residential architect and renovation adviser helping a couple assess a house they are considering buying. Ideas fall in three tiers:
- refresh: within the existing plan (finishes, kitchen/bathroom refits, lighting, storage, glazing swaps)
- reconfigure: change the internal plan (remove or move walls, re-purpose rooms, relocate kitchen/bathroom, stairs)
- extend: add space (rear/side/wrap extensions, attic conversion, garage conversion, porch, dormers)

Ground every idea in what you can see in the photos and floor plan. Put the couple's own wishes first and respond to each; say plainly when a wish is hard or poor value. Work out the jurisdiction from the address (Northern Ireland, Republic of Ireland, England, Scotland and Wales have different planning regimes) and describe consents in that context, flagging that rules must be confirmed with the local council. Cost bands are indicative order-of-magnitude only; never present them as quotes. Don't claim a wall is or isn't load-bearing — say what suggests it and that an engineer must confirm.`;

export function describeLayout(layout: Layout): string {
  const stats = layoutStats(layout);
  const lines = [`Total internal area ≈ ${stats.totalArea} m², ceiling ${layout.ceilingHeight} m, attached sides: ${(layout.attached ?? []).join(", ") || "none"}`];
  for (const f of layout.floors) {
    lines.push(`Floor "${f.name}" (id ${f.id}, level ${f.level}):`);
    for (const r of f.rooms) lines.push(`  room ${r.id} "${r.name}" [${r.type}] x=${r.x} y=${r.y} w=${r.w} d=${r.d} (${(r.w * r.d).toFixed(1)} m²)${r.isNew ? " NEW" : ""}`);
    const walls = deriveWalls(f, layout).filter((s) => s.state !== "solid" || s.party);
    for (const s of walls) {
      const who = s.exterior ? `${s.sideA ?? s.sideB}|outside` : `${s.sideA}|${s.sideB}`;
      lines.push(`  wall ${who} ${s.length}m: ${s.party ? "party wall" : s.state}`);
    }
  }
  return lines.join("\n");
}

function propertyContext(p: Property) {
  return [
    `Title: ${p.title}`,
    `Address: ${p.address}`,
    p.price && `Price: ${p.price}`,
    p.propertyType && `Type: ${p.propertyType}`,
    p.bedrooms != null && `Bedrooms: ${p.bedrooms}`,
    p.bathrooms != null && `Bathrooms: ${p.bathrooms}`,
    p.description && `Agent description: ${p.description}`,
    p.features.length && `Features: ${p.features.join("; ")}`,
  ].filter(Boolean).join("\n");
}

function wishesText(p: Property) {
  if (!p.wishes.length) return "The couple haven't listed specific wishes yet.";
  return "The couple's wishes:\n" + p.wishes.map((w) => `- [${w.tier}, ${w.priority}${w.room ? `, ${w.room}` : ""}] ${w.text} (${w.author})`).join("\n");
}

export async function analyseProperty(p: Property, images: ImageInput[], base?: Layout): Promise<Analysis> {
  const notes = p.notes.length ? "Viewing notes:\n" + p.notes.map((n) => `- ${n.author}: ${n.text}`).join("\n") : "";
  const result = await structured({
    system: ANALYSIS_SYSTEM,
    effort: "high",
    schema: analysisSchema,
    content: [
      ...imageBlocks(images),
      {
        type: "text",
        text: [propertyContext(p), base ? `Current plan model:\n${describeLayout(base)}` : "No traced plan yet.", wishesText(p), notes, "What's possible with this house?"]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });
  return {
    createdAt: new Date().toISOString(),
    overview: result.overview,
    caveats: result.caveats,
    ideas: result.ideas.map((i) => ({
      ...i,
      id: newId("i"),
      tier: asTier(i.tier),
      complexity: (["low", "medium", "high"].includes(i.complexity) ? i.complexity : "medium") as "low" | "medium" | "high",
    })),
  };
}

// ─── Scenario drafting ───────────────────────────────────────────────────

const proposalSchema = z.object({
  name: z.string().describe("short scenario name"),
  tier: tierSchema,
  description: z.string().describe("2-4 sentences describing the changes"),
  ceilingHeight: z.number(),
  floors: z.array(
    z.object({
      id: z.string().describe("keep existing floor ids; new floors get a new slug"),
      name: z.string(),
      level: z.number(),
      rooms: z.array(
        tracedRoom.extend({
          isNew: z.boolean().describe("true only for newly built space (extensions, attic)"),
          wallColour: z.string().nullable().describe("hex wall colour if the scenario proposes one, else null"),
          floorFinish: z.string().nullable().describe("oak | walnut | tile | stone | carpet | concrete | vinyl, or null"),
        }),
      ),
    }),
  ),
  walls: z.array(
    z.object({
      floorId: z.string(),
      roomA: z.string(),
      roomB: z.string().describe("room id or 'outside'"),
      side: sideSchema.describe("for outside walls: which edge of roomA; else null"),
      state: wallStateSchema.describe("solid | door | window | glazed | open"),
    }),
  ).describe("only walls whose state should differ from the current plan, plus doors for new rooms"),
});

const PROPOSAL_SYSTEM = `You redesign a house plan to realise a renovation idea. You receive the current plan as rectangles (metres; x right, y down; walls are zero-thickness lines where rectangles touch) and return the complete new plan.

Rules:
- Return every floor and every room of the new plan (not a diff). Keep ids and coordinates of untouched rooms exactly the same.
- Removing a wall between two rooms: either merge them into one rectangle (when they form a rectangle together) or keep both and set their wall state to "open".
- Extensions: add new rectangles flush against the existing external walls (sharing the exact edge coordinate) with isNew true; open or door them into the existing rooms via 'walls'. Respect party walls (attached sides) — nothing may be built beyond them.
- Every room must stay reachable: give new/changed rooms a door or opening.
- Keep proposals buildable and proportionate for a family home; favour simple rectangles.`;

export async function proposeScenario(p: Property, base: Layout, brief: string, images: ImageInput[]) {
  const result = await structured({
    system: PROPOSAL_SYSTEM,
    effort: "high",
    schema: proposalSchema,
    content: [
      ...imageBlocks(images),
      {
        type: "text",
        text: `${propertyContext(p)}\n\n${wishesText(p)}\n\nCurrent plan:\n${describeLayout(base)}\n\nDesign this scenario:\n${brief}`,
      },
    ],
  });
  let layout: Layout = {
    ...cloneLayout(base),
    ceilingHeight: result.ceilingHeight || base.ceilingHeight,
    floors: result.floors
      .sort((a, b) => a.level - b.level)
      .map((f) => ({
        id: f.id,
        name: f.name,
        level: f.level,
        rooms: f.rooms
          .filter((r) => r.w > 0.3 && r.d > 0.3)
          .map((r) => ({
            id: r.id,
            name: r.name,
            type: asRoomType(r.type),
            x: r.x,
            y: r.y,
            w: r.w,
            d: r.d,
            ...(r.isNew ? { isNew: true } : {}),
            ...(r.wallColour || r.floorFinish
              ? {
                  finish: {
                    ...(r.wallColour && /^#[0-9a-f]{6}$/i.test(r.wallColour) ? { wall: r.wallColour } : {}),
                    ...(r.floorFinish && ["oak", "walnut", "tile", "stone", "carpet", "concrete", "vinyl"].includes(r.floorFinish)
                      ? { floor: r.floorFinish as "oak" }
                      : {}),
                  },
                }
              : {}),
          })),
      })),
  };
  layout = pruneLayout(layout);
  layout = applyWallInstructions(layout, result.walls.map((w) => ({ ...w, side: asSide(w.side), state: asWallState(w.state) })));
  return { name: result.name, tier: asTier(result.tier), description: result.description, layout };
}

// ─── Image prompts ───────────────────────────────────────────────────────

const promptSchema = z.object({
  prompt: z.string().describe("the complete instruction for the image model"),
});

const PROMPT_SYSTEM = `You write instructions for an image-editing model that re-imagines rooms in property photos. The output must look like a real interior photograph of the same room after renovation.

Always instruct the model to:
- keep the exact camera position, lens, perspective and the room's fixed architecture (window positions, ceiling height, stairs) unless the brief explicitly changes them;
- apply only the changes in the brief, with specific materials, colours and furniture;
- use natural daylight, realistic proportions, no people, no text or watermarks.
When the input is a rough 3D massing render rather than a photo, instruct the model to turn it into a photorealistic interior photograph, keeping the room geometry, openings and camera exactly, and furnishing it according to the brief.
Keep it under 180 words.`;

export async function writeRenderPrompt(image: ImageInput, brief: string, context: string, isMassing: boolean) {
  const result = await structured({
    system: PROMPT_SYSTEM,
    effort: "medium",
    schema: promptSchema,
    content: [
      ...imageBlocks([image]),
      {
        type: "text",
        text: `${isMassing ? "Input is a rough 3D massing render of a planned space." : "Input is a photo of the room as it is today."}\n\nHouse context:\n${context}\n\nBrief from the couple:\n${brief}`,
      },
    ],
  });
  return result.prompt;
}

export { propertyContext };
