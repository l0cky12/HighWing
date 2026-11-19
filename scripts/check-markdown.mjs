// Fails when the repo tracks a Markdown file the owner didn't ask for. An ADR (docs/adr/NNNN-slug.md) and a file
// under a skill (.claude/skills/) are always allowed. Any other Markdown file must be listed in KEPT below with why it
// is kept; a listed file that no longer exists fails too, so the list stays true.
//
//   node scripts/check-markdown.mjs
//
// HERMES_CHAT_ROOT points it at another checkout (the tests use a scratch one).

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED = [/^docs\/adr\/\d{4}-[a-z0-9-]+\.md$/, /^\.claude\/skills\//];

/** Every other Markdown file the repo keeps, with why. Add a file here only when the owner asked for it. */
const KEPT = new Map([
  ["AGENTS.md", "agent instructions"],
  ["CLAUDE.md", "imports AGENTS.md for Claude Code"],
  ["GLOSSARY.md", "the domain glossary, read per docs/agents/domain.md"],
  ["README.md", "the project readme"],
  ["docs/agents/domain.md", "linked from AGENTS.md"],
  ["docs/agents/issue-tracker.md", "linked from AGENTS.md"],
  ["docs/agents/triage-labels.md", "linked from AGENTS.md"],
  ["docs/compatibility.md", "linked from docs/developer.md"],
  ["docs/developer.md", "linked from README.md"],
  ["docs/e2e.md", "linked from docs/developer.md"],
  ["docs/features.md", "linked from README.md"],
  ["docs/releases.md", "linked from AGENTS.md"],
  ["docs/research/bot-create-speed/README.md", "research findings from #40"],
  ["docs/research/computer-use-payloads.md", "phase 0 findings of #43; the computer-use build spec the owner handed over asks for a findings file in docs/research/"],
  ["docs/research/computer-use-speed/README.md", "research findings"],
  ["docs/research/computer-use-speed/real-hermes/README.md", "research findings"],
  ["docs/research/fleet-features-server-support.md", "research findings"],
  ["docs/research/hermes-approval-mode-mid-session.md", "research findings"],
  ["docs/research/hermes-gateway-api.md", "linked from docs/developer.md"],
  ["docs/screenshots/chat-list-modes/README.md", "screenshot notes, pending the cleanup list"],
  ["docs/screenshots/connections/README.md", "screenshot notes, pending the cleanup list"],
  ["docs/screenshots/live-connections/README.md", "screenshot notes, pending the cleanup list"],
  ["docs/screenshots/restart-gateway/README.md", "screenshot notes, pending the cleanup list"],
  ["docs/screenshots/skills/README.md", "screenshot notes, pending the cleanup list"],
  ["docs/screenshots/voice-conversation/README.md", "screenshot notes, pending the cleanup list"],
  ["docs/screenshots/voice/README.md", "screenshot notes, pending the cleanup list"],
  ["docs/screenshots/writing-model/README.md", "screenshot notes, pending the cleanup list"],
]);

const root = process.env.HERMES_CHAT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markdown = execFileSync("git", ["ls-files", "-z", "--", "*.md", "*.mdx", "*.markdown"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const tracked = new Set(markdown);
const unasked = markdown.filter((f) => !KEPT.has(f) && !ALLOWED.some((rule) => rule.test(f)));
const stale = [...KEPT.keys()].filter((f) => !tracked.has(f));

if (unasked.length)
  console.error(
    `Markdown the owner didn't ask for:\n  ${unasked.join("\n  ")}\n` +
      "Put what it says in the PR description instead, and remove the file. If the owner asked for this file, add it " +
      "to KEPT in scripts/check-markdown.mjs with where they asked.",
  );
if (stale.length) console.error(`KEPT in scripts/check-markdown.mjs lists files that are gone:\n  ${stale.join("\n  ")}`);
if (unasked.length || stale.length) process.exit(1);
