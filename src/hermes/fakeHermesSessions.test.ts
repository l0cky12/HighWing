import { describe, expect, it } from "vitest";
import { FakeHermes, row } from "./fakeHermes";

type Answer = { result?: Record<string, unknown>; error?: { code: number; message: string } };

async function connected(setup: (server: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.sessions = [row("side", 1, { title: "Disk usage" }), row("bot", 2, { title: "Bot Chat", hidden: true })];
  server.transcripts = {
    bot: [
      { role: "user", text: "Plan the VLANs" },
      { role: "assistant", text: "Three VLANs: lab, home, guests." },
    ],
  };
  setup(server);
  const answers = new Map<number, Answer>();
  const pipe = await server.openPipe((e) => {
    if (e.kind !== "frame") return;
    const frame = JSON.parse(e.text) as Answer & { id?: number };
    if (typeof frame.id === "number") answers.set(frame.id, frame);
  }, "default");
  let next = 0;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++next;
    await pipe.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return answers.get(id)!;
  };
  const rest = async (method: "GET" | "PATCH", path: string, body?: Record<string, unknown>) => JSON.parse(await pipe.request(method, path, body && JSON.stringify(body))) as Record<string, unknown>;
  const listed = async (params: Record<string, unknown> = {}) => ((await call("session.list", params)).result!.sessions as Record<string, unknown>[]).map((s) => s.id);
  return { server, call, rest, listed };
}

describe("a hidden session", () => {
  it("is hidden by PATCH /api/sessions/{id}, and then left out of the REST list but not of search", async () => {
    const { server, rest } = await connected((s) => (s.transcripts.side = [{ role: "user", text: "How full is the disk?" }]));
    const ids = async () => ((await rest("GET", "/api/sessions?limit=50")).sessions as { id: string }[]).map((s) => s.id);
    expect(await ids()).toEqual(["side"]);
    await rest("PATCH", "/api/sessions/side", { hidden: true, request_id: "r1", expected_revision: 0 });
    expect(server.sessions.find((s) => s.id === "side")!.hidden).toBe(true);
    expect(await ids()).toEqual([]);
    const hits = (await rest("GET", "/api/sessions/search?q=disk")).results as { id: string }[];
    expect(hits.map((h) => h.id)).toEqual(["side"]);
  });

  it("is born hidden under its title once session.title stores it, and that title is then taken", async () => {
    const { server, call } = await connected();
    const made = (await call("session.create", { title: "VLAN plan", hidden: true })).result!;
    expect(server.sessions.some((s) => s.id === made.stored_session_id)).toBe(false);
    expect((await call("session.title", { session_id: made.session_id, title: "VLAN plan" })).result).toEqual({ title: "VLAN plan", pending: false });
    expect(server.sessions.find((s) => s.id === made.stored_session_id)).toMatchObject({ title: "VLAN plan", hidden: true, message_count: 0 });
    const second = (await call("session.create", { title: "VLAN plan", hidden: true })).result!;
    expect((await call("session.title", { session_id: second.session_id, title: "VLAN plan" })).error).toMatchObject({ code: 4022, message: expect.stringContaining("already in use") });
  });

  it("keeps the title it was created with when its first message stores it", async () => {
    const { server, call } = await connected();
    const made = (await call("session.create", { title: "VLAN plan", hidden: true })).result!;
    await call("prompt.submit", { session_id: made.session_id, text: "Start with the lab" });
    expect(server.sessions.find((s) => s.id === made.stored_session_id)).toMatchObject({ title: "VLAN plan", hidden: true });
  });
});

describe("session.branch", () => {
  const resumed = async (call: Awaited<ReturnType<typeof connected>>["call"], id: string, profile?: string) =>
    String((await call("session.resume", { session_id: id, ...(profile && { profile }) })).result!.session_id);

  it("names the branch as asked, as a child of its parent, and answers a repeated key with the same branch", async () => {
    const { server, call } = await connected();
    const parent = await resumed(call, "bot");
    const params = { session_id: parent, count: 1, name: "VLAN plan", idempotency_key: "k1" };
    const first = (await call("session.branch", params)).result!;
    expect(first).toMatchObject({ title: "VLAN plan", parent: "bot", message_count: 1 });
    expect(server.sessions.find((s) => s.id === first.stored_session_id)).toMatchObject({ parent_session_id: "bot", title: "VLAN plan" });
    expect((await call("session.branch", params)).result).toMatchObject({ stored_session_id: first.stored_session_id, session_id: first.session_id });
    expect(server.sessions.filter((s) => s.title === "VLAN plan")).toHaveLength(1);
  });

  it("refuses a name another session of the profile holds, and stores nothing", async () => {
    const { server, call } = await connected((s) => s.sessions.push(row("vlan", 2 / 24, { title: "VLAN plan", hidden: true })));
    const before = server.sessions.length;
    const answer = await call("session.branch", { session_id: await resumed(call, "bot"), name: "VLAN plan" });
    expect(answer.error).toMatchObject({ code: 5008, message: expect.stringContaining("already in use") });
    expect(server.sessions).toHaveLength(before);
  });

  it("puts a branch in its parent's profile, on that profile's model", async () => {
    const { server, call } = await connected((s) => {
      s.otherProfiles = { scribe: [row("scribe-bot", 1, { title: "Bot Chat", hidden: true })] };
      s.transcripts["scribe-bot"] = [{ role: "user", text: "Draft the notes" }];
      s.profileModel.scribe = { model: "gpt-5", provider: "openai", reasoning_effort: "high", fast: false };
    });
    const branch = (await call("session.branch", { session_id: await resumed(call, "scribe-bot", "scribe"), name: "Notes" })).result!;
    expect(branch.info).toMatchObject({ model: "gpt-5", provider: "openai" });
    expect(server.otherProfiles.scribe.some((s) => s.id === branch.stored_session_id)).toBe(true);
    expect((await call("session.title", { session_id: branch.session_id, title: "Notes 2" })).result).toMatchObject({ title: "Notes 2" });
    expect(server.otherProfiles.scribe.find((s) => s.id === branch.stored_session_id)!.title).toBe("Notes 2");
  });
});

