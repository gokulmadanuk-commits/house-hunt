import "server-only";

export function householdMembers(): string[] {
  const raw = process.env.HOUSEHOLD_MEMBERS || "Gokul,Laura";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function claudeEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export type ImageProvider = "gemini" | "openai";

export function imageProvider(): ImageProvider | null {
  const forced = process.env.IMAGE_PROVIDER?.toLowerCase();
  if (forced === "gemini" && process.env.GEMINI_API_KEY) return "gemini";
  if (forced === "openai" && process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

export interface ClientConfig {
  members: string[];
  claude: boolean;
  images: ImageProvider | null;
}

export function clientConfig(): ClientConfig {
  return { members: householdMembers(), claude: claudeEnabled(), images: imageProvider() };
}
