// The verification stand-in Hermes dashboard: the HTTP/WebSocket boundary the Rust side talks to, answered by the
// tests' FakeHermes (src/hermes/fakeHermes.ts) with fixed synthetic chats. Loopback only. `hv up` bundles and starts it.
//   node bridge.mjs <port> <state-file>
// Sign-in: username `verify`, password `verify-pass`; anything else is 401 "Invalid credentials", as Hermes answers.
// Every prompt gets a short streamed reply that starts `Stand-in reply to:` and is stored in the chat's history, except:
//   a prompt with "delegate" in it starts two subagents, as Hermes's delegate tool reports them, and its reply runs on.
//   With "queue" in it too, a third subagent is requested and stays queued, waiting its turn.
//   a prompt with "dispatch" in it calls `kanban_create` (a task on the stand-in's board, `session_id` the chat's),
//   says "Research task dispatched (t_…)" and ends its turn. The kanban routes serve the board.
//   a prompt with "background" in it starts two background subagents and ends its turn while they run.
//   a prompt that starts with `tools` runs a turn with tool calls as Hermes sends and stores one, in real time: a
//   `terminal` call, then a `read_file` that fails, each with Hermes's `duration_s`, `session.usage` after each model
//   call, and stored rows with `timestamp` and `tool_calls` (FakeHermes.toolTurn), for the Run view (ADR 0178).
//   a prompt with "edit two files" in it runs FakeHermes's file turn in the chat's folder (ADR 0180): a write Hermes
//   refuses, then a write of a.txt and a patch of b.txt, with a checkpoint before them, so the reply gets the
//   "2 files changed" chip. Checkpoints are on unless HV_CHECKPOINTS=off, which gives the chip's "checkpoints are off".
//   a prompt with "approval" in it asks the owner to approve a command, and its reply waits for the answer.
//   a prompt that starts with `computer use` runs FakeHermes.computerUseTurn (ADR 0213): 20 computer_use calls on the
//   Bot Desktop, about half a second each, with screenshots in the results as Hermes sends them. A background click and
//   a foreground type each ask a cua Approval in Hermes's shape until allowed for the chat; a foreground key is already
//   allowed always, as the recorded profile's was. Stop ends it between calls. `computer use takeover` instead hands
//   the screen to someone else first, so its one capture is refused `human_has_control` and the screen stays held until
//   `POST /__lease?holder=agent`. The first such prompt gives the stand-in a stopped Bot Desktop (`display.*`).
//   a prompt that starts with "fail" ends its reply with an error, as a provider failure does.
//   a prompt that starts with "math" gets a reply with inline and display math and a Mermaid diagram (#350), and one
//   that starts with "badmath" the same with a diagram Mermaid can't parse.
//   with HV_REPLY_FILE=<path>, a prompt that starts with `canned` gets that file's text as its reply, read at each send,
//   so a test can serve a hostile reply (a diagram, a link, an image) exactly as written.
//   with HV_LONG_REPLY=<n>, a prompt that starts with `long` gets n paragraphs of markdown (code, a list, a table),
//   three words every 40 ms, so a reply keeps streaming for minutes.
//   `subagent.interrupt` (Stop in the Subagents panel) ends that subagent as `interrupted`, as Hermes reports it.
//   `session.interrupt` (the composer's Stop) ends the reply's turn with `message.complete` status `interrupted`, as
//   Hermes does, so a reply that runs on (a "delegate" prompt's) can be stopped.
//   `POST /__subagent?id=<subagent id>&status=completed|failed` ends one as Hermes reports it (a test's control).
//   `POST /__live?profile=<p>&id=<chat id>&status=working|waiting|end[&title=<t>]` runs a reply in another profile, as
//   `session.active_list` reports one: the chat is stored in that profile, listed as working or waiting, and `end`
//   takes it off the list and leaves it Unread there (a test's control). With `profile=default` it runs one in an
//   existing chat of the shown profile that this app hasn't resumed, such as a wake turn after a relaunch.
//   `POST /__signin[?session=<id>]&status=approved|denied|expired|error` settles a subscription sign-in (the pending
//   one when no session is named) as the provider would once the owner acts in the browser (a test's control).
//   `POST /__kanban?id=<task id>&status=<running|done|blocked|review|archived>` moves a task as a worker would (a test's
//   control). `done`, `blocked` and `review` send the chat a `status.update` naming the task and, 2 s later,
//   a streamed wake turn when the chat is live, subscribed, not stopped, and no turn runs, as Hermes's poller does.
//   `POST /__ask?chat=<chat id>&method=<method>` with a JSON body of params asks the app something, as a Hermes tool's
//   server request does (`preview.act`, `preview.read`), in that chat's live session (a test's control). It answers
//   the request's id; the app's answer shows in `/__state` under `answers`.
//   `POST /__lease?holder=agent|human` sets who holds the Bot Desktop and broadcasts `display.lease`, as Hermes does
//   when a viewer takes or hands back the screen; `human` is another client's viewer (a test's control).
//   `POST /__changed[?n=<count>&gap=<ms>]` broadcasts `sessions.changed` n times (default 1), gap ms apart, as Hermes's
//   change watcher does when another process writes the session store (a test's control).
//   `POST /__gone?id=<chat id>` deletes the chat, as another client would, and drops the app's WebSocket, so the app
//   reads the list again on reconnecting (a test's control).
//   `POST /__archive?id=<chat id>` sets the chat's Hermes `archived` flag, as another client would, and broadcasts
//   `sessions.changed` so the app reads the list again (a test's control).
//   `POST /__frame[?chat=<chat id>]` sends the request body to the app verbatim, as one WebSocket text frame, malformed
//   or not (a test's control). With `chat`, each `$SESSION` in the body is first replaced by the runtime session id of
//   that chat, which must be open in the app: `{"jsonrpc":"2.0","method":"event","params":{"type":"tool.start",
//   "session_id":"$SESSION","payload":{"tool_id":"t1","name":"terminal","preview":5}}}`.
//   `POST /__file?chat=<chat id>&path=<path in its folder>` with the file's new text as the body writes that file in the
//   folder the chat works in, as the owner editing it by hand would, such as after an "edit two files" turn, for the
//   Preview's hand-edit warning (a test's control).
//   `POST /__return?chat=<chat id>` with a JSON body `{text, display_kind, display_metadata?, reply}` runs the turn Hermes
//   starts when handed-off work comes back (`FakeHermes.returnWork`): the notice is stored as a user row with that
//   display kind and metadata, and `reply` streams as the turn's reply, in that chat's live session (a test's control).
//   `POST /__oneshot` with a JSON body `{answer?, failure?, signedOut?, hold?}` sets what `llm.oneshot` (Write with
//   AI, Regenerate title) answers: `answer` its text, `failure` Hermes's failure reason (null clears it), `signedOut`
//   the providers with no sign-in on the server, and `hold: true` keeps each answer until `POST /__oneshot?release=1`
//   (a test's control). `/__state` lists each profile's SOUL.md under `souls` and every call's params under `oneshots`.
// Group rooms (`groups.*`, src/hermes/fakeGroups.ts): the stand-in's bots take their turns by themselves, one starting
//   HV_ROOM_DELAY_MS (default 1500) after the last change and replying that long after. What they say follows the
//   owner's words (`standInScript`): `pingpong` has the first two bots name each other until the cap of 3 rounds;
//   `approve` has the last bot ask to run `rm -rf /srv/tmp/build-cache`; `clarify` has the second bot wait in the
//   `clarify` tool for 12 s; anything else gets one round of short replies. `/__state` lists each room's roster and log
//   under `rooms`, and every `groups.*` call's method under `roomCalls`.
// HV_ROOMS=1 adds three bots to seat, the profiles `ada`, `bram` and `cleo`, each with a Bot Chat.
// HV_ROOMS_BUILD=bf0203a|f0d9488 answers as that Hermes does: no `groups.continue`, no `max_continues`, no
//   `groups.changed` push (the default is `ae2a81cc`, which has all three).
// HV_INBOX=1 gives the `work` profile two Unread chats for the Rail inbox: one last active 3 days ago, one an hour ago.
// HV_EVERYWHERE=1 gives `work` a chat about the backup and adds a third profile, `ops`, with another, so an Everywhere
//   search for "backup" finds a chat in three profiles. A second stand-in without it finds one in `default`.
// HV_BAD_HISTORY=1 adds `badtool`, "Broken tool row", to `default`: its stored history has a tool row whose `context`
// is a number and one whose `name` is an object, each between two messages, as a misbehaving server might send.
// HV_LIST=<n> adds n Active, read chats to `default`, one an hour apart, so its Inbox is longer than the list panel.
// HV_DISK=<folder> copies a real folder on this computer, at its own full path, into the server's disk the preview reads
// and lists (`GET /api/fs/read-text`, `GET /api/fs/list`), so a reply's paths name files a real ssh shell also finds. It
// also puts them in the managed files (`GET /api/files`) that Server files and a project's Context card read.
// HV_COMPUTER_USE=ready|toolset-off|degraded|human gives `default` a Bot Desktop and a server machine for Settings →
// Diagnostics' Computer use rows (ADR 0215). `ready` (or 1) shows every row green. `toolset-off` leaves the computer_use
// toolset off, `degraded` has doctor fail its X11 checks, and `human` has a person hold the screen.
// HV_DELAY_MS=<ms> holds each /api/ answer that long, as a distant server's round trip would.
// HV_FAIL_PATCH=<id>,<id> answers 503 to every edit (PATCH) of those sessions, as a server that fails a write does.
// HV_MEMORY_URL=<url> is the address `default`'s Honcho gives for its documentation and its API key's "Get one" link.
// HV_BUNDLED=1 gives `default` five built-in skills (`provenance: bundled`), which a fresh profile is seeded with, for
// New bot's Skills (ADR 0197).
// HV_PERSONA_REPLY=<path>: an `llm.oneshot` whose input holds `<persona>` (Write with AI on the Persona of New bot or
// Edit bot) answers with that file's text, read at each call; an empty file answers no text. Every other one-off call
// answers as FakeHermes does.
// HV_SETTLING=<command>: a profile delete answers `settlement_pending` with that `retry_command` (empty: none).
// HV_MODEL_ERROR=<text>: a profile create makes the profile but not its model, and answers `model_error` with the text.
// `default`'s messaging gateway runs (FakeGateways), with Telegram and Discord off, so a Telegram token saved with the
// switch on, or an MCP server edited under the same name, shows Restart gateway (ADR 0205). The restart succeeds and
// connects the platforms waiting for it. HV_ACTIVE_AGENTS=<n> makes the gateway report n replies running, so the button
// asks before cutting them off.
// HV_TURNS=<n> adds the bench's two long chats to `default`'s Inbox, `long1` and `long2`, n turns each (bench/fixture.ts
// makeChat(n, 1) and (n, 2)), so the app can be timed on the chats `bench/run.mjs` renders (bench/app-split).
// HV_COMPRESS=rotate makes `session.compress` (Compact now, `/new` in a Bot Chat or a thread) move the chat to a new
// session, as Hermes does when it compacts by rotation, so a bot's threads can be shown to survive it (ADR 0211).
// Read-only check of what the server holds (the side-effect proof): `GET /__state` returns sessions, transcripts, and
// the app's answers to what the stand-in asked it, and each profile's SOUL.md, skills turned off and toolsets on, with
// the profile creates and one-off calls it received, and each profile's gateway restarts (`gatewayRestarts`).
// The same JSON is rewritten to <state-file> after every change, so it survives the bridge being stopped.
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { GROUPS_BUILDS, standInScript } from "../../../../src/hermes/fakeGroups";
import { CU } from "../../../../src/hermes/fakeComputerUse";
import { DOCTOR_NO_DISPLAY, FakeHermes, row } from "../../../../src/hermes/fakeHermes";
import { HONCHO, RETAINDB } from "../../../../src/hermes/fakeMemoryProviders";
import type { Pipe } from "../../../../src/hermes/pipe";
import { makeChat } from "../../../../bench/fixture";

