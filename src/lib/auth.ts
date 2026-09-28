// Shared-passcode gate. Runs in middleware (edge) and route handlers, so it
// only uses Web Crypto.

export async function passcodeToken(passcode: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`house-hunt:${passcode}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
