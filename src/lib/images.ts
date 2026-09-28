import "server-only";
import sharp from "sharp";

/** Normalise any incoming image: fix orientation, cap size, re-encode as JPEG. */
export async function normaliseImage(input: Buffer, maxSide = 2000, quality = 86): Promise<Buffer> {
  return sharp(input, { failOn: "none" })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}

export async function imageSize(input: Buffer) {
  const m = await sharp(input).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0 };
}

export function dataUrlToBuffer(dataUrl: string): { data: Buffer; mime: string } {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error("Invalid image data");
  return { mime: m[1], data: Buffer.from(m[2], "base64") };
}