const port = Number(process.argv[2] ?? 47990);
const stateFile = process.argv[3];
const USER = "verify";
const PASSWORD = "verify-pass";
const server = new FakeHermes();
const delayMs = Number(process.env.HV_DELAY_MS ?? 0);
server.checkpoints.on = process.env.HV_CHECKPOINTS !== "off";
if (process.env.HV_COMPRESS === "rotate") server.compress = "rotate";

// Synthetic seed data. Feature recipes in ../features/ name these titles; change both together.
server.sessions = [
  row("backup", 0.02, { title: "Nightly backup failing", message_count: 2 }),
  row("nginx", 0.5, { title: "Rotate nginx logs", message_count: 2 }),
  row("vpn", 2, { title: "Why is the VPN slow", message_count: 2 }),
  row("trip", 6, { title: "Plan a weekend in Lisbon", message_count: 2 }),
];
server.storeMessage("backup", { role: "user", text: "Why did the nightly backup fail?" });
server.storeMessage("backup", { role: "assistant", text: "The restic repository was still **locked** from a killed prune. Run `restic unlock`, then re-run the backup." });
server.storeMessage("nginx", { role: "user", text: "Keep 14 days of nginx logs." });
server.storeMessage("nginx", { role: "assistant", text: "Done: `rotate 14`, `daily`, `compress`." });
server.storeMessage("vpn", { role: "user", text: "Why is the VPN slow tonight?" });
server.storeMessage("vpn", { role: "assistant", text: "MTU 1500 on a 1420 tunnel: packets fragment. Set `MTU = 1380`." });
server.storeMessage("trip", { role: "user", text: "Plan a weekend in Lisbon." });
server.storeMessage("trip", { role: "assistant", text: "Day 1: Alfama and the castle. Day 2: Belém and the LX Factory." });

