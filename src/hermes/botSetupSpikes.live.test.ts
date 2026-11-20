// Bot setup's spikes (#85) replayed against a REAL Hermes dashboard: skipped unless HERMES_LIVE_DASHBOARD is set, and
// refused unless every profile on that server resolves, symlinks followed, inside HERMES_LIVE_SANDBOX, a throwaway root
// in /tmp apart from ~/.hermes (liveSandbox.ts). It makes profiles named `bs-…` and deletes them, failing the run when
// one is left. Each spike keeps its control, so a run shows the check can fail.
//
// It reads what Hermes showed the model from the request log of the verify skill's model stub, which also scripts the
// tool calls (`direct:`, `calltool:`). The skill's sandbox has both; bind nothing at 127.0.0.1. The MCP spike needs
// Hermes's `mcp` SDK (2.3.0 at ae2a81cc), which a venv may lack: install it apart, without the packages the venv has
// (or Hermes runs on their newer copies), and pass that folder as RH_PYTHONPATH:
//
//   RH_VENV=~/.cache/hermes-v0232/venv RH_PYTHONPATH=/tmp/bs-pydeps \
//   .claude/skills/verify-hermes-chat/scripts/real-hermes up /tmp/bs-live
//   HERMES_LIVE_DASHBOARD=$(cat /tmp/bs-live/url) HERMES_LIVE_SANDBOX=/tmp/bs-live HERMES_LIVE_USER=verify \
//   HERMES_LIVE_PASSWORD=verify-pass HERMES_LIVE_MODEL_LOG=/tmp/bs-live/model-requests.jsonl npx vitest run src/hermes/botSetupSpikes.live.test.ts
//
// HERMES_LIVE_SKIP_SEED=1 makes the seeded Bot Chat open as the control does, unseeded: its check must then fail.
// HERMES_LIVE_SKIP_RELOAD=1 leaves out Set it up's reload.mcp in the MCP copy test: its tool call must then fail.
// HERMES_LIVE_KEEP_MEMORY=1 has Start fresh remove no memory entry: its check of the memory files must then fail.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { botSetupBrief } from "./botSetupBrief";
import { RestError, type OpenPipe, type Pipe, type RestMethod } from "./pipe";
import { addMcp, mcpOffer, type McpSources } from "./botSetupMcp";
import { removeAttempted, sandboxRefusal } from "./liveSandbox";
import { McpApi } from "./mcp";
import { ProfilesApi } from "./profiles";
import { APP_SOURCE, RpcError, connect } from "./transport";

// This app's tsconfig has no Node types; vitest runs the file in Node.
declare const process: { env: Record<string, string | undefined> };
type Fs = { readFileSync(p: string, e: string): string; realpathSync(p: string): string; mkdirSync(p: string, o: { recursive: boolean }): void; writeFileSync(p: string, text: string): void };
const fs = async () => (await import(/* @vite-ignore */ "node:fs" as string)) as Fs;
const readText = async (path: string): Promise<string> => (await fs()).readFileSync(path, "utf8");

const BASE = process.env.HERMES_LIVE_DASHBOARD;
const MODEL_LOG = process.env.HERMES_LIVE_MODEL_LOG ?? "";
const SKIP_SEED = process.env.HERMES_LIVE_SKIP_SEED === "1";
const SKIP_RELOAD = process.env.HERMES_LIVE_SKIP_RELOAD === "1";
const KEEP_MEMORY = process.env.HERMES_LIVE_KEEP_MEMORY === "1";
const RUN = Date.now().toString(36);

type Event = { type: string; session_id?: string; payload?: Record<string, unknown> };
/** One model request as the stub logs it: the user rows, system prompt and tool names Hermes sent. */
type ModelRequest = { kind: string; users?: string[]; system?: string; tools?: string[] };

