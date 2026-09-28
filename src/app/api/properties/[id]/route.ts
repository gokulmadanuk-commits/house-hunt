import * as z from "zod/v4";
import { errorResponse, runOp } from "@/lib/ops";
import { deleteProperty, getProperty } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const p = await getProperty((await params).id);
  return p ? Response.json(p) : Response.json({ error: "Not found" }, { status: 404 });
}

const opBody = z.object({ op: z.string(), args: z.record(z.string(), z.unknown()).default({}) });

export async function POST(req: Request, { params }: Ctx) {
  try {
    const { op, args } = opBody.parse(await req.json());
    return Response.json(await runOp((await params).id, op, args));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  await deleteProperty((await params).id);
  return Response.json({ ok: true });
}
