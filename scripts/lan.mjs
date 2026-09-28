// Serves the production build on every network interface and prints the
// addresses to open from a phone or laptop on the same WiFi.
import { spawn } from "node:child_process";
import os from "node:os";

const port = process.env.PORT || "3000";
const urls = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal)
  .map((a) => `http://${a.address}:${port}`);

console.log("\n  House Hunt is starting.\n");
console.log(`  On this computer:          http://localhost:${port}`);
for (const u of urls) console.log(`  On your phone (same WiFi): ${u}`);
if (!urls.length) console.log("  (No network address found — are you connected to WiFi?)");
console.log("\n  Press Ctrl+C to stop.\n");

const child = spawn("npx", ["next", "start", "-H", "0.0.0.0", "-p", port], { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 0));
