import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadEnv } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const client = loadEnv("development", root, "VITE_");
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

function start(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
  children.add(child);
  child.on("error", error => { console.error(error.message); stop(1); });
  child.on("exit", code => { children.delete(child); if (!stopping) stop(code ?? 1); });
  return child;
}

async function ensureSignaling() {
  if (client.VITE_DEV_SIGNALING_PROXY !== "true" || !client.VITE_SIGNALING_URL) return;
  const target = new URL(client.VITE_SIGNALING_URL);
  if (!["ws:", "wss:"].includes(target.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
    throw new Error("Development signaling requires VITE_SIGNALING_URL to point to the local signaling server.");
  }
  target.protocol = target.protocol === "wss:" ? "https:" : "http:";
  target.pathname = "/health";
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(1500) });
    if (response.ok && (await response.json()).ok) {
      console.log("CallaStar signaling is already running.");
      return;
    }
  } catch { /* Start the missing service below. */ }
  const envFile = path.join(root, "server/signaling/.env");
  const env = { ...process.env, ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {}) };
  env.SIGNALING_PORT = target.port || (target.protocol === "https:" ? "443" : "80");
  env.SIGNALING_HOST = "127.0.0.1";
  env.SIGNALING_ALLOWED_ORIGINS = [...new Set([
    ...(env.SIGNALING_ALLOWED_ORIGINS ?? "").split(","), "http://localhost:8443", "http://127.0.0.1:8443",
  ].filter(Boolean))].join(",");
  if (!env.SIGNALING_HOST_SECRET || env.SIGNALING_HOST_SECRET !== client.VITE_SIGNALING_HOST_TOKEN) {
    throw new Error("The development operator token must match SIGNALING_HOST_SECRET in server/signaling/.env.");
  }
  if (client.VITE_CALL_BACKEND === "supabase" || client.VITE_ADMIN_DATA_MODE === "supabase") {
    if (!client.VITE_SUPABASE_URL || !client.VITE_SUPABASE_ANON_KEY) throw new Error("Supabase configuration is required for ticket enforcement.");
    env.SIGNALING_CALL_ACCESS_URL = `${client.VITE_SUPABASE_URL.replace(/\/$/, "")}/functions/v1/update-call-session`;
    env.SIGNALING_SUPABASE_ANON_KEY = client.VITE_SUPABASE_ANON_KEY;
  }
  start([path.join(root, "server/signaling/src/index.ts")], env);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (stopping) throw new Error("The signaling service stopped before becoming ready.");
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).ok) return;
    } catch { /* Wait for the listener. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("The signaling service did not become ready.");
}

try {
  await ensureSignaling();
  if (!process.argv.includes("--signaling-only") && !stopping) {
    start([path.join(root, "node_modules/vite/bin/vite.js"), ...process.argv.slice(2)], process.env);
  }
} catch (error) {
  console.error(error.message);
  stop(1);
}
