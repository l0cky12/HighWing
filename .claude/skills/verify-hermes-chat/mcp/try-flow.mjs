#!/usr/bin/env node
// Drives server.mjs over MCP stdio through the short flow: sign in to the stand-in, start a new chat, send, see the reply.
//   try-flow.mjs [message] [pause-ms]     pause-ms slows each step so a live view can be watched or recorded
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const message = process.argv[2] ?? `hello from ${process.pid}`;
const pause = Number(process.argv[3] ?? 0);
const server = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;
createInterface({ input: server.stdout }).on("line", (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id); });
const rpc = (method, params) => new Promise((r) => { const id = nextId++; pending.set(id, r); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const t0 = Date.now();
async function call(name, args = {}) {
  if (pause) await new Promise((r) => setTimeout(r, pause));
  const { result, error } = await rpc("tools/call", { name, arguments: args });
  const text = result?.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(error);
  const images = result?.content?.filter((c) => c.type === "image").length ?? 0;
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${name} ${JSON.stringify(args)} -> ${result?.isError ? "ERROR " : ""}${images} image(s)\n  ${text.split("\n").slice(0, 4).join("\n  ")}${text.includes("Last messages") ? "\n  " + text.slice(text.indexOf("Last messages")).replaceAll("\n", "\n  ") : ""}`);
  if (error || result.isError) { await rpc("tools/call", { name: "stop", arguments: {} }); process.exit(1); }
  return text;
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "try-flow", version: "0" } });
const started = await call("start");
const dashboard = started.match(/Stand-in Hermes dashboard: (\S+)/)[1];
await call("click", { role: "button", name: "Get started" });
await call("select", { name: "Connect through", option: "Web address" });
await call("type", { name: "Dashboard URL", text: dashboard });
await call("click", { role: "button", name: "Test the route" });
await call("wait", { selector: "[role=status]", name: "Reached Hermes" });
await call("click", { role: "button", name: "Next" });
await call("type", { name: "Dashboard username", text: "verify" });
await call("type", { name: "Dashboard password", text: "verify-pass" });
await call("click", { role: "button", name: "Test connection" });
await call("wait", { selector: "[role=status]", name: "At least one route works" });
await call("click", { role: "button", name: "Save and connect" });
await call("wait", { selector: ".setup-ok", name: "You're ready to chat" });
await call("click", { role: "button", name: "Skip" });
await call("wait", { role: "dialog", gone: true });
await call("click", { role: "button", name: "New chat (Ctrl+N)" });
await call("type", { selector: "textarea[data-composer]", text: message, submit: true });
await call("wait", { selector: ".msg.assistant", name: `Stand-in reply to: ${message}`, timeoutMs: 30000 });
if (pause) await new Promise((r) => setTimeout(r, 3000));
await call("stop");
server.stdin.end();
