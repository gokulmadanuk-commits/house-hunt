import "server-only";
// Imports a property from a listing link (PropertyPal, Rightmove, Zoopla,
// agent sites). We fetch the page ourselves and let Claude pick out the
// details and image URLs; if the site blocks us, Claude fetches it instead.
// Images are downloaded and kept locally — listings disappear once sold.

import { lookup } from "node:dns/promises";
import net from "node:net";
import { claudeEnabled } from "./config";
import { extractListing, extractListingViaWebFetch, type ListingData } from "./claude";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export class ListingError extends Error {}

function isPrivateIp(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}

/** Only fetch public http(s) URLs — the server shouldn't be usable to probe its own network. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ListingError("That doesn't look like a valid link.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new ListingError("Only http(s) links are supported.");
  if (url.hostname === "localhost" || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) throw new ListingError("That host isn't allowed.");
  try {
    const addrs = await lookup(url.hostname, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) throw new ListingError("That host isn't allowed.");
  } catch (e) {
    if (e instanceof ListingError) throw e;
    // DNS may be unavailable behind some proxies; let the fetch decide.
  }
  return url;
}

async function fetchHtml(url: URL): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-GB,en;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new ListingError(`The listing site responded ${res.status}.`);
  const html = await res.text();
  if (/cf-browser-verification|challenge-platform|Just a moment\.\.\./i.test(html) && html.length < 50_000) {
    throw new ListingError("The listing site served a bot check.");
  }
  return html;
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\\u002F/g, "/").replace(/\\\//g, "/");

function meta(html: string, prop: string) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
  return decode(re.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? "");
}

export function imageCandidates(html: string, base: URL): string[] {
  const out = new Set<string>();
  const re = /(https?:)?\/\/[^\s"'()<>\\]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'()<>\\]*)?/gi;
  for (const m of decode(html).matchAll(re)) {
    try {
      const u = new URL(m[0].startsWith("//") ? `${base.protocol}${m[0]}` : m[0]);
      if (/logo|icon|favicon|sprite|avatar|badge|placeholder|epc/i.test(u.pathname)) continue;
      out.add(u.toString());
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

/** Compact, model-friendly digest of a listing page. */
export function digestPage(html: string, url: URL): string {
  const parts: string[] = [];
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  if (title) parts.push(`TITLE: ${decode(title).trim()}`);
  for (const k of ["og:title", "og:description", "description", "og:image"]) {
    const v = meta(html, k);
    if (v) parts.push(`META ${k}: ${v}`);
  }
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    parts.push(`JSON-LD: ${m[1].trim().slice(0, 20_000)}`);
  }
  const next = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (next) parts.push(`__NEXT_DATA__: ${next.slice(0, 150_000)}`);
  if (!next) {
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    parts.push(`PAGE TEXT: ${decode(text).slice(0, 40_000)}`);
  }
  const imgs = imageCandidates(html, url);
  parts.push(`IMAGE URLS FOUND (${imgs.length}):\n${imgs.slice(0, 300).join("\n")}`);
  return parts.join("\n\n");
}

/** Best-effort extraction without Claude (meta tags + URL heuristics). */
function heuristicListing(html: string, url: URL): ListingData {
  const imgs = imageCandidates(html, url);
  const og = meta(html, "og:image");
  const plans = imgs.filter((u) => /floor|plan/i.test(u));
  const photos = [og, ...imgs.filter((u) => !plans.includes(u))].filter(Boolean);
  const title = meta(html, "og:title") || decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "").trim();
  return {
    found: true,
    title: title || url.hostname,
    address: title,
    price: "",
    bedrooms: null,
    bathrooms: null,
    propertyType: "",
    description: meta(html, "og:description") || meta(html, "description"),
    features: [],
    photoUrls: [...new Set(photos)].slice(0, 20),
    floorplanUrls: plans.slice(0, 4),
  };
}

export async function readListing(rawUrl: string): Promise<{ data: ListingData; via: string }> {
  const url = await assertPublicUrl(rawUrl);
  let html: string | null = null;
  let fetchError: unknown = null;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    fetchError = e;
  }
  if (html) {
    if (claudeEnabled()) return { data: await extractListing(url.toString(), digestPage(html, url)), via: "page+claude" };
    return { data: heuristicListing(html, url), via: "page" };
  }
  if (claudeEnabled()) {
    const data = await extractListingViaWebFetch(url.toString());
    return { data, via: "claude-web-fetch" };
  }
  throw new ListingError(
    `Couldn't read that listing (${fetchError instanceof Error ? fetchError.message : "fetch failed"}). Add the property manually and upload the photos and floor plan instead.`,
  );
}

export async function downloadImage(rawUrl: string, referer?: string): Promise<{ data: Buffer; mime: string } | null> {
  try {
    const url = await assertPublicUrl(rawUrl);
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "image/avif,image/webp,image/*,*/*;q=0.8", ...(referer ? { referer } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const mime = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    if (!mime.startsWith("image/")) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < 4_000) return null; // thumbnails / tracking pixels
    return { data, mime };
  } catch {
    return null;
  }
}