/** Dashboard REST with the sign-in cookies, failing as the Rust relay does; and `/api/ws` connections opened as it opens them. */
function dashboard() {
  let cookie = "";
  const send = async (method: string, path: string, body?: string) => {
    const res = await fetch(new URL(path, BASE), { method, headers: { cookie, "content-type": "application/json" }, body });
    for (const c of res.headers.getSetCookie()) cookie = [...cookie.split("; ").filter((p) => p && !p.startsWith(c.split("=")[0] + "=")), c.split(";")[0]].join("; ");
    return res;
  };
  const request = async (method: RestMethod, path: string, body?: string): Promise<string> => {
    if (!cookie) await send("POST", "auth/password-login", JSON.stringify({ provider: "basic", username: process.env.HERMES_LIVE_USER, password: process.env.HERMES_LIVE_PASSWORD }));
    const res = await send(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new RestError(res.status, text.slice(0, 300));
    return text;
  };
  const rest = async (method: RestMethod, path: string, body?: unknown): Promise<any> => JSON.parse(await request(method, path, body === undefined ? undefined : JSON.stringify(body)));
  const wsUrl = async (profile: string) => {
    const { ticket } = await rest("POST", "api/auth/ws-ticket");
    const url = new URL(`api/ws?ticket=${encodeURIComponent(ticket)}&profile=${profile}`, BASE);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  };

  const openPipe: OpenPipe = async (onEvent, profile) => {
    const ws = new WebSocket(await wsUrl(profile));
    await new Promise((open, failed) => {
      ws.onopen = open;
      ws.onerror = () => failed(new Error("the WebSocket failed"));
    });
    ws.onmessage = (m) => {
      for (const text of String(m.data).split("\n").filter((l) => l.trim())) onEvent({ kind: "frame", text });
    };
    ws.onclose = () => onEvent({ kind: "closed", reason: "The test closed the connection." });
    const pipe: Partial<Pipe> = {
      route: { kind: "url", url: BASE!, addresses: [] },
      send: async (frame) => ws.send(frame),
      request,
      getLimited: (path) => request("GET", path),
      close: async () => ws.close(),
    };
    return pipe as Pipe;
  };

  /** One connection: JSON-RPC calls, every event pushed, and a turn that waits for its reply. */
  const socket = async () => {
    const ws = new WebSocket(await wsUrl("default"));
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const events: Event[] = [];
    let wake = () => {};
    await new Promise((open, failed) => {
      ws.onopen = open;
      ws.onerror = () => failed(new Error("the WebSocket failed"));
    });
    ws.onmessage = (m) => {
      for (const line of String(m.data).split("\n").filter((l) => l.trim())) {
        const f = JSON.parse(line);
        if (f.method === "event") events.push(f.params);
        const p = typeof f.id === "number" ? pending.get(f.id) : undefined;
        if (p) {
          pending.delete(f.id);
          if (f.error) p.reject(new RpcError(f.error.code, f.error.message));
          else p.resolve(f.result);
        }
      }
      wake();
    };
    let id = 0;
    const rpc = (method: string, params: Record<string, unknown>): Promise<any> =>
      new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    /** Sends a prompt and returns the session's events up to its `message.complete` or `error`. */
    const turn = async (sid: string, profile: string, text: string, extra: Record<string, unknown> = {}) => {
      const from = events.length;
      await rpc("prompt.submit", { session_id: sid, profile, text, ...extra });
      const end = Date.now() + 90_000;
      for (;;) {
        const seen = events.slice(from).filter((e) => e.session_id === sid);
        if (seen.some((e) => e.type === "message.complete" || e.type === "error")) return seen;
        if (Date.now() > end) throw new Error(`No reply in ${sid} within 90 s: ${seen.map((e) => e.type).join(", ")}`);
        await new Promise<void>((r) => ((wake = r), setTimeout(r, 500)));
      }
    };
    return { rpc, turn, close: () => ws.close() };
  };
  return { rest, socket, openPipe };
}

const replyOf = (evs: Event[]) => evs.filter((e) => e.type === "message.complete").map((e) => String(e.payload?.text ?? "")).join(" ");
const noticed = (evs: Event[]) => evs.some((e) => e.type === "notice" && String(e.payload?.message).startsWith("Capabilities updated"));

/** Every request in the stub's log, which it makes at its first. */
async function modelRequests(): Promise<ModelRequest[]> {
  const text = await readText(MODEL_LOG).catch((e: { code?: string }) => (e.code === "ENOENT" ? "" : Promise.reject(e)));
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ModelRequest);
}
/** The first turn request the stub got after the log held `from` lines: what the model was shown as that turn began. */
async function shownSince(from: number): Promise<ModelRequest> {
  const req = (await modelRequests()).slice(from).find((r) => r.kind === "turn");
  if (!req) throw new Error("The model stub logged no turn request.");
  return req;
}

