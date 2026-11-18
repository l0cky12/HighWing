import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const repoMarkdown = execFileSync("git", ["ls-files", "-z", "--", "*.md", "*.mdx", "*.markdown"], { encoding: "utf8" }).split("\0").filter(Boolean);

/** Runs the check on a scratch checkout that tracks this repo's Markdown, plus `add`, minus `drop`. */
function check({ add = [], drop = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-markdown-"));
  dirs.push(root);
  for (const f of [...repoMarkdown.filter((f) => !drop.includes(f)), ...add]) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    writeFileSync(join(root, f), "# Note\n");
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  const run = spawnSync(process.execPath, ["scripts/check-markdown.mjs"], { encoding: "utf8", env: { ...process.env, HERMES_CHAT_ROOT: root } });
  return { code: run.status, err: run.stderr };
}

it("passes on this repo's Markdown", () => {
  expect(check()).toEqual({ code: 0, err: "" });
});

it("passes a new ADR and a new skill file", () => {
  expect(check({ add: ["docs/adr/9999-a-new-decision.md", ".claude/skills/verify-hermes-chat/features/new-thing.md"] }).code).toBe(0);
});

it("fails on a screenshot note added beside a PR's screenshots, as PRs #1 to #19 did, and names it", () => {
  const { code, err } = check({ add: ["docs/screenshots/sidebar-controls/README.md", "notes.mdx"] });
  expect(code).toBe(1);
  expect(err).toContain("Markdown the owner didn't ask for:\n  docs/screenshots/sidebar-controls/README.md\n  notes.mdx\n");
});

it("fails when a kept file is gone, so the list is updated with it", () => {
  const { code, err } = check({ drop: ["docs/e2e.md"] });
  expect(code).toBe(1);
  expect(err).toContain("lists files that are gone:\n  docs/e2e.md");
});
