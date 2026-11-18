#!/usr/bin/env node
// Records every /api/ws frame of one real Hermes turn to JSONL, so the app's computer-use parser is tested against
// what Hermes sends rather than what its docs say. Usage: see README.md beside this file.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const opts = parse(process.argv.slice(2));
const base = need("base").replace(/\/$/, "");
const out = need("out");
const profile = opts.profile ?? "default";
const answers = (opts.answers ?? "once").split(",");
const takeOverAfter = opts["take-over-after"] ? Number(opts["take-over-after"]) : null;
const interruptAfter = opts["interrupt-after"] ? Number(opts["interrupt-after"]) : null;
const cli = opts.cli ? opts.cli.split(";").map((c) => c.trim().split(/\s+/)) : [];
const turnTimeoutMs = Number(opts["timeout-s"] ?? 600) * 1000;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, "");
const t0 = Date.now();
const log = (dir, frame) => appendFileSync(out, JSON.stringify({ t: Date.now() - t0, dir, frame }) + "\n");

const password = readFileSync(need("password-file"), "utf8").replace(/\r?\n$/, "");
const login = await fetch(`${base}/auth/password-login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "basic", username: need("user"), password }),
});
if (!login.ok) die(`sign-in answered ${login.status}`);
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const ticketRes = await fetch(`${base}/api/auth/ws-ticket`, { method: "POST", headers: { cookie } });
if (!ticketRes.ok) die(`ws-ticket answered ${ticketRes.status}`);
const { ticket } = await ticketRes.json();

const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}`);
let nextId = 1;
const pending = new Map();
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const frame = { jsonrpc: "2.0", id, method, params };
    log("out", frame);
    ws.send(JSON.stringify(frame));
  });

let session = null;
let completes = 0;
let approvalsSeen = 0;
let viewer = null;
let held = false;
let finish;
const done = new Promise((r) => (finish = r));

ws.addEventListener("message", async (ev) => {
  const frame = JSON.parse(String(ev.data));
  log("in", frame);
  if (frame.id !== undefined && !frame.method) {
    const p = pending.get(frame.id);
    pending.delete(frame.id);
    if (frame.error) p?.reject(Object.assign(new Error(frame.error.message), { data: frame.error }));
    else p?.resolve(frame.result);
    return;
  }
  if (frame.method === "approval") {
    const choice = answers[Math.min(approvalsSeen++, answers.length - 1)];
    await call("approval.respond", { session_id: session, choice, request_id: frame.params.request_id }).catch((e) => note(`approval.respond failed: ${e.message}`));
    return;
  }
  if (frame.method !== "event") return;
  const { type, payload } = frame.params;
  if (type === "tool.complete" && payload?.name === "computer_use") {
    completes++;
    if (takeOverAfter !== null && completes === takeOverAfter && !held) {
      const seen = await call("display.observe", { profile }).catch((e) => note(`display.observe failed: ${e.message}`));
      viewer = seen?.viewer_id ?? null;
      if (viewer) held = Boolean(await call("display.lease.acquire", { profile, viewer_id: viewer, reason: "capture: human takes over" }).catch((e) => note(`acquire failed: ${e.message}`)));
    }
    if (interruptAfter !== null && completes === interruptAfter) {
      await call("session.interrupt", { session_id: session }).catch((e) => note(`interrupt failed: ${e.message}`));
    }
  }
  if (type === "message.complete") finish();
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
});
await call("client.capabilities", { server_requests: true });
for (const argv of cli) await call("cli.exec", { argv, timeout: 120, profile }).catch((e) => note(`cli.exec ${argv.join(" ")} failed: ${e.message}`));
await call("display.status", { profile }).catch((e) => note(`display.status failed: ${e.message}`));
if (opts.resume) {
  const resumed = await call("session.resume", { session_id: opts.resume, profile, inline_images: false });
  await call("session.close", { session_id: resumed.session_id }).catch(() => {});
}
if (opts["hold-s"]) {
  const seen = await call("display.observe", { profile });
  viewer = seen.viewer_id;
  held = Boolean(await call("display.lease.acquire", { profile, viewer_id: viewer, reason: "capture: hold with no stream" }));
  const until = Date.now() + Number(opts["hold-s"]) * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 15000));
    await call("display.status", { profile }).catch((e) => note(`display.status failed: ${e.message}`));
  }
}
if (opts.prompt) {
  const made = await call("session.create", { profile, source: "highwing-capture", title: "computer-use capture" });
  session = made.session_id;
  await call("prompt.submit", { session_id: session, profile, text: opts.prompt });
  const timer = setTimeout(() => {
    note("turn timed out; interrupting");
    call("session.interrupt", { session_id: session }).catch(() => {});
    setTimeout(finish, 15000);
  }, turnTimeoutMs);
  await done;
  clearTimeout(timer);
}
if (held) await call("display.lease.release", { profile, viewer_id: viewer }).catch((e) => note(`release failed: ${e.message}`));
if (session) await call("session.close", { session_id: session }).catch(() => {});
ws.close();
console.log(`recorded ${out}: ${completes} computer_use completes, ${approvalsSeen} approvals`);

function note(text) {
  log("note", { text });
  console.error(text);
  return null;
}
function need(key) {
  if (!opts[key]) die(`missing --${key}`);
  return opts[key];
}
function die(text) {
  console.error(`record: ${text}`);
  process.exit(1);
}
function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[++i];
  return o;
}
