#!/usr/bin/env node
// Median and spread of run.sh's rows, per label: ms from the Create bot click to the bot ready, and to the form
// closing, which is Hermes's POST /api/profiles plus the app's own work around it.
//   node bench/bot-create/summary.mjs <out.tsv>…
import { readFileSync } from "node:fs";

const rows = process.argv.slice(2).flatMap((f) => readFileSync(f, "utf8").trim().split("\n")).map((l) => l.split("\t"));
const byLabel = new Map();
for (const r of rows) byLabel.set(r[0], [...(byLabel.get(r[0]) ?? []), r]);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const fmt = (xs) => (xs.length ? `${(median(xs) / 1000).toFixed(2)} s (${(Math.min(...xs) / 1000).toFixed(1)}–${(Math.max(...xs) / 1000).toFixed(1)})` : "none");
console.log("label\truns\tnot ready\tready: median (min–max)\tform closed: median (min–max)");
for (const [label, rs] of byLabel) {
  const ready = rs.map((r) => Number(r[7])).filter((n) => n > 0);
  const closed = rs.map((r) => Number(r[4])).filter((n) => n > 0);
  console.log(`${label}\t${rs.length}\t${rs.length - ready.length}\t${fmt(ready)}\t${fmt(closed)}`);
}