const TOPICS = ["Disk usage on /var", "Renew the TLS certificate", "Postgres vacuum schedule", "Grafana alert noise", "Rotate the API keys", "Cron job drift", "Swap usage spikes", "DNS TTL for the blog", "Upgrade Node on the build box", "Docker image cleanup", "Fail2ban bans", "Restic retention policy"];
for (let i = 0; i < Number(process.env.HV_LIST ?? 0); i++) {
  const at = (i + 1) / 24;
  const title = `${TOPICS[i % TOPICS.length]}${i >= TOPICS.length ? ` (${Math.floor(i / TOPICS.length) + 1})` : ""}`;
  server.sessions.push(row(`list${i + 1}`, at, { title, pinned: true }));
  server.storeMessage(`list${i + 1}`, { role: "user", text: `${title}?` });
  server.storeMessage(`list${i + 1}`, { role: "assistant", text: "Checked. Nothing to do for now." });
}

if (process.env.HV_BAD_HISTORY === "1") {
  server.sessions.push(row("badtool", 0.01, { title: "Broken tool row", message_count: 5 }));
  server.storeMessage("badtool", { role: "user", text: "List the backup folder." });
  server.storeMessage("badtool", { role: "tool", name: "terminal", context: 5 as never, args: { command: "ls /srv/backup" } });
  server.storeMessage("badtool", { role: "assistant", text: "It holds 14 snapshots. Checking their size." });
  server.storeMessage("badtool", { role: "tool", name: { tool: "terminal" } as never, context: "du -sh /srv/backup" });
  server.storeMessage("badtool", { role: "assistant", text: "The backup folder holds 14 snapshots, 212 GiB in all." });
}

const disk = (dir: string) => {
  server.serverDirs.add(dir);
  server.managedFiles.nodes[dir] = { dir: true };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) disk(path);
    else if (e.isFile()) {
      // FakeHermes keeps a file as text, or a binary one as a character per byte (a PDF, a Word file).
      const bytes = readFileSync(path);
      const text = isUtf8(bytes);
      server.serverFiles[path] = bytes.toString(text ? "utf8" : "latin1");
      server.managedFiles.nodes[path] = text ? { text: bytes.toString("utf8") } : { bytes: bytes.toString("latin1") };
    }
  }
};
if (process.env.HV_DISK) disk(process.env.HV_DISK.replace(/\/+$/, ""));

const benchTurns = Number(process.env.HV_TURNS ?? 0);
if (benchTurns > 0)
  for (const seed of [1, 2]) {
    const id = `long${seed}`;
    server.sessions.push(row(id, seed / 24, { title: `Bench ${seed}, ${benchTurns} turns`, pinned: true, message_count: benchTurns * 2 }));
    let reasoning: string | undefined;
    for (const item of makeChat(benchTurns, seed).items) {
      if (item.kind === "user") server.storeMessage(id, { role: "user", text: item.text });
      else if (item.kind === "thinking") reasoning = item.text;
      else if (item.kind === "tool") server.storeMessage(id, { role: "tool", name: item.name, context: item.preview, args: item.args, result: item.result });
      else if (item.kind === "assistant") {
        server.storeMessage(id, { role: "assistant", text: item.text, ...(reasoning && { reasoning }) });
        reasoning = undefined;
      }
    }
  }

for (const id of (process.env.HV_FAIL_PATCH ?? "").split(",").filter(Boolean))
  server.rest[`PATCH /api/sessions/${id}`] = () => {
    throw new Error(`The dashboard answered 503: {"detail":"Stand-in refuses edits of ${id}"}`);
  };

