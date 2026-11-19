#!/usr/bin/env node
// hermes-app: an MCP server (stdio) that drives the real Hermes Chat desktop app through ../scripts/hv and wd.mjs.
// Each agent session spawns its own server, so each T3 thread gets its own run: display, ports, data dir, live view.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as netServer } from "node:net";
import { dirname, join, normalize } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HV = join(HERE, "../scripts/hv");
const WD = join(HERE, "../scripts/wd.mjs");
const HV_HOME = process.env.HV_HOME ?? join(process.env.HOME, ".cache/hermes-verify");
const ROOT = join(HV_HOME, "root");
const NOVNC = join(HV_HOME, "novnc-1.6.0");
const REGISTRY = join(HV_HOME, "mcp");
const THREAD = process.env.T3CODE_THREAD_ID ?? `pid-${process.pid}`;
const log = (...a) => process.stderr.write(`hermes-app: ${a.join(" ")}\n`);

/** @type {null | { hvRun: string, state: Record<string,string>, vncPid: number, live: import("node:http").Server, livePort: number, step: number }} */
let run = null;
const events = [];
const listeners = new Set();
function emit(event) {
  const e = { step: run?.step ?? 0, t: Date.now(), ...event };
  events.push(e);
  if (events.length > 200) events.shift();
  for (const res of listeners) res.write(`data: ${JSON.stringify(e)}\n\n`);
}

