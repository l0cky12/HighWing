// Settings' scroll-spy cost in headless Chromium, where the DevTools protocol splits main-thread time into script,
// style and layout. Builds tools/shots (the signed-in app with an in-page fake), opens Settings, and on each page that
// scrolls moves between its first and a later section <n> times, two frames apart, then the same number of times
// within the first section (`same`), where the current jump link stays. Prints one JSON line per page.
// Chromium paints differently from WebKitGTK, so this times the work, not the app's frames: run.sh does that.
//   node bench/settings-scroll/chromium.mjs [n] [label]
import { build, preview } from "vite";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const n = Number(process.argv[2] ?? 100);
const label = process.argv[3] ?? "build";
const PAGES = ["Appearance", "Keyboard Shortcuts", "Voice", "Model", "Providers"];
const configFile = fileURLToPath(new URL("../../tools/shots/vite.config.ts", import.meta.url));
function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), ".cache/ms-playwright");
  const dir = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
  const sub = readdirSync(join(cache, dir)).find((d) => d.startsWith("chrome-"));
  return join(cache, dir, sub, "chrome-headless-shell");
}
await build({ configFile, logLevel: "error" });
const server = await preview({ configFile, preview: { port: 0, host: "127.0.0.1" } });
const url = server.resolvedUrls.local[0];
const profile = mkdtempSync(join(tmpdir(), "settings-scroll-"));
const proc = spawn(chrome(), ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,900", "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const port = await new Promise((resolve, reject) => {
  let err = "";
  proc.stderr.on("data", (d) => {
    const m = (err += d).match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
    if (m) resolve(m[1]);
  });
  proc.on("exit", (code) => reject(new Error(`Chromium exited (${code}):\n${err}`)));
});
try {
  const target = /** @type {{ webSocketDebuggerUrl: string }} */ (await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })).json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
  });
  const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  const evaluate = async (expression) => {
    const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = (cond) => evaluate(`new Promise((ok, no) => { const t0 = Date.now(); const f = () => (${cond}) ? ok(1) : Date.now() - t0 > 20000 ? no(new Error("timed out: " + ${JSON.stringify(cond)})) : setTimeout(f, 50); f(); })`);
  await send("Performance.enable");
  const metrics = async () => Object.fromEntries((await send("Performance.getMetrics")).result.metrics.map((m) => [m.name, m.value]));
  await until(`document.querySelector(".row-open")`);
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true }))`);
  await until(`document.querySelector(".settings-main")`);
  for (const page of PAGES) {
    await evaluate(`[...document.querySelectorAll(".settings-tab")].find((b) => b.textContent.includes(${JSON.stringify(page)})).click()`);
    await until(`document.querySelector(".settings-subs [aria-current=location]")`);
    const result = { label, page, kind: "chromium" };
    for (const kind of ["change", "same"]) {
      const before = await metrics();
      const changed = await evaluate(`(async () => {
        const m = document.querySelector(".settings-main");
        const current = () => document.querySelector(".settings-subs [aria-current=location]")?.textContent;
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const tops = ${kind === "change" ? "[0, Math.min(700, m.scrollHeight - m.clientHeight - 10)]" : "[0, 4]"};
        let changed = 0;
        for (let i = 0; i < ${n}; i++) {
          const was = current();
          m.scrollTop = tops[i % 2];
          await frame();
          if (current() !== was) changed++;
        }
        return changed;
      })()`);
      const after = await metrics();
      const per = (k) => Math.round(((after[k] - before[k]) * 1e6) / n) / 1000;
      result[kind] = { changed, scriptMs: per("ScriptDuration"), styleMs: per("RecalcStyleDuration"), layoutMs: per("LayoutDuration"), taskMs: per("TaskDuration") };
    }
    console.log(JSON.stringify(result));
  }
} finally {
  proc.kill();
  await server.close();
  rmSync(profile, { recursive: true, force: true });
}
