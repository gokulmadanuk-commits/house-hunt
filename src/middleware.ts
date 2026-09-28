import { NextResponse, type NextRequest } from "next/server";
import { passcodeToken } from "./lib/auth";

export async function middleware(req: NextRequest) {
  const passcode = process.env.APP_PASSCODE;
  if (!passcode) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/api/login") return NextResponse.next();
  if (req.cookies.get("hh_auth")?.value === (await passcodeToken(passcode))) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Passcode required" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"] };
