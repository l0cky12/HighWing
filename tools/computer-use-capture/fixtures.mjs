#!/usr/bin/env node
// Turns record.mjs recordings into the committed fixtures under src/hermes/fixtures/computer-use/.
// Keeps the frames the app reads for computer use, in order, and drops chatter (deltas, usage, skins) and other tools' calls.
// A screenshot data URL over 4096 characters is cut to its first 4096; manifest.json lists each original length.
// Usage: node tools/computer-use-capture/fixtures.mjs <recordings dir> src/hermes/fixtures/computer-use
// It also replaces each display ticket with `<ticket>` and drops other tools' calls, which can hold the profile's own text.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [from, to] = process.argv.slice(2);
if (!from || !to) throw new Error("usage: fixtures.mjs <recordings dir> <out dir>");
const KEEP_CUT = 4096;
const EVENTS = /^(tool\.(start|complete)|message\.(start|complete)|display\.lease|request\.cancel|approval\.cancelled)$/;
const METHODS = /^(approval|approval\.respond|cli\.exec|display\.[a-z.]+|session\.(interrupt|resume))$/;
const manifest = { recorded_with: "tools/computer-use-capture/record.mjs", hermes: "v0.23.2 (2026.9.24) ae2a81ccc00e", cut_at: KEEP_CUT, files: {} };

mkdirSync(to, { recursive: true });
for (const name of readdirSync(from).filter((f) => f.endsWith(".jsonl")).sort()) {
  const rows = readFileSync(join(from, name), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const asked = new Map();
  const cuts = [];
  const kept = [];
  for (const { t, dir, frame } of rows) {
    if (dir === "note") continue;
    if (frame.method && frame.id !== undefined) asked.set(frame.id, frame.method);
    const type = frame.method === "event" ? frame.params.type : null;
    const keep = type ? EVENTS.test(type) : frame.method ? METHODS.test(frame.method) : METHODS.test(asked.get(frame.id) ?? "");
    if (!keep) continue;
    if (type?.startsWith("tool.") && frame.params.payload?.name !== "computer_use") continue;
    kept.push(JSON.stringify({ t, dir, frame: scrub(frame, cuts) }));
  }
  writeFileSync(join(to, name), kept.join("\n") + "\n");
  manifest.files[name] = { frames: kept.length, cut_data_urls: cuts };
}
writeFileSync(join(to, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

function scrub(value, cuts) {
  if (typeof value === "string") {
    if (value.startsWith("data:") && value.length > KEEP_CUT) {
      cuts.push(value.length);
      return value.slice(0, KEEP_CUT);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, cuts));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "ticket") { out[k] = "<ticket>"; continue; }
      if (k === "codex_reasoning_items" || k === "codex_message_items" || k === "reasoning" || k === "reasoning_content") continue;
      out[k] = scrub(v, cuts);
    }
    return out;
  }
  return value;
}
