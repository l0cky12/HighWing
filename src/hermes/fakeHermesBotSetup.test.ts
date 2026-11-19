// The Hermes behaviours Bot setup (#85) stands on, as FakeHermes models them. Each mirrors a spike against real Hermes
// at ae2a81cc (botSetupSpikes.live.test.ts replays them there).
import { describe, expect, it } from "vitest";
import { CAPABILITIES_UPDATED, FakeHermes, PROFILE_BUILD_NOTE, row } from "./fakeHermes";
import { APP_SOURCE } from "./transport";

type Frame = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string }; method?: string; params?: { type: string; session_id: string; payload: Record<string, unknown> } };

const BOT = "travel-buddy";
const BRIEF = "[highwing:bot-setup v1 id=probe]\nBRIEF";
const BEGIN = "[highwing:bot-setup begin id=probe]";

async function connected(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.otherProfiles = { [BOT]: [], ada: [] };
  setup(server);
  const answers = new Map<number, Frame>();
  const events: NonNullable<Frame["params"]>[] = [];
  const pipe = await server.openPipe((e) => {
    if (e.kind !== "frame") return;
    const f = JSON.parse(e.text) as Frame;
    if (typeof f.id === "number") answers.set(f.id, f);
    if (f.method === "event" && f.params) events.push(f.params);
  }, "default");
  let next = 0;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++next;
    await pipe.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return answers.get(id)!;
  };
  const rest = async (method: "GET" | "PATCH" | "PUT" | "POST", path: string, body?: Record<string, unknown>) =>
    JSON.parse(await pipe.request(method, path, body && JSON.stringify(body))) as Record<string, unknown>;
  /** A Bot Chat as the app opens one: hidden, titled, the brief seeded as a hidden row when `seeded`. */
  const botChat = async (profile = BOT, seeded = true) => {
    const made = (await call("session.create", { profile, title: "Bot Chat", hidden: true, follow_profile_config: true, source: APP_SOURCE, ...(seeded && { messages: [{ role: "user", content: BRIEF, display_kind: "hidden" }] }) })).result!;
    await call("session.title", { session_id: made.session_id, title: "Bot Chat" });
    return { ...made, sid: String(made.session_id), stored: String(made.stored_session_id) };
  };
  /** Sends a prompt and waits for the microtasks its scripted reply runs in; returns the events it caused. */
  const turn = async (sid: string, text: string, extra: Record<string, unknown> = {}) => {
    const from = events.length;
    await call("prompt.submit", { session_id: sid, text, ...extra });
    await new Promise((r) => setTimeout(r, 0));
    return events.slice(from).filter((e) => e.session_id === sid);
  };
  const reply = (evs: { type: string; payload: Record<string, unknown> }[]) => evs.filter((e) => e.type === "message.complete").map((e) => String(e.payload.text)).join(" ");
  const stored = async (id: string, profile = BOT) => ((await rest("GET", `/api/sessions/${id}/messages?profile=${profile}`)).messages as Record<string, unknown>[]).map((m) => [m.role, m.display_kind, m.content]);
  const lookup = async (profile = BOT) => ((await call("session.list", { profile, title: "Bot Chat", include_hidden: true })).result!.sessions as { id: string }[]).map((s) => s.id);
  return { server, call, rest, botChat, turn, reply, stored, lookup };
}

describe("a Bot Chat made with its brief seeded", () => {
  it("stores the brief as a hidden row at once, under its title, and sends none of it back", async () => {
    const { server, botChat, stored, lookup } = await connected();
    const chat = await botChat();
    expect(chat).toMatchObject({ message_count: 0, messages: [] });
    expect(server.otherProfiles[BOT].find((s) => s.id === chat.stored)).toMatchObject({ title: "Bot Chat", hidden: true, preview: "" });
    expect(await stored(chat.stored)).toEqual([["user", "hidden", BRIEF]]);
    expect(await lookup()).toEqual([chat.stored]);
  });

  it("keeps only rows Hermes takes from a client: user, assistant or system with text, hidden the only display kind", async () => {
    const { call, stored } = await connected();
    const made = (await call("session.create", {
      profile: BOT,
      messages: [
        { role: "user", content: "kept", display_kind: "hidden" },
        { role: "assistant", content: "shown", display_kind: "steer" },
        { role: "tool", content: "dropped" },
        { role: "user", content: "  " },
      ],
    })).result!;
    expect(made).toMatchObject({ message_count: 1, messages: [{ role: "assistant", text: "shown" }] });
    expect(await stored(String(made.stored_session_id))).toEqual([
      ["user", "hidden", "kept"],
      ["assistant", null, "shown"],
    ]);
  });
});

