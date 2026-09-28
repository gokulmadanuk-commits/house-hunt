import "server-only";
// Image-to-image generation. Claude writes the prompt; a dedicated image
// model does the pixels. Supports Google Gemini image models and OpenAI's
// image edit endpoint — whichever key is configured.

import { imageProvider } from "./config";

export class ImageGenError extends Error {}

export interface GeneratedImage {
  data: Buffer;
  mime: string;
  provider: string;
}

export async function generateImage(input: { data: Buffer; mime: string }, prompt: string): Promise<GeneratedImage> {
  const provider = imageProvider();
  if (!provider) throw new ImageGenError("No image model configured — set GEMINI_API_KEY or OPENAI_API_KEY.");
  return provider === "gemini" ? gemini(input, prompt) : openai(input, prompt);
}

async function gemini(input: { data: Buffer; mime: string }, prompt: string): Promise<GeneratedImage> {
  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ inline_data: { mime_type: input.mime, data: input.data.toString("base64") } }, { text: prompt }],
        },
      ],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = (await res.json().catch(() => null)) as {
    error?: { message?: string };
    candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string }; inline_data?: { mime_type: string; data: string }; text?: string }[] }; finishReason?: string }[];
  } | null;
  if (!res.ok) throw new ImageGenError(`Gemini error ${res.status}: ${json?.error?.message ?? "unknown"}`);
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const d = p.inlineData ?? (p.inline_data && { mimeType: p.inline_data.mime_type, data: p.inline_data.data });
    if (d?.data) return { data: Buffer.from(d.data, "base64"), mime: d.mimeType || "image/png", provider: `gemini:${model}` };
  }
  const text = parts.map((p) => p.text).filter(Boolean).join(" ");
  throw new ImageGenError(`Gemini returned no image${text ? `: ${text.slice(0, 200)}` : ` (${json?.candidates?.[0]?.finishReason ?? "no reason"})`}`);
}

async function openai(input: { data: Buffer; mime: string }, prompt: string): Promise<GeneratedImage> {
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", "auto");
  form.append("image", new Blob([new Uint8Array(input.data)], { type: input.mime }), `input.${input.mime.split("/")[1] || "jpg"}`);
  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(240_000),
  });
  const json = (await res.json().catch(() => null)) as { error?: { message?: string }; data?: { b64_json?: string }[] } | null;
  if (!res.ok) throw new ImageGenError(`OpenAI error ${res.status}: ${json?.error?.message ?? "unknown"}`);
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new ImageGenError("OpenAI returned no image.");
  return { data: Buffer.from(b64, "base64"), mime: "image/png", provider: `openai:${model}` };
}