// Settings → MCP servers (ADR 0121): a second profile, servers of each kind, one from a plugin, Test results and a catalog.
server.otherProfiles = { work: [] };
if (process.env.HV_INBOX === "1")
  server.otherProfiles.work = [
    row("brief", 3, { title: "Morning brief, Monday", last_read_at: 0 }),
    row("convert", 1 / 24, { title: "Convert 12 GB to MB", last_read_at: 0 }),
  ];
if (process.env.HV_EVERYWHERE === "1") {
  server.otherProfiles.work = [...server.otherProfiles.work, row("offsite", 1, { title: "Offsite copy", message_count: 2, model: "claude-sonnet-5-5" })];
  server.otherProfiles.ops = [row("snapshots", 4, { title: "Snapshot schedule", message_count: 2, model: "gpt-6.1" })];
  server.storeMessage("offsite", { role: "user", text: "Where does the offsite copy go?" });
  server.storeMessage("offsite", { role: "assistant", text: "Each night the backup is synced to the offsite bucket after the prune." });
  server.storeMessage("snapshots", { role: "user", text: "How often do we snapshot the volumes?" });
  server.storeMessage("snapshots", { role: "assistant", text: "Hourly snapshots, kept for two days, then the nightly backup takes over." });
}
if (process.env.HV_ROOMS === "1")
  for (const [profile, color] of Object.entries({ ada: "#f59e0b", bram: "#3b82f6", cleo: "#a855f7" })) {
    server.otherProfiles[profile] = [row(`${profile}-bot`, 1, { title: "Bot Chat", hidden: true })];
    server.profileMeta[profile] = { ui_meta: { "hermes-bots": { title: profile[0].toUpperCase() + profile.slice(1), color } } };
  }
