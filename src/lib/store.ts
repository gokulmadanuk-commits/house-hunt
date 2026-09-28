import "server-only";
// File-based store: one JSON document per property plus an uploads folder.
// Human-readable, trivially backed up (copy the data folder), and plenty for
// a household-sized dataset.

import { promises as fs } from "node:fs";
import path from "node:path";
import { newId } from "./layout";
import type { Property } from "./types";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const PROPS_DIR = path.join(DATA_DIR, "properties");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

async function ensureDirs() {
  await fs.mkdir(PROPS_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

const validId = (id: string) => /^[a-z0-9]+$/i.test(id);

export async function listProperties(): Promise<Property[]> {
  await ensureDirs();
  const files = (await fs.readdir(PROPS_DIR)).filter((f) => f.endsWith(".json"));
  const props = await Promise.all(
    files.map(async (f) => JSON.parse(await fs.readFile(path.join(PROPS_DIR, f), "utf8")) as Property),
  );
  return props.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProperty(id: string): Promise<Property | null> {
  if (!validId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(PROPS_DIR, `${id}.json`), "utf8")) as Property;
  } catch {
    return null;
  }
}

// Serialise writes per property so two quick edits can't interleave.
const locks = new Map<string, Promise<unknown>>();

export async function saveProperty(p: Property): Promise<Property> {
  await ensureDirs();
  p.updatedAt = new Date().toISOString();
  const file = path.join(PROPS_DIR, `${p.id}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(p, null, 2));
  await fs.rename(tmp, file);
  return p;
}

/** Read-modify-write under a per-property lock. */
export async function updateProperty(id: string, fn: (p: Property) => void | Promise<void>): Promise<Property> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(async () => {
    const p = await getProperty(id);
    if (!p) throw new NotFoundError(`Property ${id} not found`);
    await fn(p);
    return saveProperty(p);
  });
  locks.set(id, next.catch(() => undefined));
  return next;
}

export async function deleteProperty(id: string) {
  if (!validId(id)) return;
  await fs.rm(path.join(PROPS_DIR, `${id}.json`), { force: true });
  await fs.rm(path.join(UPLOADS_DIR, id), { recursive: true, force: true });
}

export class NotFoundError extends Error {}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function extForMime(mime: string) {
  return EXT[mime] ?? "jpg";
}

export function mimeForFile(file: string) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? (ext === "jpeg" ? "image/jpeg" : "application/octet-stream");
}

/** Writes an upload for a property and returns its path relative to the uploads dir. */
export async function saveUpload(propertyId: string, data: Buffer, mime: string, prefix = "img"): Promise<string> {
  if (!validId(propertyId)) throw new Error("bad id");
  const dir = path.join(UPLOADS_DIR, propertyId);
  await fs.mkdir(dir, { recursive: true });
  const name = `${prefix}-${newId()}.${extForMime(mime)}`;
  await fs.writeFile(path.join(dir, name), data);
  return `${propertyId}/${name}`;
}

export function resolveUpload(rel: string): string | null {
  const full = path.resolve(UPLOADS_DIR, rel);
  if (!full.startsWith(UPLOADS_DIR + path.sep)) return null;
  return full;
}

export async function readUpload(rel: string): Promise<{ data: Buffer; mime: string } | null> {
  const full = resolveUpload(rel);
  if (!full) return null;
  try {
    return { data: await fs.readFile(full), mime: mimeForFile(full) };
  } catch {
    return null;
  }
}

export async function deleteUpload(rel: string) {
  const full = resolveUpload(rel);
  if (full) await fs.rm(full, { force: true });
}
