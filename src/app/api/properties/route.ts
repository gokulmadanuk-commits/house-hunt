import * as z from "zod/v4";
import { normaliseImage } from "@/lib/images";
import { newId } from "@/lib/layout";
import { downloadImage, readListing } from "@/lib/listing";
import { errorResponse } from "@/lib/ops";
import { sampleProperty } from "@/lib/sample";
import { listProperties, saveProperty, saveUpload } from "@/lib/store";
import type { Photo, Property } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET() {
  return Response.json(await listProperties());
}

function blankProperty(fields: Partial<Property>): Property {
  const now = new Date().toISOString();
  return {
    id: newId("p"),
    title: "Untitled property",
    address: "",
    features: [],
    status: "viewing",
    ratings: {},
    photos: [],
    notes: [],
    wishes: [],
    scenarios: [],
    renders: [],
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

const body = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("demo"), author: z.string() }),
  z.object({ mode: z.literal("manual"), title: z.string().min(1), address: z.string().default(""), price: z.string().optional(), listingUrl: z.string().optional() }),
  z.object({ mode: z.literal("import"), url: z.string().min(4) }),
]);

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export async function POST(req: Request) {
  try {
    const input = body.parse(await req.json());
    if (input.mode === "demo") return Response.json(await saveProperty(sampleProperty(input.author)));
    if (input.mode === "manual") {
      const { mode: _m, ...fields } = input;
      return Response.json(await saveProperty(blankProperty(fields)));
    }

    const { data, via } = await readListing(input.url);
    if (!data.found) return Response.json({ error: "That page doesn't look like a property listing." }, { status: 422 });
    const p = blankProperty({
      title: data.title || data.address || "Imported property",
      address: data.address,
      price: data.price || undefined,
      listingUrl: input.url,
      bedrooms: data.bedrooms ?? undefined,
      bathrooms: data.bathrooms ?? undefined,
      propertyType: data.propertyType || undefined,
      description: data.description,
      features: data.features,
    });
    const wanted = [
      ...data.floorplanUrls.slice(0, 6).map((u) => ({ u, kind: "floorplan" as const })),
      ...data.photoUrls.slice(0, 30).map((u) => ({ u, kind: "photo" as const })),
    ];
    const seen = new Set<string>();
    const photos = await mapLimit(wanted, 6, async ({ u, kind }): Promise<Photo | null> => {
      if (seen.has(u)) return null;
      seen.add(u);
      const img = await downloadImage(u, input.url);
      if (!img) return null;
      try {
        const file = await saveUpload(p.id, await normaliseImage(img.data, kind === "floorplan" ? 2400 : 2000, 88), "image/jpeg", kind === "floorplan" ? "plan" : "img");
        return { id: newId("ph"), file, kind, sourceUrl: u };
      } catch {
        return null;
      }
    });
    // Photos first in listing order, floor plans after.
    p.photos = [...photos.filter((x): x is Photo => !!x && x.kind === "photo"), ...photos.filter((x): x is Photo => !!x && x.kind === "floorplan")];
    await saveProperty(p);
    return Response.json({ ...p, importedVia: via, imageCount: p.photos.length });
  } catch (err) {
    return errorResponse(err);
  }
}
