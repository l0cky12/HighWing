#!/usr/bin/env node
// Free-spin wheel measurement from issue 127: 24 trusted button-5 events with no delay over .settings-main, then
// frame gaps while scrollTop moves, plus 50 ms after its last change.
// usage: flick.mjs <runs> <page> [<page>...]   (needs HV_RUN and S=<verify scripts dir>)
import { execFileSync } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";

const S = process.env.S;
const [runs, ...pages] = process.argv.slice(2);
const out = process.env.OUT ?? "/tmp/hv127/results.jsonl";
const wd = (...a) => execFileSync(`${S}/wd.mjs`, a, { env: process.env, encoding: "utf8" }).trim();
const ev = (js) => JSON.parse(wd("eval", js) || "null");
const xdo = (...a) => execFileSync(`${S}/hv`, ["x", ...a], { env: process.env, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function offset() {
  ev(`window.__off = undefined; addEventListener("mousemove", (e) => { window.__off = [e.screenX - e.clientX, e.screenY - e.clientY]; }, { capture: true, once: true }); return 1`);
  const g = Object.fromEntries(xdo("getactivewindow", "getwindowgeometry", "--shell").trim().split("\n").map((l) => l.split("=")).map(([k, v]) => [k, Number(v)]));
  xdo("mousemove", String(g.X + 300), String(g.Y + 300));
  xdo("mousemove", String(g.X + 301), String(g.Y + 301));
  for (let i = 0; i < 30; i++) {
    const o = ev("return window.__off ?? null");
    if (o) return o;
    await sleep(100);
  }
  throw new Error("no pointer move seen");
}

const RECORD = `
const m = document.querySelector(".settings-main");
const side = document.querySelector(".settings-side-scroll") ?? document;
const R = { frames: [], wheels: 0, deltas: [], sideOn: 0, start: performance.now(), top0: m.scrollTop, room: m.scrollHeight - m.clientHeight, nodes: m.querySelectorAll("*").length };
addEventListener("wheel", (e) => { R.wheels++; R.deltas.push(e.deltaY + "/" + e.deltaMode); }, { capture: true, passive: true });
new MutationObserver((ms) => { for (const x of ms) if (x.target.classList.contains("on")) { R.sideOn++; (R.onT ??= []).push(performance.now()); } }).observe(side, { attributes: true, subtree: true, attributeFilter: ["class"] });
let last = m.scrollTop, lastChange = 0;
const f = (t) => {
  R.frames.push([t, m.scrollTop]);
  if (m.scrollTop !== last) { last = m.scrollTop; lastChange = t; }
  if ((lastChange && t - lastChange > 800) || t - R.start > 8000) { R.done = true; return; }
  requestAnimationFrame(f);
};
requestAnimationFrame(f);
window.__R = R;
return R.nodes;`;

function stats(R) {
  const fr = R.frames;
  const firstIdx = fr.findIndex(([, top]) => top !== R.top0);
  if (firstIdx < 1) return { moved: 0 };
  let lastChange = 0;
  for (let i = 1; i < fr.length; i++) if (fr[i][1] !== fr[i - 1][1]) lastChange = fr[i][0];
  const gaps = [];
  for (let i = firstIdx; i < fr.length && fr[i][0] <= lastChange + 50; i++) gaps.push(fr[i][0] - fr[i - 1][0]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  return {
    moved: Math.round(fr[fr.length - 1][1] - R.top0),
    frames: gaps.length,
    p95: +p95.toFixed(1),
    worst: +sorted[sorted.length - 1].toFixed(1),
    over: +gaps.reduce((s, g) => s + Math.max(0, g - 16.7), 0).toFixed(1),
    coastMs: Math.round(lastChange - fr[firstIdx][0]),
    gaps: gaps.map((g) => +g.toFixed(1)),
    ft: fr.slice(firstIdx - 1).filter(([t]) => t <= lastChange + 50).map(([t]) => Math.round(t)),
  };
}

const off = await offset();
for (let r = 0; r < Number(runs); r++) {
  const order = r % 2 ? [...pages].reverse() : pages;
  for (const page of order) {
    if (process.env.PRE) ev(process.env.PRE);
    if (!process.env.NOTAB) wd("click", "button[role=tab]", page);
    await sleep(Number(process.env.SETTLE ?? 800));
    for (let k = 0; k < Number(process.env.REPEAT ?? 1); k++) {
    ev(`document.querySelector(".settings-main").scrollTop = 0; return 1`);
    await sleep(800);
    const mid = ev(`const r = document.querySelector(".settings-main").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]`);
    xdo("mousemove", String(Math.round(off[0] + mid[0])), String(Math.round(off[1] + mid[1])));
    await sleep(400);
    if (process.env.POST) ev(process.env.POST);
    const nodes = ev(RECORD);
    await sleep(50);
    xdo("click", "--repeat", "24", "--delay", "0", "5");
    for (let i = 0; i < 100 && !ev("return !!window.__R.done"); i++) await sleep(100);
    const R = ev("const R = window.__R; return { frames: R.frames, wheels: R.wheels, deltas: [...new Set(R.deltas)], sideOn: R.sideOn, onT: R.onT ?? [], top0: R.top0, room: R.room, done: !!R.done }");
    const s = stats(R);
    const row = { k, variant: process.env.VARIANT ?? "", run: r, page, nodes, room: R.room, wheels: R.wheels, deltas: R.deltas, sideUpdates: R.sideOn, onT: R.onT, done: R.done, ...s };
    appendFileSync(out, JSON.stringify(row) + "\n");
    const { gaps, ...short } = row;
    console.log(JSON.stringify({ k, ...short }));
    }
  }
}