const roomsBuild = process.env.HV_ROOMS_BUILD;
if (roomsBuild === "bf0203a" || roomsBuild === "f0d9488") server.groups.build = { ...GROUPS_BUILDS[roomsBuild] };
server.groups.script = standInScript;
server.groups.auto = { delayMs: Number(process.env.HV_ROOM_DELAY_MS ?? 1500), clarifyMs: 12_000 };
server.mcp.servers.default = {
  filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/notes"] },
  github: { url: "https://mcp.example.com/github", headers: { Authorization: "Bearer ${MCP_GITHUB_API_KEY}" } },
  linear: { url: "https://mcp.example.com/linear/sse", auth: "oauth" },
  weather: { command: "uvx", args: ["weather-mcp"], env: { WEATHER_API_KEY: "wk-synthetic-0123456789" }, enabled: false },
};
server.mcp.env.default = { MCP_GITHUB_API_KEY: "ghp-synthetic-token" };
server.mcp.plugins.default = { kanban: { plugin: "kanban-board", cfg: { command: "kanban-mcp", args: ["--stdio"] } } };
server.mcp.servers.work = { calendar: { command: "cal-mcp" } };
server.mcp.probes = {
  filesystem: { tools: ["read_file", "write_file", "list_directory", "search_files"].map((name) => ({ name, description: `Synthetic ${name.replace("_", " ")}` })) },
  github: { error: "HTTP 401 from POST https://mcp.example.com/github: Bearer token rejected" },
};
server.mcp.catalogEntries = [
  { name: "context7", description: "Up-to-date library docs for the model", transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
  { name: "brave-search", description: "Web search through the Brave Search API", transport: "stdio", command: "npx", args: ["-y", "brave-search-mcp"], env: [{ name: "BRAVE_API_KEY", prompt: "Brave Search API key" }] },
];

// Clone a profile (ADR 0074): `default` has a persona and own skills to copy.
server.souls.default = "You are Hermes, the house's ops assistant. Answer briefly and name the command to run.\n";
for (const name of ["restic-unlock", "nginx-rotate", "vpn-mtu", "trip-planner", "disk-usage", "cert-renew"])
  server.skills.add("default", { dir: `/home/lena/.hermes/skills/ops/${name}`, source: "agent", category: "ops" }, `---\nname: ${name}\ndescription: Synthetic ${name} skill.\n---\n\n## When to Use\n\nWhen asked about ${name}.\n`);

if (process.env.HV_BUNDLED === "1")
  for (const name of ["arxiv", "git-helper", "hermes-agent", "recipes", "weather"])
    server.skills.add("default", { dir: `/home/liam/.hermes/skills/${name}`, source: "bundled" }, `---\nname: ${name}\ndescription: Synthetic built-in ${name} skill.\n---\n\nWhen asked about ${name}.\n`);
const personaReply = process.env.HV_PERSONA_REPLY;
if (personaReply) {
  const plain = server.oneshotAnswer;
  server.oneshotAnswer = (call) => (call.input.includes("<persona>") ? readFileSync(personaReply, "utf8") : typeof plain === "string" ? plain : plain(call));
}

const cuSeed = process.env.HV_COMPUTER_USE;
if (cuSeed) {
  server.display = {
    status: { supported: true, installed: true, missing: [], running: true, geometry: "1280x800", placement: "gateway", memory_available_mb: 19039, memory_limit_mb: 32000, browser: "/usr/bin/chromium" },
    lease: { holder: cuSeed === "human" ? "human" : "agent", viewer_hash: null, since: 1, epoch: 0 },
    minted: new Set(),
  };
  server.machine = { programs: new Set(), files: new Set(), pmInstall: { code: 0, output: "" }, browser: "/usr/bin/chromium" };
  if (cuSeed === "degraded") server.machine.computerUse = { doctor: DOCTOR_NO_DISPLAY };
  if (cuSeed !== "toolset-off") server.toolsetsOn.default = new Set([...server.enabledToolsets("default"), "computer_use"]);
}

if (process.env.HV_SETTLING !== undefined) server.profileSettlementPending = process.env.HV_SETTLING;
if (process.env.HV_MODEL_ERROR) server.profileModelError = process.env.HV_MODEL_ERROR;

const memoryUrl = process.env.HV_MEMORY_URL;
const honcho = memoryUrl ? { ...HONCHO, docsUrl: memoryUrl, fields: HONCHO.fields.map((f) => (f.kind === "secret" ? { ...f, url: memoryUrl } : f)) } : HONCHO;
server.memoryProviders.add(honcho, { ...RETAINDB });
server.memoryProviders.active = { default: "honcho", work: "" };

server.gateways.gateway.default = { running: true, platforms: {}, activeAgents: Number(process.env.HV_ACTIVE_AGENTS ?? 0) };

// MCP servers as each profile's config holds them; the `.env` (tokens) stays out.
// Each checkpointed folder's files now, and every restore the app asked for (ADR 0180).
const dump = () =>
  JSON.stringify(
    {
      sessions: server.sessions,
      transcripts: server.transcripts,
      mcp: server.mcp.servers,
      kanban: server.kanban.boards,
      answers: server.responses,
      files: Object.fromEntries(Object.keys(server.checkpoints.byFolder).map((f) => [f, server.checkpoints.files(f)])),
      restores: server.requests.filter((r) => r.method === "rollback.restore").map((r) => r.params),
      profiles: ["default", ...Object.keys(server.otherProfiles)],
      souls: server.souls,
      skillsOff: Object.fromEntries(Object.entries(server.skills.disabled).map(([p, names]) => [p, [...names].sort()])),
      skillFolders: Object.fromEntries(Object.entries(server.skills.folders).map(([p, f]) => [p, f.map((x) => x.dir.slice(x.dir.lastIndexOf("/") + 1))])),
      toolsetsOn: Object.fromEntries(Object.entries(server.toolsetsOn).map(([p, on]) => [p, [...on].sort()])),
      toolsetWrites: server.toolsetWrites,
      profileCreates: server.restRequests.filter((r) => r.method === "POST" && r.path === "/api/profiles").map((r) => r.body),
      oneshots: server.requests.filter((r) => r.method === "llm.oneshot").map((r) => r.params),
      gatewayRestarts: server.gateways.restarts,
      rooms: server.groups.dump(),
      roomCalls: server.groups.calls.map((c) => c.method),
    },
    null,
    2,
  );
const save = () => stateFile && writeFileSync(stateFile, dump());
/** Lets held `llm.oneshot` answers go (`/__oneshot?release=1`). */
let releaseOneshot: (() => void) | undefined;
save();

const longParagraphs = Number(process.env.HV_LONG_REPLY ?? 0);
const paragraph = (i: number) =>
  `Step ${i}: check the **restic** lock, then the prune schedule. See [the docs](https://restic.readthedocs.io/en/stable/) and run:\n\n` +
  `\`\`\`sh\nrestic -r sftp:backup@nas:/srv/restic unlock\nrestic -r sftp:backup@nas:/srv/restic check --read-data-subset=${i}/100\n\`\`\`\n\n` +
  `- keep-daily 7\n- keep-weekly 4\n- keep-monthly ${i % 12}\n\n| host | size | when |\n|---|---|---|\n| nas | ${i * 3} GiB | 02:00 |\n| web | ${i} GiB | 03:00 |\n`;

const mathReply = (broken: boolean) =>
  "The backup window is the time to read the data plus the time to send it, so with $n$ snapshots of size $s$ over a link of " +
  "bandwidth \\(b\\) it takes about $t = \\frac{n \\cdot s}{b}$. That holds while the link, not the disk, is the limit. It costs $5 and $10 a month on either plan.\n\n" +
  "$$\n\\sigma = \\sqrt{\\frac{1}{N}\\sum_{i=1}^{N} (x_i - \\mu)^2}\n$$\n\n" +
  "The prune runs after the check:\n\n" +
  (broken ? "```mermaid\nsequenceDiagram\n  cron->>restic: unlock\n  restic-->>\n```\n" : "```mermaid\nsequenceDiagram\n  cron->>restic: unlock\n  restic-->>cron: ok\n  cron->>restic: check --read-data-subset=5%\n  restic-->>cron: no errors\n  cron->>restic: forget --prune\n```\n");

function replyTo(sessionId: string, prompt: string, said?: string, persisted_turn?: Record<string, unknown>) {
  const long = longParagraphs > 0 && prompt.startsWith("long");
  const math = prompt.startsWith("math") || prompt.startsWith("badmath");
  const canned = process.env.HV_REPLY_FILE && prompt.startsWith("canned") ? readFileSync(process.env.HV_REPLY_FILE, "utf8") : undefined;
  const text =
    said ??
    canned ??
    (long
      ? Array.from({ length: longParagraphs }, (_, i) => paragraph(i)).join("\n")
      : math
        ? mathReply(prompt.startsWith("badmath"))
        : `Stand-in reply to: ${prompt.slice(0, 80)}`);
  server.event(sessionId, "message.start");
  const words = text.split(" ");
  let at = 0;
  const step = () => {
    const from = at;
    at = Math.min(words.length, at + 3);
    server.event(sessionId, "message.delta", { text: words.slice(from, at).join(" ") + (at < words.length ? " " : "") });
    if (at < words.length) return void setTimeout(step, long ? 40 : 120);
    const stored = server.runtime.get(sessionId);
    if (stored) server.storeMessage(stored, { role: "assistant", text });
    setTimeout(() => {
      server.event(sessionId, "message.complete", { text, status: "complete", ...(persisted_turn && { persisted_turn }) });
      save();
    }, 120);
  };
  setTimeout(step, 400);
}

function toolsReply(sessionId: string) {
  const sleep = (seconds: number) => new Promise<void>((done) => setTimeout(done, seconds * 1000));
  return server
    .toolTurn(
      sessionId,
      {
        calls: [
          [{ name: "terminal", args: { command: "df -h /srv" }, result: { output: "/dev/sda1  1.8T  1.7T  92% /srv", exit_code: 0 }, seconds: 2.4 }],
          [{ name: "read_file", args: { path: "/srv/backup/last-run.log" }, result: { error: "File not found: /srv/backup/last-run.log" }, seconds: 0.3 }],
        ],
        reply: "The NAS is 92% full. The backup log isn't where I expected it, so I couldn't check the last run.",
        modelSeconds: 1.2,
        tokens: { prompt: 1800, output: 90 },
        costUsd: 0.0031,
      },
      sleep,
    )
    .then(save);
}

server.kanban.wakeDelayMs = 2_000;
server.kanban.wakeWith = (sid, _stored, text, user_row_id) => replyTo(sid, "", text, { user_row_id });
// A goal's next turn starts once the last one is judged, as Hermes's does (fakeGoals.ts, ADR 0187).
server.goalTurn = (sid, prompt) => setTimeout(() => replyTo(sid, prompt), 2_000);

// The subagents a "delegate" prompt started, as `subagent.start` / `subagent.complete` payloads carry them
// (`tools/delegate_tool.py` at the deployed `f0d94882`). Each is also in Hermes's registry, for `subagent.list`.
const TEAM = ["Read the auth code", "Read the tests"];
const delegated = new Map<string, { sid: string; stored: string; payload: Record<string, unknown> }>();
let started = 0;

function delegate(sid: string, queue: boolean) {
  const stored = server.runtime.get(sid);
  if (!stored) return;
  server.event(sid, "message.start");
  server.event(sid, "message.delta", { text: "Delegating to two subagents." });
  TEAM.forEach((goal, task_index) => {
    const subagent_id = `sa-${++started}`;
    const payload = { subagent_id, goal, task_index, task_count: TEAM.length, depth: 0, delegation_id: `dlg-${sid}`, model: "stand-in-model" };
    delegated.set(subagent_id, { sid, stored, payload });
    (server.subagents[stored] ??= []).push({ ...payload, owner: sid, status: "running", accepting_steer: true, started_at: Date.now() / 1000 });
    server.event(sid, "subagent.start", payload);
  });
  if (!queue) return;
  const subagent_id = `sa-${++started}`;
  const payload = { subagent_id, goal: "Write the summary", task_index: TEAM.length, task_count: TEAM.length + 1, depth: 0, delegation_id: `dlg-${sid}`, model: "stand-in-model" };
  delegated.set(subagent_id, { sid, stored, payload });
  (server.subagents[stored] ??= []).push({ ...payload, owner: sid, status: "queued", accepting_steer: false });
  server.event(sid, "subagent.spawn_requested", payload);
}

/** The sessions running a computer-use turn, which ends itself on Stop. */
const cuTurns = new Set<string>();

function setLease(holder: "agent" | "human") {
  const d = (server.display ??= { status: { supported: true, installed: true, missing: [], running: false, geometry: "1280x800" }, lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 0 }, minted: new Set() });
  if (d.lease.holder === holder) return;
  d.lease = { holder, viewer_hash: holder === "human" ? "0123456789ab" : null, since: Date.now() / 1000, epoch: d.lease.epoch + 1 };
  server.broadcast("display.lease", { profile_key: "/home/lena/.hermes", lease: { ...d.lease, viewer_id: null, reason: holder === "human" ? "taking over" : "" } });
}

