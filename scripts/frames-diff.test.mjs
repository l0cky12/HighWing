import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("tells seeded changes to a test's frames from unchanged ones", () => {
  const run = spawnSync(process.execPath, ["scripts/frames-diff.mjs", "--self-check"], { encoding: "utf8" });
  expect(run.stdout).toMatch(/frames-diff self-check: all \d+ controls behave/);
  expect(run.stdout).not.toContain("FAIL");
  expect(run.status).toBe(0);
});