describe("a hidden prompt.submit", () => {
  it("is stored hidden and left out of the history session.resume sends", async () => {
    const { call, botChat, turn, stored } = await connected();
    const chat = await botChat();
    await turn(chat.sid, BEGIN, { display_kind: "hidden" });
    await turn(chat.sid, "Liam");
    expect(await stored(chat.stored)).toEqual([
      ["user", "hidden", BRIEF],
      ["user", "hidden", BEGIN],
      ["user", null, "Liam"],
    ]);
    const resumed = (await call("session.resume", { session_id: chat.stored, profile: BOT })).result!;
    expect(resumed.messages).toEqual([expect.objectContaining({ role: "user", text: "Liam" })]);
  });

  it("is left out of a resume that reattaches a session waiting on the owner, and not counted", async () => {
    const { server, call, botChat, turn } = await connected();
    await call("client.capabilities", { server_requests: true });
    const chat = await botChat();
    await turn(chat.sid, BEGIN, { display_kind: "hidden" });
    await turn(chat.sid, "Liam");
    expect(server.ask(chat.sid, "clarify", { question: "Which city?", choices: null })).toBeDefined();
    const resumed = (await call("session.resume", { session_id: chat.stored, profile: BOT })).result!;
    expect(resumed).toMatchObject({ running: true, message_count: 1, messages: [expect.objectContaining({ role: "user", text: "Liam" })] });
  });

  it("takes no other display kind from a client", async () => {
    const { botChat, turn, stored } = await connected();
    const chat = await botChat();
    await turn(chat.sid, "Hello", { display_kind: "steer" });
    expect((await stored(chat.stored)).at(-1)).toEqual(["user", null, "Hello"]);
  });
});

describe("Hermes's first-contact note", () => {
  const userRows = (server: FakeHermes) => server.modelCalls.at(-1)!.user;

  it("is appended to the first turn of a new profile's first chat, and not stored (control)", async () => {
    const { server, botChat, turn, stored } = await connected();
    const chat = await botChat(BOT, false);
    await turn(chat.sid, BRIEF, { display_kind: "hidden" });
    expect(userRows(server)).toEqual([`${BRIEF}\n\n${PROFILE_BUILD_NOTE}`]);
    expect(await stored(chat.stored)).toEqual([["user", "hidden", BRIEF]]);
  });

  it("doesn't fire once the brief is seeded: the model reads the brief and the begin, and no note", async () => {
    const { server, botChat, turn } = await connected();
    const chat = await botChat();
    await turn(chat.sid, BEGIN, { display_kind: "hidden" });
    expect(userRows(server)).toEqual([BRIEF, BEGIN]);
  });

  it("fires on no later turn, and in no later chat of the profile", async () => {
    const { server, botChat, turn, call } = await connected();
    const chat = await botChat(BOT, false);
    await turn(chat.sid, "hi");
    await turn(chat.sid, "again");
    expect(userRows(server)).toEqual([expect.not.stringContaining("System note"), "again"]);
    const other = (await call("session.create", { profile: BOT })).result!;
    await turn(String(other.session_id), "a second chat");
    expect(userRows(server)).toEqual(["a second chat"]);
  });

  it("doesn't fire in a profile that has chats already", async () => {
    const { server, botChat, turn } = await connected((s) => s.otherProfiles.ada.push(row("old", 3)));
    const chat = await botChat("ada", false);
    await turn(chat.sid, BRIEF);
    expect(userRows(server)).toEqual([BRIEF]);
  });
});

