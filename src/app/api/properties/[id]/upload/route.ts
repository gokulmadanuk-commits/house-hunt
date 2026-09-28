import { normaliseImage } from "@/lib/images";
import { newId } from "@/lib/layout";
import { errorResponse, OpError } from "@/lib/ops";
import { saveUpload, updateProperty } from "@/lib/store";
import type { Photo } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const form = await req.formData();
    const kind = form.get("kind") === "floorplan" ? "floorplan" : "photo";
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (!files.length) throw new OpError("No files uploaded.");
    const photos: Photo[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      let data: Buffer;
      try {
        data = await normaliseImage(Buffer.from(await f.arrayBuffer()), kind === "floorplan" ? 2400 : 2000);
      } catch {
        skipped.push(f.name);
        continue;
      }
      const file = await saveUpload(id, data, "image/jpeg", kind === "floorplan" ? "plan" : "img");
      photos.push({ id: newId("ph"), file, kind, caption: f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").slice(0, 60) });
    }
    if (!photos.length) {
      throw new OpError(
        `Couldn't read ${skipped.join(", ")}. Use JPEG, PNG or WebP — iPhone HEIC photos can be exported as JPEG (or set Camera → Formats → Most Compatible).`,
      );
    }
    return Response.json(await updateProperty(id, (p) => void p.photos.push(...photos)));
  } catch (err) {
    return errorResponse(err);
  }
}