const DESK_RUN = [
  CU.capture(),
  CU.click([620, 780], "background"),
  CU.capture("xfce4-panel", "Xfce4-panel", "xfce4-panel"),
  CU.click([22, 21], "background", "xfce4-panel"),
  CU.capture("xfce4-terminal", "Xfce4-terminal", "Terminal - lena@hermes: ~"),
  CU.type("df -h /srv"),
  CU.key("return"),
  CU.wait(1),
  CU.capture("xfce4-terminal", "Xfce4-terminal", "Terminal - lena@hermes: ~"),
  CU.key("ctrl+l"),
  CU.type("du -sh /srv/backup"),
  CU.key("return"),
  CU.wait(1),
  CU.capture("xfce4-terminal", "Xfce4-terminal", "Terminal - lena@hermes: ~"),
  CU.click([400, 300], "background", "xfce4-terminal"),
  CU.key("ctrl+shift+c"),
  CU.capture("xfce4-terminal", "Xfce4-terminal", "Terminal - lena@hermes: ~"),
  CU.key("alt+f4"),
  CU.wait(1),
  CU.capture(),
];

function computerUse(sid: string, prompt: string) {
  setLease(/takeover/i.test(prompt) ? "human" : (server.display?.lease.holder ?? "agent"));
  server.cuGrants.always.add("cua:key:foreground");
  cuTurns.add(sid);
  const sleep = (seconds: number) => new Promise<void>((done) => setTimeout(done, Math.min(seconds, 1) * 600));
  const turn = /takeover/i.test(prompt)
    ? { steps: [CU.capture()], reply: "Someone has taken over the Bot Desktop, so I stopped. Hand it back and I'll carry on." }
    : { steps: DESK_RUN, reply: "/srv is 92% full, and /srv/backup holds 212 GiB of it." };
  void server
    .computerUseTurn(sid, turn, sleep)
    .finally(() => cuTurns.delete(sid))
    .then(save);
}

function askApproval(sid: string) {
  server.event(sid, "message.start");
  server.askApproval(sid);
}

function failReply(sid: string) {
  server.event(sid, "message.start");
  setTimeout(() => server.event(sid, "error", { message: "Stand-in provider error: the model is overloaded." }), 200);
}

function endSubagent(id: string, status: string) {
  const d = delegated.get(id) ?? backgroundSubagent(id);
  if (!d) return false;
  delegated.delete(id);
  server.subagents[d.stored] = (server.subagents[d.stored] ?? []).filter((r) => r.subagent_id !== id);
  server.event(d.sid, "subagent.complete", { ...d.payload, status, summary: `Stand-in subagent ${status}.` });
  return true;
}