describe("archiving a Bot Chat", () => {
  const patch = async (h: Awaited<ReturnType<typeof connected>>, id: string, edit: Record<string, unknown>) => {
    const snap = await h.rest("GET", `/api/sessions/${id}/mutation-snapshot?profile=${BOT}`);
    return h.rest("PATCH", `/api/sessions/${id}`, { ...edit, profile: BOT, request_id: crypto.randomUUID(), expected_revision: snap.runtime_revision });
  };

  it("frees the title: the lookup comes back empty, the old chat is an ordinary archived one, and a new Bot Chat takes the name", async () => {
    const h = await connected();
    const old = await h.botChat();
    await patch(h, old.stored, { archived: true });
    expect(await h.lookup()).toEqual([]);
    expect(await h.rest("GET", `/api/sessions/${old.stored}?profile=${BOT}`)).toMatchObject({ title: null, archived: 1, hidden: false });
    await patch(h, old.stored, { title: "Earlier Bot Chat" });
    const archived = (await h.rest("GET", `/api/sessions?profile=${BOT}&archived=only&limit=10&offset=0&order=recent`)).sessions as { id: string; title: string }[];
    expect(archived.map((s) => [s.id, s.title])).toEqual([[old.stored, "Earlier Bot Chat"]]);
    const fresh = await h.botChat();
    expect(await h.lookup()).toEqual([fresh.stored]);
  });

  it("isn't undone by unarchiving: the new Bot Chat keeps the name", async () => {
    const h = await connected();
    const old = await h.botChat();
    await patch(h, old.stored, { archived: true });
    const fresh = await h.botChat();
    await patch(h, old.stored, { archived: false });
    expect(await h.lookup()).toEqual([fresh.stored]);
    expect(h.server.otherProfiles[BOT].find((s) => s.id === old.stored)).toMatchObject({ title: null, archived: false });
  });

  it("leaves any other chat's title where it was", async () => {
    const h = await connected((s) => s.otherProfiles[BOT].push(row("plans", 1, { title: "Plans" })));
    await patch(h, "plans", { archived: true });
    expect(h.server.otherProfiles[BOT][0]).toMatchObject({ title: "Plans", archived: true });
  });
});

describe("a Bot Chat whose capabilities change mid-chat", () => {
  const change = async (h: Awaited<ReturnType<typeof connected>>) => {
    await h.rest("PUT", `/api/tools/toolsets/image_gen?profile=${BOT}`, { enabled: true });
    await h.rest("PUT", `/api/tools/toolsets/web?profile=${BOT}`, { enabled: false });
    await h.rest("PUT", `/api/profiles/${BOT}/soul`, { content: "Your name is After.\n" });
  };

  it("gets the new toolsets and persona on its next turn, with Hermes's notice, and tools.show agrees", async () => {
    const h = await connected((s) => (s.souls[BOT] = "Your name is Before.\n"));
    const chat = await h.botChat();
    const first = await h.turn(chat.sid, "one");
    expect(first.some((e) => e.type === "notice")).toBe(false);
    expect(h.server.modelCalls.at(-1)).toMatchObject({ soul: "Your name is Before.\n", tools: expect.arrayContaining(["web_search"]) });
    expect(h.server.modelCalls.at(-1)!.tools).not.toContain("image_generate");
    await change(h);
    const second = await h.turn(chat.sid, "two");
    expect(second.filter((e) => e.type === "notice").map((e) => e.payload)).toEqual([{ message: CAPABILITIES_UPDATED }]);
    expect(h.server.modelCalls.at(-1)).toMatchObject({ soul: "Your name is After.\n", tools: expect.arrayContaining(["image_generate"]) });
    expect(h.server.modelCalls.at(-1)!.tools).not.toContain("web_search");
    const shown = JSON.stringify((await h.call("tools.show", { session_id: chat.sid })).result);
    expect(shown).toContain("image_generate");
    expect(shown).not.toContain("web_search");
    expect((await h.turn(chat.sid, "three")).some((e) => e.type === "notice")).toBe(false);
  });

  it("gets them after a reconnect too, told as before: the resume attaches the session still live", async () => {
    const h = await connected();
    const chat = await h.botChat();
    await h.turn(chat.sid, "one");
    await change(h);
    const sid = String((await h.call("session.resume", { session_id: chat.stored, profile: BOT })).result!.session_id);
    expect((await h.turn(sid, "two")).filter((e) => e.type === "notice")).toHaveLength(1);
    expect(h.server.modelCalls.at(-1)).toMatchObject({ soul: "Your name is After.\n", tools: expect.arrayContaining(["image_generate"]) });
  });

  it("is told once: every resume attaches the one live session, so a later unchanged turn isn't told again", async () => {
    const h = await connected();
    const chat = await h.botChat();
    await h.turn(chat.sid, "one");
    await change(h);
    const resume = async () => String((await h.call("session.resume", { session_id: chat.stored, profile: BOT })).result!.session_id);
    const sid = await resume();
    expect(sid).toBe(chat.sid);
    expect((await h.turn(sid, "two")).filter((e) => e.type === "notice")).toHaveLength(1);
    expect(await resume()).toBe(chat.sid);
    expect((await h.turn(chat.sid, "three")).some((e) => e.type === "notice")).toBe(false);
  });

  it("isn't told after the session was closed: the resume builds a new one from the profile as it is", async () => {
    const h = await connected();
    const chat = await h.botChat();
    await h.turn(chat.sid, "one");
    const resume = async () => String((await h.call("session.resume", { session_id: chat.stored, profile: BOT })).result!.session_id);
    await h.call("session.close", { session_id: await resume() });
    await change(h);
    const sid = await resume();
    expect(sid).not.toBe(chat.sid);
    expect((await h.turn(sid, "two")).some((e) => e.type === "notice")).toBe(false);
    expect(h.server.modelCalls.at(-1)).toMatchObject({ soul: "Your name is After.\n" });
  });

  it("only in a Bot Chat: another chat keeps the agent it was built with", async () => {
    const h = await connected();
    const sid = String((await h.call("session.create", { profile: BOT, title: "Plans" })).result!.session_id);
    await h.turn(sid, "one");
    await change(h);
    expect((await h.turn(sid, "two")).some((e) => e.type === "notice")).toBe(false);
    expect(h.server.modelCalls.at(-1)!.tools).toContain("web_search");
  });
});

