import { passcodeToken } from "@/lib/auth";

export async function POST(req: Request) {
  const { passcode } = (await req.json().catch(() => ({}))) as { passcode?: string };
  const expected = process.env.APP_PASSCODE;
  if (!expected) return Response.json({ ok: true });
  if (!passcode || passcode !== expected) return Response.json({ error: "That passcode isn't right." }, { status: 401 });
  const token = await passcodeToken(expected);
  return Response.json(
    { ok: true },
    { headers: { "set-cookie": `hh_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}${process.env.NODE_ENV === "production" ? "; Secure" : ""}` } },
  );
}