function sh(cmd, args, { env = {}, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout, maxBuffer: 64 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${[cmd, ...args].join(" ")}: ${(stderr || stdout || err.message).trim().slice(-1500)}`)) : resolve(stdout.trim()),
    );
  });
}
const hv = (...args) => sh(HV, args, { env: { HV_RUN: run.hvRun } });
const wd = (...args) => sh(process.execPath, [WD, ...args], { env: { HV_RUN: run.hvRun } });
const freePort = () => new Promise((r) => { const s = netServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const readState = (dir) =>
  Object.fromEntries(readFileSync(join(dir, "state.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split(/=(.*)/s).slice(0, 2).map((v) => v.replace(/^'|'$/g, ""))));
// x11vnc quits when WAYLAND_DISPLAY is set at all, even empty, and a Wayland desktop's agent inherits it.
const withoutWayland = ({ WAYLAND_DISPLAY: _wayland, ...env }) => env;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A server that died without stopping (kill -9, a crashed CLI) leaves a registry entry with a dead owner. Its run is
// stopped here by the paths it recorded, never by process name, so other threads' runs are untouched.
async function reapOrphans() {
  mkdirSync(REGISTRY, { recursive: true });
  for (const f of readdirSync(REGISTRY)) {
    const entry = JSON.parse(readFileSync(join(REGISTRY, f), "utf8"));
    if (alive(entry.owner)) continue;
    log(`reaping run ${entry.hvRun} left by dead server ${entry.owner}`);
    if (entry.vncPid && alive(entry.vncPid)) try { process.kill(-entry.vncPid, "SIGKILL"); } catch {}
    if (existsSync(join(entry.hvRun, "state.env"))) await sh(HV, ["down"], { env: { HV_RUN: entry.hvRun } }).catch((e) => log(String(e)));
    rmSync(join(REGISTRY, f), { force: true });
  }
}

const ROLES = {
  button: "button, [role=button]",
  link: "a[href], [role=link]",
  textbox: "input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]",
  select: "select",
  tab: "[role=tab]",
  menuitem: "[role=menuitem]",
  checkbox: "input[type=checkbox], [role=checkbox], [role=switch]",
  dialog: "[role=dialog]",
  any: "*",
};
function locator({ role, name, selector }) {
  if (selector) return [selector, name ?? ""];
  if (!role && !name) throw new Error("give a role and a name (as listed in the snapshot), or a css selector");
  const css = ROLES[role ?? "any"];
  if (!css) throw new Error(`unknown role "${role}"; one of ${Object.keys(ROLES).join(", ")}`);
  return [css, name ?? ""];
}
const describe = (t) => `${t.selector ?? t.role ?? ""} "${t.name ?? ""}"`.replace(/ ""$/, "").trim();

// The click point in X screen coordinates: the webview's viewport point plus the app window's position on the display.
async function screenPoint(css, text) {
  const [x, y] = (await wd("where", css, text)).split(" ").map(Number);
  const geom = await hv("x", "getactivewindow", "getwindowgeometry", "--shell").catch(() => "X=0\nY=0");
  const g = Object.fromEntries(geom.split("\n").map((l) => l.split("=")));
  return { x: x + Number(g.X ?? 0), y: y + Number(g.Y ?? 0) };
}

// The open chat's last messages as text, so a client that can't see the screenshot still reads the reply.
const MESSAGES = `return [...document.querySelectorAll(".msg.user, .msg.assistant")].slice(-6)
  .map((m) => (m.classList.contains("user") ? "you: " : "hermes: ") + text(m).slice(0, 300));
  function text(m) { const c = m.cloneNode(true); c.querySelectorAll("button, [role=button]").forEach((b) => b.remove()); return c.textContent.trim().replace(/\\s+/g, " "); }`;
async function observe(label) {
  await new Promise((r) => setTimeout(r, 500));
  const name = `${String(run.step).padStart(2, "0")}-${label.replace(/[^\w-]+/g, "_").slice(0, 40)}`;
  const png = await wd("shot", name);
  const handles = await wd("handles").catch((e) => `(couldn't read the page: ${e.message})`);
  const messages = JSON.parse(await wd("eval", MESSAGES).catch(() => "[]"));
  return [
    {
      type: "text",
      text: `Visible controls (tag | role/type | label | text or value | disabled):\n${handles}${messages.length ? `\n\nLast messages in the open chat:\n${messages.join("\n")}` : ""}`,
    },
    { type: "image", mimeType: "image/png", data: readFileSync(png).toString("base64") },
  ];
}

function needRun() {
  if (!run) throw new Error("no app running in this thread: call start first");
  run.step++;
}

async function start({ dashboard } = {}) {
  if (run) return [{ type: "text", text: `Already running. Live view: http://127.0.0.1:${run.livePort}/` }, ...(await observe("status"))];
  await reapOrphans();
  const out = await sh(HV, ["up", ...(dashboard ? ["--dashboard", dashboard] : [])], { timeout: 180000 });
  const hvRun = out.match(/^export HV_RUN=(.*)$/m)?.[1];
  if (!hvRun) throw new Error(`hv up printed no HV_RUN:\n${out}`);
  const state = readState(hvRun);
  run = { hvRun, state, vncPid: 0, live: null, livePort: 0, step: 0 };
  try {
    const vncPort = await freePort();
    const x11vnc = existsSync(join(ROOT, "usr/bin/x11vnc")) ? join(ROOT, "usr/bin/x11vnc") : "x11vnc";
    const vnc = spawn(x11vnc, ["-display", state.DISPLAY_NUM, "-rfbport", String(vncPort), "-localhost", "-nopw", "-shared", "-forever", "-viewonly", "-noipv6", "-quiet"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...withoutWayland(process.env), XDG_SESSION_TYPE: "x11", LD_LIBRARY_PATH: `${ROOT}/usr/lib/x86_64-linux-gnu:${ROOT}/lib/x86_64-linux-gnu:${ROOT}/usr/lib` },
    });
    vnc.unref();
    run.vncPid = vnc.pid;
    run.livePort = await freePort();
    run.live = liveServer(vncPort);
    await new Promise((r) => run.live.listen(run.livePort, "127.0.0.1", r));
    writeFileSync(join(REGISTRY, `${process.pid}.json`), JSON.stringify({ owner: process.pid, thread: THREAD, hvRun, vncPid: run.vncPid, livePort: run.livePort }));
    await wd("open");
    await wd("wait", "button", "", "60000");
  } catch (e) {
    await stop().catch(() => {});
    throw e;
  }
  emit({ kind: "start", label: `started on display ${state.DISPLAY_NUM}` });
  const text = [
    `Hermes Chat is running for thread ${THREAD} on display ${state.DISPLAY_NUM}.`,
    `Live view: http://127.0.0.1:${run.livePort}/ (port ${run.livePort} on this machine)`,
    state.STANDIN === "yes" ? `Stand-in Hermes dashboard: ${state.DASHBOARD_URL} (username verify, password verify-pass)` : `Dashboard: ${state.DASHBOARD_URL}`,
    `Evidence folder: ${state.EVIDENCE}`,
  ].join("\n");
  return [{ type: "text", text }, ...(await observe("start"))];
}

async function stop() {
  if (!run) return [{ type: "text", text: "Nothing running." }];
  const { hvRun, vncPid, live, state } = run;
  run.step++;
  emit({ kind: "stop", label: "stopped" });
  for (const res of listeners) res.end();
  listeners.clear();
  live?.closeAllConnections?.();
  live?.close();
  if (vncPid && alive(vncPid)) try { process.kill(-vncPid, "SIGKILL"); } catch {}
  const out = await sh(HV, ["down"], { env: { HV_RUN: hvRun } }).catch((e) => String(e));
  rmSync(join(REGISTRY, `${process.pid}.json`), { force: true });
  run = null;
  return [{ type: "text", text: `Stopped. Evidence kept in ${state.EVIDENCE}.\n${out}` }];
}

const TOOLS = {
  start: {
    description:
      "Start this thread's own copy of the Hermes Chat desktop app (own display, ports, data folder) against a stand-in Hermes dashboard, and return a live-view URL. Call once before anything else. Every tool returns a screenshot and the visible controls.",
    schema: { type: "object", properties: { dashboard: { type: "string", description: "A real Hermes dashboard URL. Omit for the stand-in." } } },
    run: start,
  },
  snapshot: { description: "Screenshot and visible controls, with no action.", schema: { type: "object", properties: {} }, run: async () => (needRun(), observe("snapshot")) },
  click: {
    description: 'Click a control the way a person would. Target it by role and the name shown in the snapshot (role "button", name "Get started"), or by css selector.',
    schema: target({}),
    run: async (t) => {
      needRun();
      const [css, text] = locator(t);
      const p = await screenPoint(css, text);
      emit({ kind: "click", ...p, label: describe(t) });
      await wd("click", css, text);
      return observe(`click-${t.name ?? t.selector ?? t.role}`);
    },
  },
  type: {
    description: "Clear a text field and type into it as key presses. Set submit to press Enter afterwards.",
    schema: target({ text: { type: "string" }, submit: { type: "boolean" } }, ["text"]),
    run: async (t) => {
      needRun();
      const [css, text] = locator({ role: "textbox", ...t });
      const p = await screenPoint(css, text);
      emit({ kind: "type", ...p, label: `${describe(t)} ← ${t.text.slice(0, 40)}` });
      await wd("fill", css, text, "--", t.text);
      if (t.submit) await wd("press", "Enter");
      return observe(`type-${t.name ?? t.selector ?? t.role}`);
    },
  },
  select: {
    description: "Pick an option in a native <select> (its popup never renders here).",
    schema: target({ option: { type: "string" } }, ["option"]),
    run: async (t) => {
      needRun();
      const [css, text] = locator({ role: "select", ...t });
      const p = await screenPoint(css, text);
      emit({ kind: "select", ...p, label: `${describe(t)} → ${t.option}` });
      await wd("select", css, text, "--", t.option);
      return observe(`select-${t.option}`);
    },
  },
  press: {
    description: "Press a key chord: Enter, Escape, Tab, Control+k, Shift+Tab, ArrowDown.",
    schema: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
    run: async ({ keys }) => {
      needRun();
      emit({ kind: "press", label: keys });
      await wd("press", keys);
      return observe(`press-${keys}`);
    },
  },
  wait: {
    description: "Wait until text (or a control) is visible, or gone. Use instead of sleeping, e.g. to wait for a reply.",
    schema: target({ gone: { type: "boolean" }, timeoutMs: { type: "number" } }),
    run: async (t) => {
      needRun();
      const [css, text] = locator(t);
      emit({ kind: "wait", label: `${t.gone ? "gone" : "wait"} ${describe(t)}` });
      await wd(t.gone ? "gone" : "wait", css, text, String(t.timeoutMs ?? 20000));
      return observe(`wait-${t.name ?? t.selector ?? t.role}`);
    },
  },
  stop: { description: "Shut this thread's app down and free its display and ports. Evidence is kept.", schema: { type: "object", properties: {} }, run: stop },
};
function target(extra, required = []) {
  return {
    type: "object",
    properties: {
      role: { type: "string", enum: Object.keys(ROLES), description: "Kind of control, as in the snapshot's first columns." },
      name: { type: "string", description: "Visible text, aria-label, title, placeholder or <label> (substring, case-sensitive)." },
      selector: { type: "string", description: "A css selector instead of role, e.g. textarea[data-composer] or .msg.assistant." },
      ...extra,
    },
    required,
  };
}

// The live view: noVNC on this run's display, with a marker where each action lands (events over SSE).
function liveServer(vncPort) {
  const types = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") {
      const page = readFileSync(join(HERE, "live.html"), "utf8").replace("__META__", JSON.stringify({ thread: THREAD, display: run?.state.DISPLAY_NUM }));
      return res.writeHead(200, { "content-type": "text/html" }).end(page);
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const e of events) res.write(`data: ${JSON.stringify({ ...e, replay: true })}\n\n`);
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      return;
    }
    if (url.pathname.startsWith("/novnc/")) {
      const file = normalize(join(NOVNC, url.pathname.slice(7)));
      if (file.startsWith(NOVNC) && existsSync(file)) return res.writeHead(200, { "content-type": types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" }).end(readFileSync(file));
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => (req.url === "/websockify" ? wsProxy(req, socket, head, vncPort) : socket.destroy()));
  return server;
}

// A minimal websockify: WebSocket binary frames in and out, raw RFB to x11vnc.
function wsProxy(req, socket, head, port) {
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  const proto = (req.headers["sec-websocket-protocol"] ?? "").split(",")[0].trim();
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, ...(proto ? [`Sec-WebSocket-Protocol: ${proto}`] : []), "", ""].join("\r\n"));
  const frame = (op, data) => {
    const n = data.length;
    const hdr = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.alloc(10);
    if (n >= 65536) { hdr[0] = 0x80 | op; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(n), 2); }
    return Buffer.concat([hdr, data]);
  };
  const vnc = connect(port, "127.0.0.1");
  vnc.on("data", (d) => socket.write(frame(2, d)));
  const end = () => { vnc.destroy(); socket.destroy(); };
  vnc.on("error", end).on("close", end);
  socket.on("error", end).on("close", end);
  let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15, masked = buf[1] & 128;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mask = masked ? buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      if (op === 8) return end();
      if (op === 9) socket.write(frame(10, payload));
      else if (op <= 2) vnc.write(payload);
    }
  });
}

// MCP over stdio: one JSON-RPC message per line.
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  try {
    if (method === "initialize")
      return send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hermes-app", version: "0.0.1-prototype" } } });
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list")
      return send({ id, result: { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })) } });
    if (method === "tools/call") {
      const tool = TOOLS[params.name];
      if (!tool) return send({ id, error: { code: -32602, message: `unknown tool ${params.name}` } });
      try {
        return send({ id, result: { content: await tool.run(params.arguments ?? {}) } });
      } catch (e) {
        const content = [{ type: "text", text: `Error: ${e.message}` }];
        if (run && params.name !== "stop") content.push(...(await observe("error").catch(() => [])));
        return send({ id, result: { isError: true, content } });
      }
    }
    send({ id, error: { code: -32601, message: `no method ${method}` } });
  } catch (e) {
    send({ id, error: { code: -32603, message: String(e.message ?? e) } });
  }
});
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  await stop().catch((e) => log(String(e)));
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown).on("SIGINT", shutdown).on("SIGHUP", shutdown);