describe("an MCP server added mid-chat", () => {
  const ECHO = "mcp__probe__probe_echo";
  const add = (h: Awaited<ReturnType<typeof connected>>) => h.rest("POST", `/api/mcp/servers?profile=${BOT}`, { name: "probe", command: "/opt/echo-mcp" });
  const setup = (s: FakeHermes) => (s.mcp.probes.probe = { tools: [{ name: "probe_echo", description: "Echo text back." }] });

  it("can't be reached through tool_search or tool_call until reload.mcp with confirm on that chat", async () => {
    const h = await connected(setup);
    const chat = await h.botChat();
    expect(h.reply(await h.turn(chat.sid, `calltool:${ECHO} {"text": "before-add"}`))).toContain(`'${ECHO}' is not a known tool name`);
    await add(h);
    // Hermes tells the Bot Chat its tools were refreshed, and still can't reach the server.
    const added = await h.turn(chat.sid, `calltool:${ECHO} {"text": "echo-7731"}`);
    expect(added.filter((e) => e.type === "notice")).toHaveLength(1);
    expect(h.reply(added)).toContain(`'${ECHO}' is not a known tool name`);
    expect(h.reply(await h.turn(chat.sid, "searchtools:probe"))).toBe('SEARCH RESULT: {"queries":["probe"],"results":[{"query":"probe","matches":[]}]}');
    expect((await h.call("reload.mcp", { session_id: chat.sid })).result).toMatchObject({ status: "confirm_required" });
    expect(h.reply(await h.turn(chat.sid, `calltool:${ECHO} {"text": "echo-2"}`))).toContain("is not a known tool name");
    expect((await h.call("reload.mcp", { session_id: chat.sid, confirm: true })).result).toMatchObject({ status: "reloaded" });
    expect(h.reply(await h.turn(chat.sid, `calltool:${ECHO} {"text": "echo-4"}`))).toBe('TOOL RESULT: {"result":"echo-4"}');
    expect(h.reply(await h.turn(chat.sid, "searchtools:probe"))).toContain(`"matches":["${ECHO}"]`);
    expect(h.server.modelCalls.at(-1)!.mcp).toEqual([ECHO]);
    // Hermes's tools.show never lists MCP tools.
    expect(JSON.stringify((await h.call("tools.show", { session_id: chat.sid })).result)).not.toContain("probe_echo");
    expect(h.server.mcpReloads).toEqual([chat.sid]);
  });

  it("is never reached from a profile whose config lacks it", async () => {
    const h = await connected(setup);
    const chat = await h.botChat();
    await add(h);
    await h.call("reload.mcp", { session_id: chat.sid, confirm: true });
    const other = String((await h.call("session.create", { profile: "ada", messages: [{ role: "user", content: "x", display_kind: "hidden" }] })).result!.session_id);
    expect(h.reply(await h.turn(other, `calltool:${ECHO} {"text": "echo-leak"}`))).toContain("is not a known tool name");
  });

  it("is reached by a chat built after a reload, and a server there from the start needs none", async () => {
    const h = await connected((s) => {
      setup(s);
      s.mcp.servers[BOT] = { probe: { command: "/opt/echo-mcp" } };
    });
    const chat = await h.botChat();
    expect(h.reply(await h.turn(chat.sid, `calltool:${ECHO} {"text": "at-start"}`))).toBe('TOOL RESULT: {"result":"at-start"}');
  });
});