describe.skipIf(!BASE)("Bot setup's spikes against a throwaway Hermes", () => {
  const hermes = dashboard();
  const profiles = new ProfilesApi(hermes.rest);
  let ws: Awaited<ReturnType<typeof hermes.socket>>;
  // Set only once the server is known to be a throwaway; cleanup does nothing without it.
  let safe = false;
  /** Every name this run sent a create for, tracked before it was sent: a lost answer may still have made it. */
  const attempted: string[] = [];

  beforeAll(async () => {
    const { profiles: rows } = (await hermes.rest("GET", "api/profiles")) as { profiles: { name: string; path: string }[] };
    const { realpathSync } = await fs();
    const refused = sandboxRefusal(process.env.HERMES_LIVE_SANDBOX, process.env.HOME, rows.map((p) => p.path), realpathSync);
    if (refused) throw new Error(`Refusing to run: ${refused}`);
    if (!MODEL_LOG) throw new Error("Set HERMES_LIVE_MODEL_LOG to the model stub's request log.");
    safe = true;
    ws = await hermes.socket();
  }, 60_000);

  // vitest runs afterAll even when beforeAll threw, so it checks `safe` first. Only the profiles this run tried to make;
  // one left fails the run.
  afterAll(async () => {
    ws?.close();
    if (safe) await removeAttempted(attempted, profiles);
  }, 120_000);

  const newProfile = async (what: string) => {
    const name = `bs-${RUN}-${what}`;
    // Never one that was there before: cleanup deletes every name tracked here.
    if ((await profiles.list()).some((p) => p.name === name)) throw new Error(`${name} already exists.`);
    attempted.push(name);
    await profiles.create({ name });
    return name;
  };
  /** A Bot Chat as Bot setup opens one: hidden, titled, following the profile's config, the brief seeded as a hidden row. */
  const botChat = async (profile: string, seed?: string) => {
    const params = { profile, title: "Bot Chat", hidden: true, follow_profile_config: true, source: APP_SOURCE };
    const created = await ws.rpc("session.create", seed === undefined ? params : { ...params, messages: [{ role: "user", content: seed, display_kind: "hidden" }] });
    await ws.rpc("session.title", { session_id: created.session_id, title: "Bot Chat" });
    return String(created.session_id);
  };
  const lookup = async (profile: string) => ((await ws.rpc("session.list", { profile, title: "Bot Chat", include_hidden: true, limit: 5 })).sessions as { id: string }[]).map((s) => s.id);
  const storedRows = async (profile: string, id: string) =>
    ((await hermes.rest("GET", `api/sessions/${id}/messages?profile=${profile}`)).messages as { role: string; display_kind: string | null; content: string | null }[]).map((m) => [m.role, m.display_kind, m.content ?? ""] as const);

  // spikes/s2c_assert.py and s2.py: the brief seeded at create keeps Hermes's first-contact note off the first turn.
  describe("seeding the brief (S2)", () => {
    const opened = async (seeded: boolean) => {
      const profile = await newProfile(seeded ? "s2-seeded" : "s2-control");
      const brief = `[highwing:bot-setup v1 id=${profile}]\nBRIEF`;
      const sid = await botChat(profile, seeded && !SKIP_SEED ? brief : undefined);
      const from = (await modelRequests()).length;
      await ws.turn(sid, profile, seeded ? `[highwing:bot-setup begin id=${profile}]` : brief, { display_kind: "hidden" });
      const shown = (await shownSince(from)).users!.join("\n");
      const [stored] = await lookup(profile);
      return { profile, sid, shown, stored, rows: await storedRows(profile, stored) };
    };

    it("control: an unseeded first turn gets Hermes's first-contact note", async () => {
      const { shown, rows } = await opened(false);
      console.log("control rows:", rows.map(([r, k, c]) => [r, k, c.slice(0, 40)]));
      expect(shown).toContain("This is the user's very first message ever.");
      // The note goes to the model only; the stored row is the brief as sent.
      expect(rows[0]).toEqual(["user", "hidden", expect.not.stringContaining("System note")]);
    }, 120_000);

    it("seeded: the model gets the brief and the begin and no note; both rows are stored hidden, and resume leaves them out", async () => {
      const { profile, shown, stored, rows } = await opened(true);
      console.log("seeded rows:", rows.map(([r, k, c]) => [r, k, c.slice(0, 40)]));
      expect(shown).not.toContain("very first message ever");
      expect(shown).toContain("BRIEF");
      expect(rows.map(([r, k]) => [r, k])).toEqual([
        ["user", "hidden"],
        ["user", "hidden"],
        ["assistant", null],
      ]);
      const again = await hermes.socket();
      const resumed = await again.rpc("session.resume", { session_id: stored, profile, inline_images: false });
      again.close();
      expect((resumed.messages as { role: string }[]).map((m) => m.role)).toEqual(["assistant"]);
    }, 120_000);
  });

  // spikes/s3.py: archiving the Bot Chat frees its title, and unarchiving doesn't take it back.
  it("archiving a Bot Chat frees the title for a new one (S3)", async () => {
    const profile = await newProfile("s3");
    const live = await botChat(profile, "[highwing:bot-setup v1]");
    const [old] = await lookup(profile);
    await ws.rpc("session.close", { session_id: live });
    const patch = async (edit: Record<string, unknown>) => {
      const snap = await hermes.rest("GET", `api/sessions/${old}/mutation-snapshot?profile=${profile}`);
      return hermes.rest("PATCH", `api/sessions/${old}?profile=${profile}`, { ...edit, profile, request_id: crypto.randomUUID(), expected_revision: snap.runtime_revision });
    };
    const row = async () => hermes.rest("GET", `api/sessions/${old}?profile=${profile}`);
    expect(await patch({ archived: true })).toMatchObject({ ok: true, archived: true });
    expect(await row()).toMatchObject({ title: null, archived: 1, hidden: 0 });
    expect(await lookup(profile)).toEqual([]);
    await patch({ title: "Earlier Bot Chat" });
    const archived = await hermes.rest("GET", `api/sessions?profile=${profile}&archived=only&limit=10&offset=0&order=recent`);
    expect((archived.sessions as { id: string; title: string }[]).map((s) => [s.id, s.title])).toEqual([[old, "Earlier Bot Chat"]]);
    await botChat(profile, "[highwing:bot-setup v1]");
    const [fresh] = await lookup(profile);
    expect(fresh).not.toBe(old);
    await patch({ archived: false });
    expect(await row()).toMatchObject({ title: "Earlier Bot Chat", archived: 0 });
    expect(await lookup(profile)).toEqual([fresh]);
  }, 120_000);

  // Hermes has no call that adds a memory entry, so the entries are written into the throwaway profile's own folder.
  it("Start fresh, run by the app's transport, archives the Bot Chat, names it, clears the memory and seeds a new one (S3)", async () => {
    const profile = await newProfile("fresh");
    const { profiles: listed } = (await hermes.rest("GET", "api/profiles")) as { profiles: { name: string; path: string }[] };
    const home = listed.find((p) => p.name === profile)!.path;
    const { mkdirSync, writeFileSync, realpathSync } = await fs();
    const outside = sandboxRefusal(process.env.HERMES_LIVE_SANDBOX, process.env.HOME, [home], realpathSync);
    if (outside) throw new Error(`Refusing to write memory files: ${outside}`);
    mkdirSync(`${home}/memories`, { recursive: true });
    writeFileSync(`${home}/memories/MEMORY.md`, ["Rome trip is in May.", "Prefers trains."].join("\n§\n"));
    writeFileSync(`${home}/memories/USER.md`, "The owner wants to be called Lena.");
    const title = `Earlier Bot Chat with ${profile}, 19 Nov 2026`;
    const app = await connect(hermes.openPipe, profile);
    try {
      const me = async () => (await app.bots()).find((b) => b.profile === profile)!;
      const old = await app.openBotChat(await me());
      await app.send(old, "Rome to Florence?");
      const settled = async (id: string) => {
        for (const end = Date.now() + 90_000; app.getSnapshot().chats.find((c) => c.id === id)?.running; ) {
          if (Date.now() > end) throw new Error(`The reply in ${id} didn't end in 90 s.`);
          await new Promise((r) => setTimeout(r, 300));
        }
      };
      await settled(old);
      expect(await lookup(profile)).toEqual([old]);
      const entries = Object.values((await app.memory.load(profile)).resources).flatMap((r) => r.entries);
      expect(entries.map((e) => e.text)).toEqual(["Rome trip is in May.", "Prefers trains.", "The owner wants to be called Lena."]);
      const current = await app.botSetupCurrent(await me());
      const brief = (id: string) => botSetupBrief({ id, name: profile, inventory: { models: [], skills: [], toolsets: [], bots: [] }, current });

      const end = await app.startBotFresh(await me(), brief, KEEP_MEMORY ? [] : entries, title);
      console.log("Start fresh ended:", JSON.stringify(end));
      expect(end).toMatchObject({ kind: "fresh", start: { kind: "waiting" }, missed: {}, memoryLeft: 0 });
      if (end.kind !== "fresh" || end.start.kind === "refused") throw new Error("Start fresh didn't start a new Bot Chat.");
      const made = end.start.chatId;
      expect(made).not.toBe(old);

      const oldRow = await hermes.rest("GET", `api/sessions/${old}?profile=${profile}`);
      console.log("old row:", JSON.stringify({ title: oldRow.title, archived: oldRow.archived, hidden: oldRow.hidden }));
      expect(oldRow).toMatchObject({ title, archived: 1, hidden: 0 });
      expect(await lookup(profile)).toEqual([made]);
      const archived = await hermes.rest("GET", `api/sessions?profile=${profile}&archived=only&limit=10&offset=0&order=recent`);
      expect((archived.sessions as { id: string; title: string }[]).map((s) => [s.id, s.title])).toEqual([[old, title]]);
      const memory = [await readText(`${home}/memories/MEMORY.md`), await readText(`${home}/memories/USER.md`)];
      console.log("memory files after:", JSON.stringify(memory));
      expect(memory.map((m) => m.trim())).toEqual(["", ""]);
      await settled(made);
      const rows = await storedRows(profile, made);
      console.log("new Bot Chat rows:", rows.map(([r, k, c]) => [r, k, c.slice(0, 44)]));
      expect(rows.map(([r, k]) => [r, k])).toEqual([
        ["user", "hidden"],
        ["user", "hidden"],
        ["assistant", null],
      ]);
      expect(rows[0][2]).toContain("Bot setup again");
      expect(rows[0][2]).toContain("CURRENT (how you are set up now");

      expect(await app.restore(old)).toBe(true);
      expect(await hermes.rest("GET", `api/sessions/${old}?profile=${profile}`)).toMatchObject({ title, archived: 0 });
      expect(await lookup(profile)).toEqual([made]);
    } finally {
      await app.close();
    }
  }, 300_000);

  // spikes/s1v2.py: toolsets and persona changed mid-chat reach the Bot Chat's next turn, with or without a Bot Mode
  // block and a reconnect, and a call to a newly enabled tool runs.
  for (const [block, reconnect] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])
    it(`a Bot Chat picks up toolsets and persona changed mid-chat (S1, block ${block}, reconnect ${reconnect})`, async () => {
      const profile = await newProfile(`s1-${+block}${+reconnect}`);
      if (block) {
        const row = (await ws.rpc("profiles.list", {})).profiles.find((r: { name: string }) => r.name === profile);
        const r = await ws.rpc("profiles.configure", { name: profile, ui_meta: { "hermes-bots": { title: "S1" } }, ui_meta_expected_revisions: { "hermes-bots": row.ui_meta_revisions?.["hermes-bots"] ?? 0 } });
        expect(r.applied?.ui_meta).toBe(true);
      }
      await hermes.rest("PUT", `api/profiles/${profile}/soul`, { content: "Your name is Before.\n" });
      let sid = await botChat(profile, "[highwing:bot-setup v1]");
      let from = (await modelRequests()).length;
      expect(noticed(await ws.turn(sid, profile, "one"))).toBe(false);
      const first = await shownSince(from);
      expect(first.system).toContain("Your name is Before.");
      expect(first.tools).toContain("web_search");
      expect(first.tools!.some((t) => t.startsWith("kanban"))).toBe(false);

      await hermes.rest("PUT", `api/tools/toolsets/kanban?profile=${profile}`, { enabled: true });
      await hermes.rest("PUT", `api/tools/toolsets/web?profile=${profile}`, { enabled: false });
      await hermes.rest("PUT", `api/profiles/${profile}/soul`, { content: "Your name is After.\n" });
      let socket = ws;
      if (reconnect) {
        socket = await hermes.socket();
        sid = (await socket.rpc("session.resume", { session_id: (await lookup(profile))[0], profile, inline_images: false })).session_id;
      }
      from = (await modelRequests()).length;
      const evs = await socket.turn(sid, profile, "direct:kanban_list {}");
      const second = await shownSince(from);
      expect(second.system).toContain("Your name is After.");
      expect(second.tools!.some((t) => t.startsWith("kanban"))).toBe(true);
      expect(second.tools).not.toContain("web_search");
      // After a reconnect too: the resume attaches the session still live, which keeps what its last turn saw.
      expect(noticed(evs)).toBe(true);
      const reply = replyOf(evs);
      console.log(`kanban_list (block ${block}, reconnect ${reconnect}):`, reply.slice(0, 200));
      // The board's answer (spikes/s1v2.out), not an error Hermes returned in its place.
      const result = JSON.parse(reply.replace(/^TOOL RESULT: /, "")) as Record<string, unknown>;
      expect(result).toMatchObject({ tasks: [], count: 0 });
      expect(result).not.toHaveProperty("error");
      const shown = JSON.stringify(await socket.rpc("tools.show", { session_id: sid }));
      expect(shown).toContain("kanban_list");
      expect(shown).not.toContain("web_search");
      if (socket !== ws) socket.close();
    }, 180_000);

  // spikes/s1mcp_v2.py, s1mcp_v3.py and s1mcp_v4.py: an MCP server added mid-chat is out of reach until reload.mcp
  // with confirm on the Bot Chat, and never reached from a profile whose config lacks it.
  it("an MCP server added mid-chat is reached only after reload.mcp on the Bot Chat (S1 MCP)", async () => {
    const ECHO = "mcp__probe__probe_echo";
    const call = async (sid: string, profile: string, text: string) => replyOf(await ws.turn(sid, profile, `calltool:${ECHO} {"text": "${text}"}`));
    const unknown = `'${ECHO}' is not a known tool name`;
    const profile = await newProfile("mcp");
    const sid = await botChat(profile, "[highwing:bot-setup v1]");
    expect(await call(sid, profile, "before-add")).toContain(unknown);

    await hermes.rest("POST", `api/mcp/servers?profile=${profile}`, { name: "probe", command: "python3", args: ["-I", "-c", ECHO_SERVER] });
    // The server works: Hermes's own test lists its tool.
    expect(JSON.stringify(await hermes.rest("POST", `api/mcp/servers/probe/test?profile=${profile}`))).toContain("probe_echo");
    const added = await ws.turn(sid, profile, `calltool:${ECHO} {"text": "echo-7731"}`);
    // Hermes says the bot's tools were refreshed, and still can't reach the server: the notice proves nothing about MCP.
    expect(noticed(added)).toBe(true);
    expect(replyOf(added)).toContain(unknown);
    expect(replyOf(await ws.turn(sid, profile, "direct:tool_search {\"queries\": [\"probe\"]}"))).not.toContain(ECHO);

    const asked = await ws.rpc("reload.mcp", { session_id: sid });
    expect(asked).toMatchObject({ status: "confirm_required" });
    expect(await call(sid, profile, "echo-2")).toContain(unknown);
    expect(await ws.rpc("reload.mcp", { session_id: sid, confirm: true })).toMatchObject({ status: "reloaded" });
    const after = await call(sid, profile, "echo-4");
    console.log("after reload.mcp:", after);
    expect(after).toBe('TOOL RESULT: {"result": "echo-4"}');
    expect(JSON.stringify(await ws.rpc("tools.show", { session_id: sid }))).not.toContain("probe_echo");

    const other = await newProfile("mcp-other");
    const theirs = String((await ws.rpc("session.create", { profile: other, source: APP_SOURCE, messages: [{ role: "user", content: "x", display_kind: "hidden" }] })).session_id);
    expect(await call(theirs, other, "echo-leak")).toContain(unknown);
  }, 300_000);

  it("a copied stdio server's tool runs in the Bot Chat after Set it up's reload, with the key typed at Connect (MCP copy)", async () => {
    const TOOL = "mcp__keyed__probe_echo";
    const mcp = new McpApi(hermes.rest, () => Promise.reject(new Error("Not used here.")), async () => []);
    const source = await newProfile("mcp-src");
    await hermes.rest("POST", `api/mcp/servers?profile=${source}`, { name: "keyed", command: "python3", args: ["-I", "-c", KEYED_SERVER], env: { PROBE_KEY: "source-secret-1234" } });
    const folder = (await profiles.list()).find((p) => p.name === source)?.path;
    expect(folder).toMatch(/\/profiles\//);
    await hermes.rest("POST", `api/mcp/servers?profile=${source}`, { name: "inside", command: `${folder}/mcp-installs/inside/run` });
    const listed = await mcp.list(source);
    expect(JSON.stringify(await hermes.rest("GET", `api/mcp/servers?profile=${source}`))).not.toContain("source-secret-1234");
    const sources: McpSources = { catalog: [], bots: { Source: { path: folder, servers: listed.servers } } };
    expect(mcpOffer(sources, "inside", "Source")).toMatchObject({ kind: "refused", why: "path" });
    const offer = mcpOffer(sources, "keyed", "Source");
    if (offer?.kind !== "copy") throw new Error(`keyed isn't offered as a copy: ${JSON.stringify(offer)}`);
    expect(offer.secrets).toEqual([{ key: "PROBE_KEY", required: true }]);

    const bot = await newProfile("mcp-bot");
    const sid = await botChat(bot, "[highwing:bot-setup v1]");
    const call = async (text: string) => replyOf(await ws.turn(sid, bot, `calltool:${TOOL} {"text": "${text}"}`));
    expect(await call("before-setup")).toContain(`'${TOOL}' is not a known tool name`);

    expect(await addMcp(mcp, bot, "keyed", offer, {})).toEqual({ state: { kind: "connect" } });
    expect(await addMcp(mcp, bot, "keyed", offer, { PROBE_KEY: "fresh-7731" })).toEqual({ state: { kind: "reload" } });
    const live = (await ws.rpc("session.active_list", {})).sessions as { status: string }[];
    expect(live.filter((s) => ["starting", "working", "waiting"].includes(s.status))).toEqual([]);
    if (!SKIP_RELOAD) expect(await ws.rpc("reload.mcp", { session_id: sid, confirm: true })).toMatchObject({ status: "reloaded" });
    const after = await call("echo-5");
    console.log("after Set it up:", after);
    expect(after).toBe('TOOL RESULT: {"result": "fresh-7731:echo-5"}');
  }, 300_000);
});

/**
 * A stdio MCP server with one tool, `probe_echo`, that answers its `text` (spikes/echo_mcp.py), after `before`, a Python
 * expression.
 */
const echoServer = (before = '""') => `
import json, os, sys
TOOL = {"name": "probe_echo", "description": "Echo text back.", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}
for line in sys.stdin:
    try:
        m = json.loads(line)
    except ValueError:
        continue
    if "id" not in m:
        continue
    meth = m.get("method")
    if meth == "initialize":
        r = {"protocolVersion": m["params"].get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "probe", "version": "1"}}
    elif meth == "tools/list":
        r = {"tools": [TOOL]}
    elif meth == "tools/call":
        r = {"content": [{"type": "text", "text": ${before} + m["params"]["arguments"].get("text", "")}]}
    elif meth == "ping":
        r = {}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": "no"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
`;

const ECHO_SERVER = echoServer();
const KEYED_SERVER = echoServer('os.environ.get("PROBE_KEY", "") + ":"');
