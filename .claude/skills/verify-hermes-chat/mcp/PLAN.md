# Production build of the hermes-app MCP server

The `hermes-app` MCP server lets Claude, Codex and Grok drive their own copy of the real Hermes Chat desktop app the way a person would. Two threads at once never share a window, display, port or data folder. The operator watches any run live in T3's preview, with a marker where each click lands, from any linked Arch or Debian machine after one setup step.

The program enforces one rule. Every run, whether it ends cleanly or is killed, leaves no process, display, port, shared-memory segment, run folder or registry file behind.

The PRs land in this order. P1 closes the port race in `hv up`. P2 lands the server and its cleanup. P3 registers it with all three agents without touching `~/.codex` or `~/.grok`. P4 gives each worktree its own app build. P5 caps the runs per machine and recovers a crashed app. P6 makes what the agents read accurate. P7 opens the live view to other machines.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skills/poteto-mode/playbooks/autopilot-stack.md` from the installed plugin. Merging to `main` is human-only in this repo (`AGENTS.md`, "Merge authority"), so every PR, P1 through P7, is an operator item that stops at verified and merge-ready. The operator lands the stack bottom-up.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Record the operator's answers to every call in Appendix A, "Calls only the operator can make", before any owner starts.
- [ ] Confirm the prototype is committed and pushed on `t3/hermes-chat-mcp-prototype`, and record its SHA. P2 starts from it.
- [ ] On the operator's go, write this exact text into `notes.md` in the program's store under `~/.claude/orchestrate/hermes-app-mcp/` and restate it in your todolist. "Plan ~/.claude/orchestrate/hermes-app-mcp/docs/plan.md. PRs in order P1, P2, P3, P4, P5, P6, P7, each stacked on the one before. Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. The operator merges every PR. Done when all seven are verified and merge-ready, and the acceptance run in Close the program has passed."
- [ ] Read these from the installed plugin at program start. Re-read them at every tick.
  - [ ] `skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `skills/poteto-mode/playbooks/autopilot-full.md`
  - [ ] `skills/swarm/SKILL.md`
  - [ ] `.claude/skills/verify-hermes-chat/SKILL.md` in the repo, the driver skill
  - [ ] `skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `skills/architect/SKILL.md`
  - [ ] `skills/interrogate/SKILL.md`
  - [ ] `skills/benchmark-checklist/SKILL.md`
  - [ ] `skills/show-me-your-work/SKILL.md`
- [ ] Arm the hourly audit tick as a real `/loop` in dynamic mode, which schedules its own wake-up rather than blocking on a sleep. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from the installed plugin and the objective in the program store's `notes.md`. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Each PR stacks on the branch of the PR before it.
  - [ ] P1 is first. It branches from `main`.
  - [ ] P2 after P1. It starts from the prototype files on `t3/hermes-chat-mcp-prototype`.
  - [ ] P3 after P2.
  - [ ] P4 after P3.
  - [ ] P5 after P4.
  - [ ] P6 after P5.
  - [ ] P7 after P6.
- [ ] Hold the file boundaries.
  - [ ] P1 touches only `.claude/skills/verify-hermes-chat/scripts/hv` and `.claude/skills/verify-hermes-chat/scripts/selftest`.
  - [ ] P2 through P7 touch only `.claude/skills/verify-hermes-chat/**`, `.mcp.json`, `.claude/settings.json` and `.github/workflows/verify-harness.yml`.
- [ ] Hold the review gate. P2, P3, P6 and P7 change what an agent or the operator sees. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Follow the repo's PR conventions in `AGENTS.md`. Link the issue with `Fixes #N` where one exists, attach screenshots for anything an agent or the operator sees, and say exactly why any step could not run.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on.
- [ ] Run `npm run check` after every code change and before every commit. Record that `src/hermes/extensionHost.test.ts` fails on Node 26 before this program (#47, #59), and treat any other failure as a blocker.
- [ ] Run `.claude/skills/verify-hermes-chat/scripts/selftest` after every change to `hv`, `wd.mjs`, `bridge.ts` or `mcp/`.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Run the `sol-loop` review that `~/.claude/CLAUDE.md` names for agent-authored changes, and follow its rule for a review that cannot run.
- [ ] Triage every review-bot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] After each push, call T3's `watch_pull_request` on the PR, as the fleet rules in `~/.claude/CLAUDE.md` require.
- [ ] Before the code-ready report and babysit, and again after merge prep, record the base and head SHAs prepared by the topology owner under the execution playbook.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Stop each PR at verified and merge-ready, and hand the stack to the operator. After the handoff, nobody pushes without the operator's go. A restack that leaves a PR's `git patch-id` unchanged keeps its verdict, per the patch-id rule in `playbooks/shipping.md`. Any other new head goes back through verification.

### Boot recipe, for every live lane

Each live lane runs in its own worktree at the PR head. Drive through the skill path or exact commands recorded in this boot recipe.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Set `S=$(git rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat` and run `$S/mcp/setup` (P1 lanes run `$S/scripts/hv bootstrap` instead). Done when it prints `setup: ok` or `hv: bootstrap ok`.
- [ ] Build the app into a lane-owned target. Run `mkdir -p $HOME/.cache/hermes-verify/target-<pr-id>-w<n>/debug && cp -al $HOME/.cache/hermes-verify/target/debug/{deps,build,.fingerprint} $HOME/.cache/hermes-verify/target-<pr-id>-w<n>/debug/`, then `HV_TARGET=$HOME/.cache/hermes-verify/target-<pr-id>-w<n> $S/scripts/hv build`. From P4 on, follow P4's build command instead. Done when it prints `hv: built`.
- [ ] Drive through one of three routes, as the lane names. The scripted client is `node $S/mcp/try-flow.mjs <message> [pause-ms]` with `T3CODE_THREAD_ID=<lane id>`. A real agent is a T3 child thread given the fixed brief in Appendix D. The harness itself is `$S/scripts/hv` and `$S/scripts/wd.mjs`, per `$S/SKILL.md`.
- [ ] Use only these read-only diagnostics. They are `$S/scripts/hv doctor`, `$S/scripts/hv state`, the run's `state.env`, `ls ~/.cache/hermes-verify/mcp/`, `ipcs -m`, `ss -ltnpH`, `ps -o pid,pgid,args`, and `/proc/<pid>/environ`. Never kill by process name, and never run `pkill -f`. Other sessions share this machine.
- [ ] After each scenario, run the leftover check in Appendix D against every run the lane started.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Close the port race in hv up (P1)

**Depends on.** None.

**Files.**

- [ ] Edit `.claude/skills/verify-hermes-chat/scripts/hv`.
- [ ] Edit `.claude/skills/verify-hermes-chat/scripts/selftest`.

**Build.**

- [ ] In `cmd_up`, stop using `free_port` for the driver and native ports. Either let `tauri-driver` bind its own port and read it back, or hold the reserving socket until the program binds, so that no gap exists between choosing and binding. Fixes #88.
- [ ] In `cmd_up`, before it prints `hv: up`, check with `ss -ltnpH` that `DRIVER_PID`'s process group holds `DRIVER_PORT` and that `BRIDGE_PID` holds `BRIDGE_PORT`, as `cmd_doctor` already does for the stand-in. Fail and clean up through `up_failed` when another process holds either port.
- [ ] In `selftest`, add a case that starts 20 pairs of `hv up` at the same instant against the fake driver, and asserts that no two runs share a port and that each port is held by its own run's process.

**You see.**

- [ ] `selftest` prints `ok   20 concurrent pairs got distinct ports, each held by its own run` and `selftest: all ok`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `.claude/skills/verify-hermes-chat/scripts/selftest` gains the 20-pair port case. Run `.claude/skills/verify-hermes-chat/scripts/selftest`.
- [ ] Prove the new case fails at trunk. Run the same case against `main`'s `hv` and record that it reports a shared port, or record that the race did not fire in that run and how many pairs ran.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. At trunk and at head, run `hv up`, `wd.mjs open`, the sign-in recipe in `features/sign-in.md`, and `hv down`. Save `p1-signed-in.png`. Pass when both reach the signed-in window and the leftover check is clean.
- [ ] Lane 2. Start 8 `hv up` runs at the same instant with the real app. Save `p1-eight-runs.png` from one run. Pass when the 8 runs have 24 distinct ports and `hv doctor` prints only `ok` lines in each.
- [ ] Lane 3. Bind a port first with `python3 -c` and hold it, then force `hv up` to try that port through the new code path's test hook. Save `p1-held-port.png` of the terminal. Pass when `hv up` fails with a message naming the port, and the leftover check is clean.
- [ ] Lane 4. Run 50 back-to-back `hv up` and `hv down` pairs. Save `p1-loop.png` of the summary. Pass when all 50 succeed and the leftover check is clean after each.
- [ ] Lane 5. Interrupt `hv up` with TERM while it waits for the driver. Save `p1-interrupted.png`. Pass when the run dir is gone and the leftover check is clean.
- [ ] Lane 6. Run `hv up --dashboard <real dashboard URL>` with `scripts/real-hermes up`. Save `p1-real-dashboard.png`. Pass when `hv doctor` passes and the app reaches Sign in.
- [ ] Lane 7. Kill the run's `tauri-driver` with SIGKILL, then run `hv doctor`. Save `p1-doctor-fail.png`. Pass when doctor prints `FAIL tauri-driver` and `hv down` still leaves nothing.
- [ ] Lane 8. Start 4 runs at once while another lane's 4 runs are active on the same machine. Save `p1-shared-box.png`. Pass when all 8 runs have distinct displays and ports.
- [ ] Lane 9. Run the send-message recipe in `features/send-message.md` in one run while 3 others idle. Save `p1-reply.png`. Pass when `wd.mjs wait .msg.assistant "Stand-in reply to"` prints `ok` and `hv state` holds the message only in that run.
- [ ] Lane 10. Run `selftest` 5 times in a row. Save `p1-selftest.png`. Pass when every run prints `selftest: all ok`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `hv up` from start to `hv: up`.
- [ ] Probe. Run `hv up` and `hv down` 10 times at trunk and 10 times at head, interleaved, on an otherwise idle lane.
- [ ] Baseline. Record the trunk median first. The prototype measured 1.21 s for `hv up` at load 8 to 18.
- [ ] Rule. Fail when the head median exceeds the trunk median by more than 15 percent.

**Review gate.** None. P1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends P1 to the stack and the operator lands it bottom-up.

## Land the server with cleanup that leaves nothing behind (P2)

**Depends on.** P1.

**Files.**

- [ ] Create `.claude/skills/verify-hermes-chat/mcp/server.mjs`, starting from the prototype.
- [ ] Create `.claude/skills/verify-hermes-chat/mcp/live.html`, starting from the prototype.
- [ ] Create `.claude/skills/verify-hermes-chat/mcp/setup`, starting from the prototype, without the Codex and Grok registration.
- [ ] Create `.claude/skills/verify-hermes-chat/mcp/try-flow.mjs`, starting from the prototype.
- [ ] Edit `.claude/skills/verify-hermes-chat/scripts/wd.mjs` to add `where` and hide password values, as on the prototype branch.
- [ ] Edit `.claude/skills/verify-hermes-chat/scripts/hv` to add `hv audit`.
- [ ] Edit `.claude/skills/verify-hermes-chat/scripts/selftest`.
- [ ] Edit `.claude/skills/verify-hermes-chat/SKILL.md`.
- [ ] Edit `.github/workflows/verify-harness.yml` to install `x11vnc`.

**Build.**

- [ ] Run `/architect` on the run's data shape before code. Model one run as a record that names its thread label, its `hv` run dir, the PIDs and process groups it owns, its listening sockets, and its state. Model the state as a machine with the states `starting`, `running`, `app-lost`, `stopping` and `stopped`. Every tool reads the state, and no tool infers it from scattered fields.
- [ ] Start x11vnc with `-noshm`, so that no shared-memory segment exists to leak. Stop it with SIGTERM, then SIGKILL after a timeout.
- [ ] Bind the live-view server with `listen(0)` and read the port back. Give x11vnc a port without a gap between choosing and binding, or connect to it over a Unix socket (`-unixsock`), and record which one the architect step picked.
- [ ] Reap orphaned runs when the server process starts, not only on `start`. An orphan is a registry entry whose owner PID is dead, judged by the owner's start time as well as its PID so that a reused PID never counts as alive.
- [ ] Add `hv audit <run dir or evidence dir>`. It reads the run's `state.env` and prints one line per leftover, covering processes in the recorded groups, the display socket and lock, listening ports, the run dir, the registry file, and shared-memory segments created by the run's processes. It exits non-zero when it finds any.
- [ ] Extend `selftest` with server cases against the fake app and driver. Cover start and stop, SIGKILL of the server followed by a new server's reap, stdin closed mid-action, three concurrent starts, the live page and its WebSocket reaching x11vnc, and `ipcs -m` unchanged after each case.
- [ ] Add a "Drive it through MCP" section to `SKILL.md`, written under `/technical-writing`.

**You see.**

- [ ] `try-flow.mjs "p2 check"` prints `hermes: Stand-in reply to: p2 check` and then `Stopped.`.
- [ ] `hv audit` on that run's evidence prints `audit: nothing left` and exits 0.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `selftest` gains the server cases listed under **Build**. Run `.claude/skills/verify-hermes-chat/scripts/selftest`.
- [ ] CI's `verify-harness` job runs the new cases. Record the passing job URL.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no MCP server. Record that, then run the full flow with `try-flow.mjs` at head. Save `p2-reply.png`. Pass when the reply shows and `hv audit` prints `audit: nothing left`.
- [ ] Lane 2. SIGKILL the server during a `wait`, then start a new server. Save `p2-reaped.png`. Pass when the new server's boot reaps the old run before any tool call and `hv audit` on the old run is clean.
- [ ] Lane 3. SIGKILL the server during `start`, at three points chosen across `hv up`, x11vnc start and `wd open`. Save `p2-killed-start.png`. Pass when a new server's boot leaves `hv audit` clean for all three.
- [ ] Lane 4. Close the server's stdin during a `click`. Save `p2-stdin.png`. Pass when the server exits within 5 s and `hv audit` is clean.
- [ ] Lane 5. Run 20 `start` and `stop` cycles with a viewer connected to the live page each time. Save `p2-cycles.png`. Pass when `ipcs -m` shows no new segment and `hv audit` is clean after each cycle.
- [ ] Lane 6. Open the live page in T3's preview during a flow and record it. Save `p2-live.png` and `p2-live.mp4`. Pass when every click and type shows a marker on its target and the page reads "run stopped" after `stop`.
- [ ] Lane 7. A Claude agent runs the fixed brief through `.mcp.json`. Save `p2-claude.png`. Pass when the run's `server-state.json` holds only that agent's message and reply.
- [ ] Lane 8. Start 4 servers at the same instant. Save `p2-four.png`. Pass when each run has its own display, ports and live page, and each stand-in holds only its own message.
- [ ] Lane 9. Call every tool before `start`, and call `start` twice. Save `p2-misuse.png`. Pass when each early call returns a clear error that names `start`, and the second `start` returns the running run.
- [ ] Lane 10. Run `setup` twice on a machine where x11vnc and noVNC are already present. Save `p2-setup.png`. Pass when the second run downloads nothing and prints `setup: ok`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Seconds per tool call for `start`, `click`, `type` and `stop`, and bytes per tool result. Trunk lacks the server, so the diff-added work is the server's own overhead, and the end state is a finished 18-step flow.
- [ ] Probe. Run `try-flow.mjs` 5 times, with `hv up` alone 5 times at trunk interleaved, as the prototype measurement did in `/tmp/hvmcp-measure/client.mjs`.
- [ ] Baseline. Record trunk's `hv up` median first. The prototype measured `start` at 2.68 s, `click` at 1.03 s, `type` at 1.14 s, `stop` at 1.51 s, and the flow at 20.7 s.
- [ ] Rule. Fail when the median `start` exceeds 4.0 s, the median `click` exceeds 1.4 s, the median `stop` exceeds 2.5 s, or the flow exceeds 26 s on an idle lane.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 6 screenshots into `~/.claude/orchestrate/hermes-app-mcp/media/p2-review-live.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/.claude/orchestrate/hermes-app-mcp/media/p2-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends P2 to the stack and the operator lands it bottom-up.

## Register the server with Claude, Codex and Grok without editing their configs (P3)

**Depends on.** P2.

**Files.**

- [ ] Edit `.mcp.json`.
- [ ] Edit `.claude/settings.json`.
- [ ] Create `.claude/skills/verify-hermes-chat/mcp/launch`, starting from the prototype.
- [ ] Edit `.claude/skills/verify-hermes-chat/mcp/setup`.
- [ ] Edit `.claude/skills/verify-hermes-chat/mcp/server.mjs`.
- [ ] Edit `.claude/skills/verify-hermes-chat/SKILL.md`.

**Build.**

- [ ] Add `"alwaysLoad": true` to the `hermes-app` entry in `.mcp.json`, so Claude loads the tools at session start.
- [ ] Register Codex the way the operator chose in Appendix A. Pass `-c mcp_servers.hermes-app.command`, `args`, `env_vars` and `default_tools_approval_mode="approve"` through T3's Codex `launchArgs` setting. Setup must not write `~/.codex`.
- [ ] Register Grok the way the operator chose in Appendix A. The recommended route is a user-scope entry in `~/.claude.json` that points at the launcher, which Grok reads by default. Setup must not write `~/.grok`.
- [ ] In `server.mjs`, label each run from `T3CODE_THREAD_ID` when it is set, else from Codex's `_meta.threadId` on the first `tools/call`, and always add the working directory.
- [ ] Have the launcher answer with an empty tool list outside a hermes-chat checkout, as the prototype's does.

**You see.**

- [ ] A Claude session's first hermes-app call is `start`, with no ToolSearch call before it.
- [ ] A Codex run's live page and `start` text show `codex <threadId>` and the worktree path instead of `pid-<n>`.
- [ ] `grok mcp doctor` in a fresh worktree prints `✓ 8 tools discovered` for `hermes-app`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `selftest` gains a case that sends a `tools/call` carrying `_meta.threadId` and asserts the run label. Run `.claude/skills/verify-hermes-chat/scripts/selftest`.
- [ ] `selftest` gains a case that runs the launcher outside a checkout and asserts an empty tool list.
- [ ] Prove that setup leaves `~/.codex` and `~/.grok` byte-identical. Record `sha256sum` of every file in both folders before and after `setup`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no registration. Record that, then have a Claude agent run the fixed brief at head. Save `p3-claude.png`. Pass when its first hermes-app call is `start` and the reply shows.
- [ ] Lane 2. A Codex agent runs the fixed brief in a fresh T3 worktree. Save `p3-codex.png`. Pass when the reply shows and the live page names the Codex thread.
- [ ] Lane 3. A Grok agent runs the fixed brief in a fresh T3 worktree. Save `p3-grok.png`. Pass when the reply shows. If Grok's account cannot run, record the exact error and mark the lane blocked, not passed.
- [ ] Lane 4. Two Codex agents run the fixed brief at the same time. Save `p3-codex-pair.png`. Pass when each stand-in holds only its own message, and the two runs have different labels.
- [ ] Lane 5. Open a Claude, a Codex and a Grok session in a repo that is not hermes-chat. Save `p3-elsewhere.png`. Pass when each lists no hermes-app tools and no error.
- [ ] Lane 6. Run `setup` twice. Save `p3-setup.png`. Pass when the second run changes nothing and both `sha256sum` lists of `~/.codex` and `~/.grok` match the first.
- [ ] Lane 7. Start a Claude session with both the user-scope entry and `.mcp.json` present. Save `p3-claude-dup.png`. Pass when exactly one hermes-app server starts.
- [ ] Lane 8. Remove the Codex registration and start a Codex thread. Save `p3-codex-missing.png`. Pass when the agent reports that it has no hermes-app tools, as the fixed brief tells it to.
- [ ] Lane 9. Read `/proc/<pid>/environ` of each agent's server. Save `p3-env.png` of the listing. Pass when no server needs `DISPLAY`, `WAYLAND_DISPLAY` or `T3CODE_THREAD_ID` to start a run.
- [ ] Lane 10. A Claude agent and a Codex agent run the fixed brief at the same time. Save `p3-mixed.png`. Pass when both replies show and each stand-in holds only its own message.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Agent calls before the first `start`, and server time from `initialize` to the `tools/list` answer. Trunk lacks the server, so P2's head is the comparison point.
- [ ] Probe. Count calls in 3 Claude and 3 Codex threads at P2 head and at P3 head, interleaved. Time `initialize` to `tools/list` 20 times with `try-flow.mjs`.
- [ ] Baseline. Record P2 head's numbers first. The prototype's Claude agent made 1 ToolSearch call before `start`.
- [ ] Rule. Fail when any Claude thread makes a ToolSearch call before `start`, or when `initialize` to `tools/list` exceeds 300 ms at the median.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 3 screenshots into `~/.claude/orchestrate/hermes-app-mcp/media/p3-review-<agent>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/.claude/orchestrate/hermes-app-mcp/media/p3-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends P3 to the stack and the operator lands it bottom-up.

## Give each worktree its own app build (P4)

**Depends on.** P3.

**Files.**

- [ ] Edit `.claude/skills/verify-hermes-chat/scripts/hv`.
- [ ] Edit `.claude/skills/verify-hermes-chat/mcp/server.mjs`.
- [ ] Edit `.claude/skills/verify-hermes-chat/scripts/selftest`.
- [ ] Edit `.claude/skills/verify-hermes-chat/SKILL.md`.

**Build.**

- [ ] Run `/architect` on the build store before code. The starting shape is a store keyed by `source_rev`. `hv build` writes to a target folder owned by the worktree and then copies the finished binary to `$HV_HOME/apps/<source_rev>/hermes-chat`, written to a temporary path and renamed into place. A lock per `source_rev` stops two builds of the same revision from running at once.
- [ ] Make `hv up` and `start` use the app that matches the checkout's `source_rev`. When none exists, `start` fails with the exact `hv build` command to run.
- [ ] Add `hv gc`, which removes the target folders of worktrees that no longer exist and apps not used for 7 days. It never removes an app that a live run uses.

**You see.**

- [ ] Two worktrees at different commits each start a run, and each run's app reports its own build revision in `hv doctor`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `selftest` gains cases for the lookup by `source_rev`, the missing-build error, a crash during the copy into the store, and `hv gc` keeping an app a live run uses. Run `.claude/skills/verify-hermes-chat/scripts/selftest`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. At trunk, two worktrees at different commits share one build. Record that, then at head run the flow from both worktrees at once. Save `p4-two-revs.png`. Pass when each run's `hv doctor` prints its own worktree's revision.
- [ ] Lane 2. Call `start` in a worktree with no build. Save `p4-no-build.png`. Pass when the error names the exact `hv build` command and nothing is left behind.
- [ ] Lane 3. Run `hv build` in two worktrees at the same commit at once. Save `p4-same-rev.png`. Pass when one build runs, the other waits on the lock, and both runs use one app.
- [ ] Lane 4. SIGKILL `hv build` while it copies into the store, then build again. Save `p4-killed-copy.png`. Pass when no partial binary is ever used and the second build finishes.
- [ ] Lane 5. Edit a file under `src/` without committing, then start. Save `p4-dirty.png`. Pass when `start` refuses the old build and names the command to rebuild.
- [ ] Lane 6. Run `hv gc` while a run is live. Save `p4-gc.png`. Pass when the live run's app stays and stale entries go.
- [ ] Lane 7. A Codex agent runs the fixed brief in a fresh worktree after one `hv build`. Save `p4-codex.png`. Pass when the reply shows.
- [ ] Lane 8. Run `cargo test` in a worktree, then start. Save `p4-cargo-test.png`. Pass when the run still uses the store's custom-protocol build and does not show "Could not connect to localhost".
- [ ] Lane 9. Measure disk use of the store after builds at three revisions. Save `p4-disk.png`. Pass when the numbers are recorded in the PR body.
- [ ] Lane 10. A Claude agent runs the fixed brief while a build for another revision runs. Save `p4-claude.png`. Pass when the reply shows and the run's app revision is its own.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `start` time when the build exists, and the incremental `hv build` time for one changed Rust file.
- [ ] Probe. Run 5 `start` and `stop` cycles at P3 head and at P4 head, interleaved. Time one incremental build at each.
- [ ] Baseline. Record P3 head's `start` median first.
- [ ] Rule. Fail when the P4 `start` median exceeds P3's by more than 0.5 s, or the incremental build exceeds P3's by more than 20 percent.

**Review gate.** None. P4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends P4 to the stack and the operator lands it bottom-up.

## Cap the runs per machine and recover a crashed app (P5)

**Depends on.** P4.

**Files.**

- [ ] Edit `.claude/skills/verify-hermes-chat/mcp/server.mjs`.
- [ ] Edit `.claude/skills/verify-hermes-chat/scripts/selftest`.
- [ ] Edit `.claude/skills/verify-hermes-chat/SKILL.md`.

**Build.**

- [ ] Count live runs from the registry after reaping. Refuse `start` past a limit, 8 by default and set by `HV_MAX_RUNS`, with a message that names each running run's label and age.
- [ ] Count every `hv` run on the machine toward the display range, and refuse with a clear message when `:140` to `:199` has no free display.
- [ ] When a tool finds the app session dead, move the run to `app-lost` and return a screenshot of the X screen with the message "The app quit. Call start to relaunch it in this run." On the next `start`, relaunch the app inside the same run, without a new display or stand-in.

**You see.**

- [ ] With 8 runs live, a ninth `start` returns "8 runs are already live on this machine" and lists them.
- [ ] After the app is killed, `click` returns the message above and `start` brings the app back on the same display.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `selftest` gains cases for the limit, the registry count after a reap, and the `app-lost` state against the fake driver. Run `.claude/skills/verify-hermes-chat/scripts/selftest`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no limit. Record that, then at head run 8 flows at once and try a ninth. Save `p5-limit.png`. Pass when all 8 pass, the ninth is refused with the list, and nothing is left behind.
- [ ] Lane 2. Kill the app mid-flow, call `click`, then `start`, then finish the flow. Save `p5-relaunch.png`. Pass when the reply shows on the same display.
- [ ] Lane 3. Kill the app twice in one run. Save `p5-twice.png`. Pass when both relaunches work and `hv audit` is clean after `stop`.
- [ ] Lane 4. Fill the limit, SIGKILL one server, then start a new run. Save `p5-reap-frees.png`. Pass when the reap frees a slot and the new run starts.
- [ ] Lane 5. Set `HV_MAX_RUNS=2` and start 3. Save `p5-env.png`. Pass when the third is refused.
- [ ] Lane 6. Occupy displays with plain `hv up` runs until few are free, then start servers. Save `p5-displays.png`. Pass when the server refuses with the display message and leaves nothing behind.
- [ ] Lane 7. A Claude agent hits the limit. Save `p5-agent-limit.png`. Pass when the agent reports the refusal and the listed runs, and does not retry in a loop.
- [ ] Lane 8. A Codex agent's app is killed mid-flow. Save `p5-agent-relaunch.png`. Pass when the agent calls `start` and finishes the brief.
- [ ] Lane 9. Run 8 flows at once for 10 rounds. Save `p5-soak.png`. Pass when all 80 pass and `hv audit` is clean after each.
- [ ] Lane 10. Watch the live page while the app is killed and relaunched. Save `p5-live.png`. Pass when the page stays connected and shows the relaunched window.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Flow wall time with 8 runs at once, and time to refuse a ninth `start`.
- [ ] Probe. Run the 8-run level at P4 head and at P5 head, interleaved, 3 times each.
- [ ] Baseline. Record P4 head's 8-run median first. The prototype measured 23.5 to 27.0 s per flow at 8 runs.
- [ ] Rule. Fail when the P5 8-run median exceeds P4's by more than 10 percent, or the refusal takes more than 1 s.

**Review gate.** None. P5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends P5 to the stack and the operator lands it bottom-up.

## Make what the agents read accurate (P6)

**Depends on.** P5.

**Files.**

- [ ] Edit `.claude/skills/verify-hermes-chat/scripts/wd.mjs`.
- [ ] Edit `.claude/skills/verify-hermes-chat/mcp/server.mjs`.
- [ ] Edit `.claude/skills/verify-hermes-chat/scripts/selftest`.
- [ ] Edit `.claude/skills/verify-hermes-chat/SKILL.md`.

**Build.**

- [ ] In the control list, show a `<select>`'s chosen option, not all its options.
- [ ] In the control list, keep a control's label apart from a count or time beside it, so that `Archived4` reads `Archived | 4`.
- [ ] In the control list, show a button's real `type` and fold repeated unlabelled buttons into one line with a count.
- [ ] Show status and alert text in full, up to 300 characters.
- [ ] In `start`'s result, say that the keyring warning is expected in this harness and why. Mark the warning in the control list as `(expected)`.
- [ ] Apply the screenshot policy the operator chose in Appendix A.

**You see.**

- [ ] After "Connect through" is set, the list shows `select | Connect through | Web address`.
- [ ] The Archived header reads `button | Archived | 4`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `selftest` gains `wd.mjs handles` cases against a fixture page for each rule under **Build**. Run `.claude/skills/verify-hermes-chat/scripts/selftest`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. At trunk, run `wd.mjs handles` after picking "Web address" with the sign-in recipe. At head, run the same through the server. Save `p6-select.png`. Pass when head shows `Web address` and trunk's output is recorded.
- [ ] Lane 2. A Claude agent runs the fixed brief. Save `p6-claude.png`. Pass when it never mentions the keyring warning as a problem.
- [ ] Lane 3. A Codex agent runs the fixed brief and is told to open Archived by name. Save `p6-codex-archived.png`. Pass when it targets `Archived` without a count.
- [ ] Lane 4. A client that cannot see images runs the flow with only the text results. Save `p6-text-only.png`. Pass when it finds every control and reads the reply from text.
- [ ] Lane 5. Drive the Model providers step. Save `p6-providers.png`. Pass when the list shows the chosen provider and the full "Hermes can already use" line.
- [ ] Lane 6. Open a chat with many messages. Save `p6-messages.png`. Pass when the last messages section stays within its limit and shows the newest ones.
- [ ] Lane 7. Type into the password field. Save `p6-password.png`. Pass when no tool result anywhere contains the password text.
- [ ] Lane 8. Run the chat-list recipe in `features/chat-list.md` through the server. Save `p6-chat-list.png`. Pass when the agent-facing list has no line that joins a label with a count.
- [ ] Lane 9. Run the flow under the operator's screenshot policy and count images per flow. Save `p6-images.png`. Pass when the count matches the policy.
- [ ] Lane 10. A Grok agent runs the fixed brief. Save `p6-grok.png`. Pass when the reply shows. If Grok's account cannot run, record the error and mark the lane blocked.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Bytes per tool result and estimated Claude tokens per 18-step flow, counting each image at ceil(w/28) times ceil(h/28) tokens.
- [ ] Probe. Run `try-flow.mjs` 3 times at P5 head and 3 times at P6 head, interleaved, and sum result sizes.
- [ ] Baseline. Record P5 head's numbers first. The prototype returned 1.57 MB of base64 and about 24,840 image tokens per flow.
- [ ] Rule. Fail when the median text per result exceeds 4 KB, or when the tokens per flow exceed the budget the operator's screenshot policy sets in Appendix A.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 4 and 5 screenshots into `~/.claude/orchestrate/hermes-app-mcp/media/p6-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/.claude/orchestrate/hermes-app-mcp/media/p6-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends P6 to the stack and the operator lands it bottom-up.

## Open the live view from other machines (P7)

**Depends on.** P6.

**Files.**

- [ ] Edit `.claude/skills/verify-hermes-chat/mcp/server.mjs`.
- [ ] Edit `.claude/skills/verify-hermes-chat/mcp/live.html`.
- [ ] Edit `.claude/skills/verify-hermes-chat/scripts/selftest`.
- [ ] Edit `.claude/skills/verify-hermes-chat/SKILL.md`.

**Build.**

- [ ] Bind the live page and its WebSocket to the addresses the operator chose in Appendix A, and refuse any request that fails the access rule the operator chose.
- [ ] Return the live view's port in `start`'s text, with the exact `preview_open` call that opens it, `target: {kind: "environment-port", port: <port>}`.
- [ ] Draw markers for `press` and `wait` in the step log, and keep click markers as they are.
- [ ] Serve a page on each live view that lists every live run on the machine from the registry, with each run's label and link.

**You see.**

- [ ] From a second linked machine, `preview_open` with `environment-port` shows the run's window and its markers.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `selftest` gains cases for the bind address, a refused request without access, the WebSocket upgrade with access, and the run list. Run `.claude/skills/verify-hermes-chat/scripts/selftest`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no live view. Record that, then at head open the live view in T3's preview on the same machine during a flow. Save `p7-local.png`. Pass when markers land on their targets.
- [ ] Lane 2. Open the live view from a second linked machine with `environment-port`. Save `p7-remote.png`. Pass when the window and the markers show. If no second machine is linked, mark the lane blocked and say so.
- [ ] Lane 3. Request the live page and its WebSocket without access from another host. Save `p7-refused.png`. Pass when both are refused.
- [ ] Lane 4. Open two runs' live views side by side. Save `p7-two.png`. Pass when each shows only its own window and markers.
- [ ] Lane 5. Open the run list during 4 live runs. Save `p7-list.png`. Pass when it lists all 4 with labels and working links.
- [ ] Lane 6. Keep a remote viewer open for a whole 8-run soak. Save `p7-soak.png`. Pass when the viewer stays connected and nothing is left behind.
- [ ] Lane 7. Stop a run while a remote viewer is open. Save `p7-stopped.png`. Pass when the page reads "run stopped" and the port closes.
- [ ] Lane 8. Run the flow on a Debian machine after one `setup`. Save `p7-debian.png`. Pass when the reply shows and the live view opens from the Arch machine. If no Debian machine is linked, mark the lane blocked and say so.
- [ ] Lane 9. Record the live view in T3's preview during a Codex agent's run. Save `p7-codex.png` and `p7-codex.mp4`. Pass when each click has a marker on its target.
- [ ] Lane 10. Scan the machine's listening sockets during a run. Save `p7-sockets.png`. Pass when only the addresses the operator chose are bound.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a click's event to its marker on the page, and time to the first frame after opening the page, local and remote.
- [ ] Probe. Log the event time in the server and the draw time in the page, 20 clicks each at P6 head and P7 head, interleaved.
- [ ] Baseline. Record P6 head's local numbers first.
- [ ] Rule. Fail when the median marker delay exceeds 500 ms locally or 1 s remotely, or the first frame exceeds 3 s.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 5 screenshots into `~/.claude/orchestrate/hermes-app-mcp/media/p7-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/.claude/orchestrate/hermes-app-mcp/media/p7-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends P7 to the stack and the operator lands it bottom-up.

## Close the program

- [ ] Run the acceptance test at P7 head. Start a Claude, a Codex and a Grok thread with the fixed brief in Appendix D at the same time, and record the live view of one of them.
  - [ ] Each run's `/__state` holds only its own thread's message and reply.
  - [ ] `hv audit` is clean for all three runs after `stop`, and again after a SIGKILL of one server followed by a reap.
  - [ ] The recording shows a marker on each click target.
- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

The prototype lives uncommitted on branch `t3/hermes-chat-mcp-prototype`, based on `3a23c28`, in `.claude/skills/verify-hermes-chat/mcp/`. The research and decision trail for this plan is `.audit/hermes-app-plan.tsv` in that worktree. Measurement scripts and logs are in `/tmp/hvmcp-measure/`.

### Questions the prototype answered

- **Separate threads stay isolated.** A Claude and a Codex agent ran at once on displays `:140` and `:142`. Two Codex agents ran at once on `:140` and `:141`. Each `server-state.json` held only its own message. The evidence is in `~/.cache/hermes-verify/evidence/1118-172940-2759283`, `1118-172948-2760772`, `1118-173333-2790532` and `1118-173335-2791046`.
- **Codex starts one server per thread.** Two Codex threads under one `codex app-server` (PID 1899393) each spawned their own server.
- **The live view and markers work.** Recordings are at `/home/liam/.t3/userdata/attachments/hermes-app-live-view-demo.mp4` and `/home/liam/.t3/userdata/attachments/7d810575-b512-48ba-904c-2f161a4c3793-ce1f4ba6-beff-46be-aa5f-e046e09cba80-mp4.mp4`.
- **x11vnc leaks shared memory on SIGKILL, and `-noshm` stops it.** Each x11vnc holds 46 segments, and SIGKILL left all 46. With `-noshm`, a run made none. The machine reached its limit of 4096 segments during measurement.
- **`hv up` has a port race.** Two runs got `DRIVER_PORT` 43173 in 1 of 279 runs. This is filed as https://github.com/l0cky12/HighWing/issues/88.
- **One machine holds at least 8 runs.** 24 of 24 flows passed at 8 at once, using 2.74 GiB at peak and 5.7 cores at the median, at a load of 12 to 15. CPU spent on keystrokes and process spawns is the limiter.
- **One run costs about 300 MiB.** Summed PSS was 236 to 357 MiB per run across idle, the flow, and idle after sign-in.
- **Screenshots dominate what an agent reads.** Each tool result carries a 1280 by 820 PNG of 64 to 144 KB in base64. That is about 1,380 Claude tokens per image and 24,840 per 18-step flow, against about 4,000 to 5,000 tokens of text.
- **Each CLI can load the server without editing `~/.codex` or `~/.grok`.** A probe server started through `codex app-server -c mcp_servers.probe.*`. Grok's `mcp doctor` found a server from `~/.claude.json` in an untrusted repo. Claude's docs give `alwaysLoad` for `.mcp.json`.
- **Codex tells the server its own thread id.** Each `tools/call` carries `_meta.threadId`. The shared app-server has no `T3CODE_THREAD_ID`.
- **The live view must bind a reachable address.** T3's preview builds an `environment-port` URL from the linked machine's hostname, and the browser connects to it directly.

### Questions that stay unproven

- **Codex through T3's `launchArgs` in a real T3 thread.** The probe ran against `codex app-server` directly. P3 lane 2 proves it.
- **Claude's `alwaysLoad` removing the ToolSearch call.** Only the docs say so. P3 lane 1 proves it.
- **Grok finishing the flow.** Grok's account was out of credit (402). P3 lane 3 proves it.
- **A full run on Debian and a remote live view.** No other machine was linked. Setup's x11vnc and noVNC steps passed in a `debian:12` container. P7 lanes 2 and 8 prove the rest.
- **How Codex and Grok count image tokens, and whether they pass MCP images to the model.** P6's perf block records what each CLI sends.
- **Whether one worktree always maps to one T3 thread.** P3 labels runs by thread id and path, so the label stays correct either way.

### Calls only the operator can make

- **Screenshot policy.** Every action returns a screenshot today, at about 1,380 Claude tokens each and 24,840 per flow. The API's limit of 100 images per request is reached after about 5 flows in one conversation. The options are to keep a screenshot on every action, to return one only from `snapshot` and on request, or to return a smaller image on every action. A 640 by 410 image costs about 345 tokens. Text alone now carries the controls and the last messages.
- **Who may reach the live view port.** It must open from other machines. The options are to bind the tailnet interface only, to bind the LAN with a random token per run in the URL, or to bind the LAN with no token.
- **How Codex gets the server.** The options are for setup to write T3's Codex `launchArgs` in `~/.t3/userdata/settings.json`, or for setup to print the value for you to paste into T3's Codex settings.
- **How Grok gets the server.** The recommended option is a user-scope entry in `~/.claude.json`. Claude and Grok then start the launcher in every project, and it offers no tools outside hermes-chat. The other option is a Grok wrapper with `GROK_FOLDER_TRUST=0`, which turns off Grok's folder trust for every folder.
- **Committing the prototype.** P2 starts from the prototype files. Say when to commit and push them to `t3/hermes-chat-mcp-prototype`.
- **Grok credit.** P3 lane 3, P6 lane 10 and the acceptance test need a Grok account that can run.

## Appendix B. Alternatives rejected

- **Project config files for Codex and Grok.** Codex 0.170.0 ignores a project `.codex/config.toml` until the folder is trusted, and `--trust` writes `~/.codex`. Grok starts repo-local servers only in trusted folders, and every T3 worktree is a new folder. Both fail the rule that setup must not edit those configs.
- **User entries in `~/.codex/config.toml` and `~/.grok/config.toml`.** The prototype used these. The operator ruled them out, and they have been removed from this machine.
- **`CODEX_HOME`, profiles and `shadowHomePath` for Codex.** `CODEX_HOME` moves auth and sessions. Profiles live inside `~/.codex`. `shadowHomePath` still shares `config.toml`.
- **`GROK_CONFIG` for Grok.** It drops `mcp_servers`.
- **Drawing markers in the app or on the X display.** Either would put the markers into the agent's own screenshots. The prototype draws them only on the live page.
- **Real X input through xdotool for every click.** WebDriver input already goes through WebKit's input pipeline as a person's would, and `hv x` covers native dialogs.
- **A long-lived daemon that owns every run.** One server per agent session already gives each thread its own run, and a daemon would add shared state that every thread writes.

## Appendix C. Risks

- **A shared display range.** Every `hv` user on a machine draws from `:140` to `:199`. P5 refuses a start with a clear message when none is free. The P5 owner watches for other harness users who exhaust the range.
- **Orphans wait for the next server.** Nothing reaps a dead server's run until another server starts. P2 reaps at server start. The P2 owner checks whether a run left alone for a day needs a timer.
- **Context cost.** Screenshots can exhaust an agent's context or the per-request image limit in long sessions. P6 applies the operator's policy and measures it.
- **The live view is an unauthenticated VNC proxy today.** P7 applies the operator's access rule. The P7 owner treats any bind beyond the chosen addresses as a blocker.
- **Disk use from per-worktree builds.** Each target folder holds gigabytes. P4 adds `hv gc` and records the numbers.
- **T3 changes.** The Codex route depends on T3's `launchArgs` setting, and the Codex label depends on Codex's `_meta.threadId`. The P3 owner records the T3 and Codex versions it tested.
- **No second machine is linked.** The remote live view and the Debian run stay unproven until one is linked. P7 marks those lanes blocked rather than passed.
- **Grok credit.** Grok lanes stay blocked until the account can run.
- **`extensionHost.test.ts` fails on Node 26.** It fails on `main` before this program (#47, #59). Owners record it and do not treat it as theirs.

## Appendix D. Links and reading list

Read these before editing.

- `.claude/skills/verify-hermes-chat/SKILL.md`, the driver skill and the harness rules.
- `.claude/skills/verify-hermes-chat/features/sign-in.md` and `features/send-message.md`, the flow the fixed brief drives.
- `.github/workflows/verify-harness.yml`, the CI job that runs `selftest`.
- https://code.claude.com/docs/en/mcp, for `alwaysLoad` and tool search.
- https://modelcontextprotocol.io/specification, for `initialize`, `tools/list` and `_meta`.
- https://github.com/l0cky12/HighWing/issues/88, the port race P1 fixes.

Run `skills/how/SKILL.md` before P2, P3 and P4, which change how runs start. Run `skills/interrogate/SKILL.md` on P1, P2, P5 and P7, whose bugs show only when runs collide, crash, or open to the network. Keep the trail per `skills/show-me-your-work/SKILL.md` in the program store.

### The fixed brief

Give every agent lane and the acceptance test this brief, with `<agent>` replaced.

"You are testing the `hermes-app` MCP server. Use only its tools. If you see no hermes-app tools, stop and say so. Call `start`. Through the app, connect to the stand-in dashboard that `start` names, with username `verify` and password `verify-pass`. Pick Web address, test the route, sign in, test the connection, save, and skip Model providers. In a new chat, send `hello from <agent>`. Wait until `Stand-in reply to: hello from <agent>` is visible. Call `stop`. Report the label and live view `start` printed, the reply you saw, and anything in the tools that confused you."

### The leftover check

Run this against every run a lane starts. From P2 on, `hv audit <run dir or evidence dir>` does all of it.

- No registry file for the run in `~/.cache/hermes-verify/mcp/`.
- No run dir under `~/.cache/hermes-verify/runs/`.
- No process in any process group the run's `state.env` recorded.
- No `/tmp/.X11-unix/X<n>` socket or `/tmp/.X<n>-lock` for the run's display.
- No listening socket on any port the run recorded.
- No new shared-memory segment in `ipcs -m`.