describe("session.list", () => {
  it("lists hidden rows only when asked, the latest activity first, and no more than the limit", async () => {
    const { listed } = await connected((s) => {
      s.sessions.push(row("backups", 30 / 24, { title: "Backups", hidden: true }), row("vlan", 2 / 24, { title: "VLAN plan", hidden: true }));
    });
    expect(await listed()).toEqual(["side"]);
    expect(await listed({ include_hidden: true })).toEqual(["vlan", "side", "backups", "bot"]);
    expect(await listed({ include_hidden: true, limit: 2 })).toEqual(["vlan", "side"]);
  });

  it("answers an exact title with its row and the lineage's tip, and nothing for an archived one", async () => {
    const { server, call } = await connected((s) => s.sessions.push(row("vlan", 2 / 24, { title: "VLAN plan", hidden: true })));
    const lookup = async () => (await call("session.list", { title: "VLAN plan", include_hidden: true })).result!.sessions;
    expect(await lookup()).toMatchObject([{ id: "vlan", resolved_id: "vlan", title: "VLAN plan" }]);
    server.sessions.find((s) => s.id === "vlan")!.archived = true;
    expect(await lookup()).toEqual([]);
  });
});

describe("session.compress set to rotate", () => {
  it("moves the chat to a new session: the old one ends, its title stays, and the lists show the lineage under the new id", async () => {
    const { server, call, listed } = await connected((s) => (s.compress = "rotate"));
    const runtime = String((await call("session.resume", { session_id: "bot" })).result!.session_id);
    expect((await call("session.compress", { session_id: runtime })).result).toMatchObject({ status: "compressed" });

    const tip = server.sessions.find((s) => s.parent_session_id === "bot")!.id;
    expect(server.sessions.find((s) => s.id === "bot")).toMatchObject({ title: "Bot Chat", end_reason: "compression", listedAs: { id: tip } });
    expect(server.sessions.find((s) => s.id === tip)).toMatchObject({ title: null, hidden: true, unlisted: true, parent_session_id: "bot" });
    expect(server.transcripts[tip].map((m) => m.text)).toEqual(["Plan the VLANs", "Three VLANs: lab, home, guests."]);

    expect((await call("session.list", { title: "Bot Chat", include_hidden: true })).result!.sessions).toMatchObject([{ id: "bot", resolved_id: tip, title: "Bot Chat" }]);
    const bulk = (await call("session.list", { include_hidden: true })).result!.sessions as Record<string, unknown>[];
    expect(bulk.find((s) => s.title === "Bot Chat")).toMatchObject({ id: tip, _lineage_root_id: "bot" });
    expect(bulk.find((s) => s.id === "side")).toMatchObject({ _lineage_root_id: null });
    expect(await listed({ include_hidden: true })).not.toContain("bot");

    await call("prompt.submit", { session_id: runtime, text: "And the guest VLAN?" });
    expect(server.transcripts[tip].at(-1)!.text).toBe("And the guest VLAN?");
    expect(server.transcripts.bot).toHaveLength(2);
  });

  it("rotates a second time from the tip, keeping the first session as the lineage's root", async () => {
    const { server, call } = await connected((s) => (s.compress = "rotate"));
    const runtime = String((await call("session.resume", { session_id: "bot" })).result!.session_id);
    await call("session.compress", { session_id: runtime });
    await call("session.compress", { session_id: runtime });
    const root = server.sessions.find((s) => s.id === "bot")!;
    const tip = root.listedAs!.id!;
    expect(server.sessions.find((s) => s.id === tip)!.parent_session_id).not.toBe("bot");
    expect(server.sessions.filter((s) => s.end_reason === "compression")).toHaveLength(2);
    expect(server.sessions.filter((s) => s.title === "Bot Chat")).toHaveLength(1);
  });

  it("leaves the session as it is when not set to rotate", async () => {
    const { server, call } = await connected();
    const runtime = String((await call("session.resume", { session_id: "bot" })).result!.session_id);
    await call("session.compress", { session_id: runtime });
    expect(server.sessions.map((s) => s.id)).toEqual(["side", "bot"]);
    expect(server.sessions.find((s) => s.id === "bot")!.listedAs).toBeUndefined();
  });
});
