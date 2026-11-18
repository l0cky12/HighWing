import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { threadId } from "node:worker_threads";
import { afterEach, beforeEach, expect } from "vitest";

const dir = process.env.RECORD_FRAMES;
mkdirSync(dir, { recursive: true });
const out = join(dir, `${process.pid}-${threadId}.jsonl`);
let heard = [];

beforeEach(() => {
  const mine = (heard = []);
  globalThis.hermesWireTap = (line) => mine.push(line);
});

afterEach(() => {
  const { currentTestName, testPath } = expect.getState();
  appendFileSync(out, `${JSON.stringify({ file: relative(process.cwd(), testPath), test: currentTestName, frames: heard })}\n`);
  globalThis.hermesWireTap = undefined;
});