function backgroundSubagent(id: string) {
  for (const [stored, rows] of Object.entries(server.subagents)) {
    const { owner, tail: _, ...payload } = rows.find((r) => r.subagent_id === id) ?? {};
    if (typeof owner === "string") return { sid: owner, stored, payload };
  }
  return undefined;
}

let pipe: Pipe | undefined;
let send: ((text: string) => void) | undefined;
let closeSocket: (() => void) | undefined;
const open = async (profile: string) => {
  pipe = await server.openPipe((e) => (e.kind === "frame" ? send?.(e.text) : undefined), profile);
};
await open("default");

// The smallest WebSocket server the Rust client needs: text frames, client frames masked, no extensions.
function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const head =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : body.length < 65536
        ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x81;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(body.length), 2);
            return h;
          })();
  return Buffer.concat([head, body]);
}
// A write to a socket the app has closed is dropped.
const alive = (sock: Socket) => sock.writable && !sock.destroyed;
function readFrames(sock: Socket, onText: (t: string) => void) {
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15;
      let len = buf[1] & 127,
        off = 2;
      if (buf.length < (len === 126 ? 4 : len === 127 ? 10 : 2)) return;
      if (len === 126) (len = buf.readUInt16BE(2)), (off = 4);
      else if (len === 127) (len = Number(buf.readBigUInt64BE(2))), (off = 10);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
      buf = buf.subarray(off + 4 + len);
      if (op === 1) onText(data.toString());
      else if (op === 8) sock.end();
      else if (op === 9 && alive(sock)) sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]));
    }
  });
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  console.log(new Date().toISOString(), req.method, url.pathname + url.search);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString() || undefined;
  if (delayMs && url.pathname.startsWith("/api/")) await new Promise((r) => setTimeout(r, delayMs));
  const json = (status: number, v: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof v === "string" ? v : JSON.stringify(v));
  };
  if (url.pathname === "/__state") return json(200, dump());
  if (url.pathname === "/__oneshot" && req.method === "POST") {
    if (url.searchParams.has("release")) {
      releaseOneshot?.();
      releaseOneshot = undefined;
      server.oneshotGate = undefined;
      return json(200, { ok: true });
    }
    const o = JSON.parse(body ?? "{}") as { answer?: unknown; failure?: unknown; signedOut?: unknown; hold?: unknown };
    if (typeof o.answer === "string") server.oneshotAnswer = o.answer;
    if ("failure" in o) server.oneshotFailure = typeof o.failure === "string" ? o.failure : undefined;
    if (Array.isArray(o.signedOut)) server.signedOut = new Set(o.signedOut.filter((p): p is string => typeof p === "string"));
    if (o.hold === true && !releaseOneshot) server.oneshotGate = new Promise<void>((r) => (releaseOneshot = r));
    return json(200, { ok: true });
  }
  if (url.pathname === "/__subagent" && req.method === "POST") {
    const id = url.searchParams.get("id") ?? "";
    return endSubagent(id, url.searchParams.get("status") ?? "completed") ? json(200, { ok: true }) : json(404, { detail: `No running stand-in subagent ${id}` });
  }
  if (url.pathname === "/__live" && req.method === "POST") {
    const [profile, id, status] = ["profile", "id", "status"].map((k) => url.searchParams.get(k) ?? "");
    const shown = profile === "default";
    if (!(shown || profile in server.otherProfiles) || !id || !["working", "waiting", "end"].includes(status)) return json(400, { detail: "Needs profile, id and status working|waiting|end" });
    const t = Date.now() / 1000;
    const list = server.store(profile)!;
    if (shown && !list.some((r) => r.id === id)) return json(404, { detail: `No chat ${id} in default` });
    const stored = list.find((r) => r.id === id) ?? (list.push(row(id, 0, { title: url.searchParams.get("title") ?? `Chat ${id}`, last_read_at: 0 })), list[list.length - 1]);
    stored.last_active = t;
    server.liveSessions = server.liveSessions.filter((l) => l.session_key !== id);
    if (status !== "end") server.liveSessions.push({ id: `rt-${id}`, session_key: id, status, last_active: t, started_at: t, title: stored.title ?? "" });
    save();
    return json(200, { ok: true, live: server.liveSessions.length });
  }
  if (url.pathname === "/__signin" && req.method === "POST") {
    const status = url.searchParams.get("status") ?? "approved";
    const session = url.searchParams.get("session") || [...server.accounts.sessions.values()].find((s) => s.status === "pending")?.id;
    if (!session || !["approved", "denied", "expired", "error"].includes(status)) return json(400, { detail: "No pending sign-in, or status isn't approved|denied|expired|error" });
    server.accounts.settle(session, status as "approved", status === "error" ? "Token exchange failed." : undefined);
    return json(200, { ok: true, session });
  }
  if (url.pathname === "/__kanban" && req.method === "POST") {
    const id = url.searchParams.get("id") ?? "";
    const moved = server.kanban.move(id, url.searchParams.get("status") ?? "done");
    save();
    return moved ? json(200, { ok: true, task: server.kanban.find(id) }) : json(404, { detail: `No stand-in task ${id}` });
  }
  if (url.pathname === "/__lease" && req.method === "POST") {
    const holder = url.searchParams.get("holder");
    if (holder !== "agent" && holder !== "human") return json(400, { detail: "holder must be agent or human" });
    setLease(holder);
    return json(200, { ok: true, lease: server.display!.lease });
  }
  if (url.pathname === "/__changed" && req.method === "POST") {
    const n = Number(url.searchParams.get("n") ?? 1);
    const gap = Number(url.searchParams.get("gap") ?? 0);
    for (let i = 0; i < n; i++) {
      if (i && gap) await new Promise((r) => setTimeout(r, gap));
      server.broadcast("sessions.changed");
    }
    return json(200, { ok: true, sent: n });
  }
  if (url.pathname === "/__gone" && req.method === "POST") {
    const id = url.searchParams.get("id") ?? "";
    const before = server.sessions.length;
    server.sessions = server.sessions.filter((s) => s.id !== id);
    if (server.sessions.length === before) return json(404, { detail: `No stand-in chat ${id}` });
    save();
    closeSocket?.();
    return json(200, { ok: true });
  }
  if (url.pathname === "/__archive" && req.method === "POST") {
    const session = server.sessions.find((s) => s.id === url.searchParams.get("id"));
    if (!session) return json(404, { detail: `No stand-in chat ${url.searchParams.get("id")}` });
    session.archived = true;
    save();
    server.broadcast("sessions.changed");
    return json(200, { ok: true });
  }
  if (url.pathname === "/__frame" && req.method === "POST") {
    const chat = url.searchParams.get("chat");
    const runtime = chat === null ? "" : server.runtimeIdOf(chat);
    if (runtime === undefined) return json(400, { detail: `Chat ${chat} isn't open in the app` });
    if (!send) return json(409, { detail: "The app has no WebSocket open" });
    send((body ?? "").replaceAll("$SESSION", runtime));
    return json(200, { ok: true });
  }
  if (url.pathname === "/__file" && req.method === "POST") {
    const chat = url.searchParams.get("chat") ?? "";
    const runtime = server.runtimeIdOf(chat);
    const path = (url.searchParams.get("path") ?? "").replace(/^\/+/, "");
    if (!runtime || !path) return json(400, { detail: "Needs chat (a chat open in the app) and path (in the folder it works in)" });
    server.serverFiles[`${server.folderOf(runtime, chat)}/${path}`] = body ?? "";
    save();
    return json(200, { ok: true });
  }
  if (url.pathname === "/__return" && req.method === "POST") {
    const chat = url.searchParams.get("chat") ?? "";
    if (!server.runtimeIdOf(chat)) return json(400, { detail: `Chat ${chat} isn't open in the app` });
    const { reply, ...notice } = JSON.parse(body ?? "{}");
    server.returnWork(chat, notice, String(reply ?? "Results are in."));
    save();
    return json(200, { ok: true });
  }
  if (url.pathname === "/__ask" && req.method === "POST") {
    const runtime = server.runtimeIdOf(url.searchParams.get("chat") ?? "");
    const method = url.searchParams.get("method") ?? "";
    if (!runtime || !method) return json(400, { detail: "Needs chat (a chat open in the app) and method" });
    const id = server.ask(runtime, method, JSON.parse(body ?? "{}"));
    setTimeout(save, 500);
    return id ? json(200, { id }) : json(409, { detail: "The app didn't say it answers server requests" });
  }
  if (url.pathname === "/auth/password-login") {
    const b = JSON.parse(body ?? "{}");
    if (b.username !== USER || b.password !== PASSWORD) return json(401, { detail: "Invalid credentials" });
    return json(200, { ok: true }, { "set-cookie": "hermes_session=synthetic; Path=/; HttpOnly" });
  }
  if (url.pathname === "/api/auth/ws-ticket") return json(200, { ticket: "synthetic" });
  try {
    const text = await pipe!.request(req.method as never, url.pathname.slice(1) + url.search, body);
    json(200, text);
    if (req.method !== "GET") save();
  } catch (e) {
    const m = /answered (\d+): (.*)$/s.exec((e as Error).message);
    json(m ? Number(m[1]) : 500, m ? m[2] : { detail: (e as Error).message });
  }
});
http.on("upgrade", async (req, sock: Socket) => {
  const url = new URL(req.url!, "http://x");
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  // Node drops its own `error` handler from an upgraded socket, so without this an app that closes the WebSocket
  // mid-write (EPIPE, ECONNRESET) takes the stand-in down (#432). The socket is destroyed; the app reconnects.
  sock.on("error", (e: NodeJS.ErrnoException) => console.log(new Date().toISOString(), "WS closed by the app:", e.code ?? e.message));
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  send = (t) => void (alive(sock) && sock.write(frame(t)));
  closeSocket = () => sock.destroy();
  readFrames(sock, (t) => {
    try {
      const msg = JSON.parse(t) as { method?: string; params?: { session_id?: string; text?: string; subagent_id?: string } };
      if (msg.method && msg.method !== "gateway.ping") console.log(new Date().toISOString(), "WS", msg.method, msg.params?.session_id ?? "");
      if (msg.method === "prompt.submit" && msg.params?.session_id) {
        const { session_id, text } = msg.params;
        const prompt = String(text ?? "");
        setTimeout(() => {
          save();
          if (/^computer use/i.test(prompt)) computerUse(session_id, prompt);
          else if (/delegate/i.test(prompt)) delegate(session_id, /queue/i.test(prompt));
          else if (/approval/i.test(prompt)) askApproval(session_id);
          else if (/^fail/i.test(prompt)) failReply(session_id);
          else if (/^tools/i.test(prompt)) void toolsReply(session_id);
          else if (/dispatch|background|edit two files/i.test(prompt)) setTimeout(save, 500);
          else replyTo(session_id, prompt);
        }, 0);
      }
      const stop = msg.method === "subagent.interrupt" ? delegated.get(String(msg.params?.subagent_id)) : undefined;
      if (stop && stop.sid === msg.params?.session_id) setTimeout(() => endSubagent(String(msg.params!.subagent_id), "interrupted"), 50);
      if (msg.method === "session.interrupt" && server.runtime.has(String(msg.params?.session_id)) && !cuTurns.has(String(msg.params?.session_id)))
        setTimeout(() => server.event(String(msg.params!.session_id), "message.complete", { status: "interrupted", text: "" }), 50);
    } catch {
      // Not JSON: FakeHermes answers it as it would.
    }
    void pipe!.send(t);
  });
  await open(url.searchParams.get("profile") ?? "default");
});
http.listen(port, "127.0.0.1", () => console.log(`stand-in dashboard ready on http://127.0.0.1:${port}`));
