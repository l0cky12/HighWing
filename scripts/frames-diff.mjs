#!/usr/bin/env node
// Proves a change left what the app sends Hermes as it was (ADR 0208): runs the test suite at a base ref and on this
// checkout with every FakeHermes recording the frames and dashboard calls it hears (scripts/frames-record.setup.mjs),
// then compares them test by test.
//
//   node scripts/frames-diff.mjs <base-ref>     0: every test both sides ran sent the same, in the same order
//                                               1: a test's frames changed, or a test the base ran is gone
//                                               2: no verdict (a suite failed, or the base has no recorder)
//   node scripts/frames-diff.mjs --self-check   proves the comparison catches seeded changes
//
// A test only this checkout has is listed and doesn't fail the run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "hermes-chat", "frames-diff");
const RECORDER = "scripts/frames-record.setup.mjs";
const NUMBERED = {
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
  automationsRetryKey: /(?<="idempotency_key":")[0-9a-f]{24}(?=")/g,
};
const TIMES = {
  screenshotFileTime: [/screenshot-\d{4}-\d{2}-\d{2}-\d{6}/g, "screenshot-<time>"],
  pastedImageFileTime: [/clipboard-\d{4}-\d{2}-\d{2}T\d{6}/g, "clipboard-<time>"],
};
const SHOWN = 12;
const RERUNS = 5;

// A random value becomes `<kind><n>`, n counting the distinct ones of its kind in this run of the test, so a frame that
// names another session, or a retry that stops reusing its key, still differs.
function normalize(frames) {
  const seen = new Map();
  const number = (kind) => (value) => {
    const key = `${kind} ${value.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, `<${kind}${[...seen.keys()].filter((k) => k.startsWith(`${kind} `)).length + 1}>`);
    return seen.get(key);
  };
  return frames.map((frame) => {
    const timed = Object.values(TIMES).reduce((text, [pattern, name]) => text.replace(pattern, name), frame);
    return Object.entries(NUMBERED).reduce((text, [kind, pattern]) => text.replace(pattern, number(kind)), timed);
  });
}

function load(dir) {
  const tests = new Map();
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : [])
    for (const line of readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)) {
      const { file, test, frames } = JSON.parse(line);
      const key = `${file} > ${test}`;
      tests.set(key, [...(tests.get(key) ?? []), normalize(frames)]);
    }
  return tests;
}

function around(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const cut = (s) => `${i > 60 ? "…" : ""}${s.slice(Math.max(0, i - 60), i + 160)}${s.length > i + 160 ? "…" : ""}`;
  return [cut(a), cut(b)];
}

function difference(base, head) {
  if (base.length !== head.length) return `it ran ${base.length} time(s) on the base and ${head.length} here`;
  for (let run = 0; run < base.length; run++) {
    const [b, h] = [base[run], head[run]];
    const at = b.findIndex((frame, i) => frame !== h[i]);
    const first = at === -1 && h.length > b.length ? b.length : at;
    if (first === -1) continue;
    if (b[first] === undefined) return `frame ${first + 1} is new here (base sent ${b.length}, here ${h.length})\n      here: ${around(h[first], "")[0]}`;
    if (h[first] === undefined) return `frame ${first + 1} is missing here (base sent ${b.length}, here ${h.length})\n      base: ${around(b[first], "")[0]}`;
    const [was, now] = around(b[first], h[first]);
    return `frame ${first + 1} of ${b.length} differs\n      base: ${was}\n      here: ${now}`;
  }
}

function compare(baseDirs, headDirs) {
  const [base, head] = [baseDirs.map(load), headDirs.map(load)];
  const runsOf = (side, key) => side.flatMap((tests) => (tests.has(key) ? [tests.get(key)] : []));
  const differing = [];
  let rerun = 0;
  for (const [key, first] of base[0]) {
    if (!head[0].has(key)) {
      differing.push({ key, why: "the base ran it and this checkout didn't" });
      continue;
    }
    const [was, now] = [runsOf(base, key), runsOf(head, key)];
    const seen = new Set(was.map((runs) => JSON.stringify(runs)));
    const match = now.findIndex((runs) => seen.has(JSON.stringify(runs)));
    if (JSON.stringify(first) === JSON.stringify(now[0])) continue;
    if (match !== -1) rerun++;
    else {
      const kinds = (runs) => new Set(runs.map((r) => JSON.stringify(r))).size;
      const varies = was.length > 1 && (kinds(was) > 1 || kinds(now) > 1) ? `no two of its ${was.length} runs at the base and ${now.length} here sent the same; the first of each: ` : "";
      differing.push({ key, why: `${varies}${difference(first, now[0])}` });
    }
  }
  const headOnly = [...head[0].keys()].filter((key) => !base[0].has(key));
  const count = (tests) => [...tests.values()].flat(2).length;
  const gone = differing.filter((d) => !head[0].has(d.key)).length;
  return { compared: base[0].size - gone, rerun, baseFrames: count(base[0]), headFrames: count(head[0]), headOnly, differing };
}

function report({ compared, rerun, baseFrames, headFrames, headOnly, differing }, names) {
  for (const { key, why } of differing.slice(0, SHOWN)) console.log(`DIFFERS ${key}\n    ${why}`);
  for (const { key } of differing.slice(SHOWN)) console.log(`DIFFERS ${key}`);
  for (const key of headOnly.slice(0, SHOWN)) console.log(`only here ${key}`);
  if (headOnly.length > SHOWN) console.log(`… and ${headOnly.length - SHOWN} more tests only here`);
  console.log(
    `frames-diff: base ${names.base} vs ${names.head}: ${compared} tests compared (${baseFrames} frames on the base, ${headFrames} here), ` +
      `${rerun} the same only on a rerun, ${headOnly.length} only here, ${differing.length} differing`,
  );
}

const git = (args, cwd = ROOT) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.trim()}`);
  return run.stdout.trim();
};

