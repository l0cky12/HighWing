#!/usr/bin/env node
// Summarizes run.sh's rows: per label and visit, the median and range of each time, the runs that failed, and the
// runs whose chat at `chat` wasn't the clicked bot's.
//   node bench/bot-switch/summary.mjs <out.tsv>...
import { readFileSync } from "node:fs";

const NAMES = { coder: "Coder", desk: "Desk", "hermes-chat": "HighWing", default: "Hermes" };
const rows = process.argv
  .slice(2)
  .flatMap((f) => readFileSync(f, "utf8").trim().split("\n"))
  .map((l) => l.split("\t"))
  .map(([label, launch, step, visit, profile, respond, bot, chat, ready, error, title]) => ({
    label,
    launch,
    step,
    visit,
    profile,
    respond: Number(respond),
    bot: Number(bot),
    chat: chat === "" ? NaN : Number(chat),
    ready: ready === "" ? NaN : Number(ready),
    error,
    title,
  }));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (xs) => {
  const ok = xs.filter(Number.isFinite);
  return ok.length ? `${median(ok)} (${Math.min(...ok)}–${Math.max(...ok)})` : "none";
};

console.log("| Label | Visit | Runs | Failed | Wrong bot | Respond ms | Bot shown ms | Chat shown ms | Ready ms |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
const groups = new Map();
for (const r of rows) {
  const key = `${r.label}\t${r.visit}`;
  groups.set(key, [...(groups.get(key) ?? []), r]);
}
for (const [key, rs] of groups) {
  const [label, visit] = key.split("\t");
  const failed = rs.filter((r) => r.error || !Number.isFinite(r.ready)).length;
  const wrong = rs.filter((r) => Number.isFinite(r.chat) && !r.title.split(" ").includes(NAMES[r.profile] ?? r.profile)).length;
  const col = (k) => fmt(rs.map((r) => r[k]));
  console.log(`| ${label} | ${visit} | ${rs.length} | ${failed} | ${wrong} | ${col("respond")} | ${col("bot")} | ${col("chat")} | ${col("ready")} |`);
}