function runSuite(cwd, frames, files = []) {
  const run = spawnSync("npx", ["vitest", "run", "--maxWorkers=2", ...files], { cwd, encoding: "utf8", env: { ...process.env, RECORD_FRAMES: frames }, maxBuffer: 1 << 30 });
  if (run.status !== 0) console.log(`The suite failed in ${cwd}:\n${`${run.stdout}\n${run.stderr}`.trim().split("\n").slice(-25).join("\n")}`);
  return run.status === 0;
}

function diffAgainst(ref) {
  const base = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const head = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]) !== "";
  const work = join(CACHE, `${process.pid}`);
  const tree = join(work, "base");
  mkdirSync(work, { recursive: true });
  let added = false;
  let keep = false;
  const cleanUp = () => {
    if (added) spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: ROOT });
    if (keep) console.log(`frames-diff: the recordings are kept in ${work} for a closer look.`);
    else rmSync(work, { recursive: true, force: true });
  };
  process.on("SIGINT", () => (cleanUp(), process.exit(130)));
  try {
    git(["worktree", "add", "--detach", tree, base]);
    added = true;
    if (!existsSync(join(tree, RECORDER))) {
      console.log(`frames-diff: ${ref} has no ${RECORDER}, so its frames can't be recorded. Pick a base at or after the commit that added it.`);
      return 2;
    }
    const sameDeps = spawnSync("git", ["diff", "--quiet", base, "--", "package-lock.json"], { cwd: ROOT }).status === 0;
    // Hard links, not a symlink: Vite refuses to serve a dependency whose real path is outside the checkout.
    const linked = sameDeps && spawnSync("cp", ["-al", join(ROOT, "node_modules"), join(tree, "node_modules")]).status === 0;
    if (linked) rmSync(join(tree, "node_modules", ".vite"), { recursive: true, force: true });
    else {
      rmSync(join(tree, "node_modules"), { recursive: true, force: true });
      if (spawnSync("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], { cwd: tree, stdio: "inherit" }).status !== 0) throw new Error("npm ci failed in the base checkout");
    }
    const [baseDirs, headDirs] = [[join(work, "base-0")], [join(work, "head-0")]];
    console.log(`frames-diff: running the suite at ${base.slice(0, 7)} …`);
    let baseOk = runSuite(tree, baseDirs[0]);
    console.log("frames-diff: running the suite here …");
    let headOk = runSuite(ROOT, headDirs[0]);
    let result = compare(baseDirs, headDirs);
    for (let round = 1; round <= RERUNS && baseOk && headOk; round++) {
      const files = [...new Set(result.differing.map((d) => d.key.split(" > ")[0]))].filter((file) => existsSync(join(ROOT, file)) && existsSync(join(tree, file)));
      if (!files.length) break;
      console.log(`frames-diff: ${result.differing.length} tests differ; running their ${files.length} files again on both sides (${round} of ${RERUNS}) …`);
      baseDirs.push(join(work, `base-${round}`));
      headDirs.push(join(work, `head-${round}`));
      baseOk = runSuite(tree, baseDirs.at(-1), files);
      headOk = runSuite(ROOT, headDirs.at(-1), files);
      result = compare(baseDirs, headDirs);
    }
    report(result, { base: base.slice(0, 7), head: `HEAD ${head.slice(0, 7)}${dirty ? " with uncommitted changes" : ""}` });
    keep = result.differing.length > 0;
    if (keep) return 1;
    if (!baseOk || !headOk || !result.baseFrames) {
      console.log(`frames-diff: no verdict: ${!result.baseFrames ? "the base recorded no frames" : `the suite failed ${baseOk ? "here" : "at the base"}`}.`);
      return 2;
    }
    return 0;
  } finally {
    cleanUp();
  }
}

function selfCheck() {
  const rpc = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const create = rpc(1, "session.create", { profile: "default", source: "gui" });
  const submit = rpc(2, "prompt.submit", { session_id: "rt1", profile: "default", text: "hi" });
  const patch = (id) => `PATCH api/sessions/s1 {"request_id":"${id}","expected_revision":0,"title":"x"}`;
  const poll = "GET api/plugins/kanban/board";
  const sends = { file: "a.test.ts", test: "sends a message", frames: [create, patch("3f2b8c1e-7a4d-4e9b-9c0a-1d2e3f4a5b6c"), submit] };
  const idle = { file: "a.test.ts", test: "sends nothing", frames: [] };
  const polled = { ...sends, frames: [create, poll, sends.frames[1], submit] };
  const changed = { ...sends, frames: [create, sends.frames[1], submit.replace('"hi"', '"ho"')] };
  const controls = [
    { name: "the same frames, with another UUID", head: [[{ ...sends, frames: [create, patch("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"), submit] }, idle]], exit: 0 },
    {
      name: "the same frames, with another random key, capture time and paste time",
      base: [[{ ...sends, frames: ['POST api/x {"idempotency_key":"844ad839a095a2c28bed01d5"}', rpc(1, "image.attach_bytes", { filename: "screenshot-2026-11-17-230603.png" }), rpc(2, "image.attach_bytes", { filename: "clipboard-2026-11-17T232106.png" })] }]],
      head: [[{ ...sends, frames: ['POST api/x {"idempotency_key":"c8419adc9a19ab3bb58c85d0"}', rpc(1, "image.attach_bytes", { filename: "screenshot-2026-11-18-000001.png" }), rpc(2, "image.attach_bytes", { filename: "clipboard-2026-11-18T000002.png" })] }]],
      exit: 0,
    },
    {
      name: "a retry that stops reusing its UUID",
      base: [[{ ...sends, frames: [patch("3f2b8c1e-7a4d-4e9b-9c0a-1d2e3f4a5b6c"), patch("3f2b8c1e-7a4d-4e9b-9c0a-1d2e3f4a5b6c")] }]],
      head: [[{ ...sends, frames: [patch("3f2b8c1e-7a4d-4e9b-9c0a-1d2e3f4a5b6c"), patch("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")] }]],
      exit: 1,
    },
    {
      name: "a frame that names another session",
      base: [[{ ...sends, frames: [rpc(1, "session.resume", { session_id: "3f2b8c1e-7a4d-4e9b-9c0a-1d2e3f4a5b6c" }), rpc(2, "prompt.submit", { session_id: "3f2b8c1e-7a4d-4e9b-9c0a-1d2e3f4a5b6c" })] }]],
      head: [[{ ...sends, frames: [rpc(1, "session.resume", { session_id: "3f2b8c1e-7a4d-4e9b-9c0a-1d2e3f4a5b6c" }), rpc(2, "prompt.submit", { session_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" })] }]],
      exit: 1,
    },
    {
      name: "a retry that stops reusing its random key",
      base: [[{ ...sends, frames: ['POST api/x {"idempotency_key":"844ad839a095a2c28bed01d5"}', 'POST api/x {"idempotency_key":"844ad839a095a2c28bed01d5"}'] }]],
      head: [[{ ...sends, frames: ['POST api/x {"idempotency_key":"844ad839a095a2c28bed01d5"}', 'POST api/x {"idempotency_key":"c8419adc9a19ab3bb58c85d0"}'] }]],
      exit: 1,
    },
    { name: "a reordered JSON key", head: [[{ ...sends, frames: [rpc(1, "session.create", { source: "gui", profile: "default" }), sends.frames[1], submit] }, idle]], exit: 1 },
    { name: "a dropped frame", head: [[{ ...sends, frames: [create, submit] }, idle]], exit: 1 },
    { name: "two frames in the other order", head: [[{ ...sends, frames: [create, submit, sends.frames[1]] }, idle]], exit: 1 },
    { name: "an added frame", head: [[sends, { ...idle, frames: [create] }]], exit: 1 },
    { name: "a changed value that is no UUID", head: [[changed, idle]], exit: 1 },
    { name: "a test only this checkout has", head: [[sends, idle, { file: "b.test.ts", test: "is new", frames: [create] }]], exit: 0 },
    { name: "a test the base ran that is gone", head: [[sends]], exit: 1 },
    { name: "a poll that landed in one run, and a rerun that sent the same as the base", head: [[polled, idle], [sends]], exit: 0, rerun: 1 },
    { name: "a poll that landed in one run at the base, and the same run here", base: [[sends, idle], [polled]], head: [[polled, idle], [polled]], exit: 0, rerun: 1 },
    { name: "a changed value, the same on every rerun", base: [[sends, idle], [sends]], head: [[changed, idle], [changed]], exit: 1 },
    { name: "a changed value among runs that vary", base: [[sends, idle], [polled]], head: [[changed, idle], [{ ...changed, frames: [create, poll, ...changed.frames.slice(1)] }]], exit: 1 },
  ];
  const work = join(CACHE, `self-check-${process.pid}`);
  const write = (name, recordings) =>
    recordings.map((records, round) => {
      const dir = join(work, `${name}-${round}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "1-0.jsonl"), records.map((r) => `${JSON.stringify(r)}\n`).join(""));
      return dir;
    });
  let failed = 0;
  try {
    controls.forEach((c, i) => {
      const result = compare(write(`base-${i}`, c.base ?? [[sends, idle]]), write(`head-${i}`, c.head));
      const exit = result.differing.length ? 1 : 0;
      const ok = exit === c.exit && result.rerun === (c.rerun ?? 0);
      if (!ok) failed++;
      console.log(`${ok ? "ok  " : "FAIL"} ${c.name}: exit ${exit}${ok ? "" : `, expected ${c.exit}`}`);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(failed ? `frames-diff self-check: ${failed} of ${controls.length} controls failed` : `frames-diff self-check: all ${controls.length} controls behave`);
  return failed ? 1 : 0;
}

const [arg] = process.argv.slice(2);
if (!arg) {
  console.error("usage: node scripts/frames-diff.mjs <base-ref> | --self-check");
  process.exit(2);
}
process.exit(arg === "--self-check" ? selfCheck() : diffAgainst(arg));
