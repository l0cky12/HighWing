// Chat filters against a fake Hermes that searches and lists as the deployed dashboard does (chatFilter.ts, ADR 0106):
// chats older than the list and archived chats are found, every part of a filter must match, and running a filter
// only reads.
import { describe, expect, it } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect } from "./transport";
import { runFilter, toFilter, type ChatFilter, type TagLookup } from "./chatFilter";

/** Two Active chats; one from Telegram, one older than the list's month and one more archived here; and one archived in Hermes. */
async function signedIn() {
  const server = new FakeHermes();
  server.sessions = [
    row("backup", 1, { pinned: true, title: "Nightly backup", model: "claude-opus-5-5" }),
    row("deploy", 2, { pinned: true, title: "Deploy the site", model: "gpt-6.1" }),
    row("nas", 3, { source: "telegram", title: "NAS disks", model: "claude-sonnet-5-5" }),
    row("notes", 4, { title: "Meeting notes" }),
    row("old", 90, { title: "Old backup plan", model: "claude-opus-5-5" }),
    row("gone", 5, { archived: true, title: "Archived backup", model: "claude-opus-5-5" }),
  ];
  server.transcripts = {
    backup: [{ role: "user", text: "Why did the backup fail?" }],
    nas: [{ role: "user", text: "Where does the backup land?" }],
    old: [{ role: "assistant", text: "The backup plan for next year." }],
    gone: [{ role: "user", text: "An archived backup question." }],
  };
  const hermes = await connect(server.openPipe);
  await hermes.sync();
  return { server, hermes };
}

/** Tags this computer keeps: `infra` on backup, nas, old and gone; `home` on nas. */
const tags: TagLookup = {
  exists: (t) => t === "infra" || t === "home",
  of: (c) => ({ backup: ["infra"], nas: ["infra", "home"], old: ["infra"], gone: ["infra"] })[c] ?? [],
};

const ids = async (hermes: Awaited<ReturnType<typeof signedIn>>["hermes"], f: ChatFilter) => (await runFilter(f, hermes, tags)).found.map((c) => c.chatId);
const DAY = 86_400_000;
const day = (daysAgo: number) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

describe("Running a chat filter", () => {
  it("finds a tagged chat older than the list, by listing every chat from Hermes, archived ones too", async () => {
    const { server, hermes } = await signedIn();
    expect(hermes.getSnapshot().chats.map((c) => c.id)).not.toContain("old");
    expect(await ids(hermes, { tags: ["infra"] })).toEqual(["backup", "nas", "gone", "old"]);
    const lists = server.restRequests.filter((r) => r.path === "/api/sessions" && r.query.get("offset") === "0");
    expect(Object.fromEntries(lists.at(-1)!.query)).toMatchObject({ order: "recent", exclude_sources: "cron", limit: "100" });
  });

  it("tells Active from Archived, archived here or in Hermes, with words or without", async () => {
    const { hermes } = await signedIn();
    expect(await ids(hermes, { tags: ["infra"], state: "archived" })).toEqual(["nas", "gone", "old"]);
    expect(await ids(hermes, { tags: ["infra"], state: "active" })).toEqual(["backup"]);
    expect(await ids(hermes, { text: "backup", state: "archived" })).toEqual(["nas", "old", "gone"]);
    expect(await ids(hermes, { text: "backup", state: "active" })).toEqual(["backup"]);
  });

  it("reads a filter saved with a state from before ADR 0202 as the nearest state now", () => {
    expect(toFilter({ tags: ["infra"], state: "settled" })).toEqual({ tags: ["infra"], state: "archived" });
    expect(toFilter({ tags: ["infra"], state: "all" })).toEqual({ tags: ["infra"] });
  });

  it("matches every part: words, tag, source, model, dates and state", async () => {
    const { hermes } = await signedIn();
    expect(await ids(hermes, { text: "backup", tags: ["infra", "home"] })).toEqual(["nas"]);
    expect(await ids(hermes, { text: "backup", sources: ["telegram"] })).toEqual(["nas"]);
    expect(await ids(hermes, { text: "backup", model: "OPUS" })).toEqual(["backup", "old", "gone"]);
    expect(await ids(hermes, { text: "backup", model: "opus", from: day(30) })).toEqual(["backup", "gone"]);
    expect(await ids(hermes, { text: "backup", to: day(60) })).toEqual(["old"]);
    expect(await ids(hermes, { tags: ["infra"], state: "archived" })).toEqual(["nas", "gone", "old"]);
    expect(await ids(hermes, { tags: ["infra"], state: "active" })).toEqual(["backup"]);
    expect(await ids(hermes, { sources: ["app"], from: day(3), to: day(0) })).toEqual(["backup", "deploy"]);
  });

  it("asks Hermes to narrow by source when it can say which, and for its most results when filters are checked here", async () => {
    const { server, hermes } = await signedIn();
    await runFilter({ text: "backup", sources: ["app"] }, hermes, tags);
    await runFilter({ text: "backup", sources: ["other"] }, hermes, tags);
    await runFilter({ text: "backup" }, hermes, tags);
    const searches = server.restRequests.filter((r) => r.path === "/api/sessions/search").map((r) => [r.query.get("sources"), r.query.get("limit")]);
    expect(searches).toEqual([
      // Hermes's canonical local chats are asked for too, and told apart here (see below).
      ["gui,hermes-chat,local", "100"],
      // "Other platforms" is everything Hermes Chat doesn't name, so it is checked here.
      [null, "100"],
      [null, "50"],
    ]);
  });

  it("says when Hermes gave as many as it would, so more may match", async () => {
    const { server, hermes } = await signedIn();
    server.sessions.push(...Array.from({ length: 120 }, (_, i) => row(`s${i}`, 0.1, { title: `Backup run ${i}` })));
    const o = await runFilter({ text: "backup", sources: ["app"] }, hermes, tags);
    expect(o.capped).toBe("search");
    expect(o.found).toHaveLength(100);
    expect((await runFilter({ text: "deploy", sources: ["app"] }, hermes, tags)).capped).toBeUndefined();
  });

  it("counts the chats a model filter can't judge because Hermes recorded no model", async () => {
    const { server, hermes } = await signedIn();
    server.sessions.find((s) => s.id === "nas")!.model = null;
    const o = await runFilter({ tags: ["infra"], model: "sonnet" }, hermes, tags);
    expect(o).toMatchObject({ found: [], noModel: 1 });
  });

  it("matches nothing, and asks Hermes nothing, when a tag it names was deleted", async () => {
    const { server, hermes } = await signedIn();
    const before = server.restRequests.length;
    expect(await runFilter({ tags: ["infra", "deleted"] }, hermes, tags)).toEqual({ found: [], noModel: 0, noSource: 0, missingTags: ["deleted"] });
    expect(await runFilter({ text: "  " }, hermes, tags)).toEqual({ found: [], noModel: 0, noSource: 0, missingTags: [] });
    expect(server.restRequests.length).toBe(before);
  });

  it("tells an Active chat older than the list from an Archived one, with words or without", async () => {
    const { server, hermes } = await signedIn();
    server.sessions.push(row("pinnedOld", 90, { pinned: true, title: "Old pinned backup" }), row("pinnedGone", 90, { pinned: true, archived: true, title: "Archived pinned backup" }));
    server.transcripts.pinnedOld = [{ role: "user", text: "A backup from long ago." }];
    server.transcripts.pinnedGone = [{ role: "user", text: "An archived backup from long ago." }];
    // The list holds the past month, so it doesn't have either.
    await hermes.sync();
    expect(hermes.getSnapshot().chats.map((c) => c.id)).not.toContain("pinnedOld");
    expect(await ids(hermes, { text: "backup", state: "active" })).toEqual(["backup", "pinnedOld"]);
    expect(await ids(hermes, { text: "backup", state: "archived" })).toEqual(["nas", "old", "gone", "pinnedGone"]);
    expect(await ids(hermes, { state: "active", from: day(100), to: day(80) })).toEqual(["pinnedOld"]);
    const found = (await runFilter({ text: "archived backup" }, hermes, tags)).found;
    expect(found.find((c) => c.chatId === "pinnedGone")).toMatchObject({ archived: true, settled: false });
  });

  it("matches Hermes's canonical local chats by the app that started them, and says when a search can't tell", async () => {
    const { server, hermes } = await signedIn();
    server.sessions.push(
      row("tui", 1, { source: "local", created_source: "tui", title: "Terminal backup check" }),
      row("unstamped", 1, { source: "local", created_source: "unknown", title: "Unstamped backup" }),
    );
    server.transcripts.tui = [{ role: "user", text: "Check the backup from the terminal." }];
    // List rows name the starting app, so a filter without words places them.
    expect(await ids(hermes, { sources: ["cli"] })).toEqual(["tui"]);
    // An unstamped local chat isn't counted as some other platform either.
    expect(await ids(hermes, { sources: ["other"] })).toEqual([]);
    const listed = await runFilter({ sources: ["cli"] }, hermes, tags);
    expect(listed.noSource).toBe(1);
    // Search rows don't, so a local match can't be placed and is counted instead.
    const searched = await runFilter({ text: "terminal", sources: ["cli"] }, hermes, tags);
    expect(searched).toMatchObject({ found: [], noSource: 1 });
  });

  it("only reads: no chat is marked read, archived or added to the list", async () => {
    const { server, hermes } = await signedIn();
    const chats = hermes.getSnapshot().chats;
    const ws = server.requests.length;
    await runFilter({ tags: ["infra"] }, hermes, tags);
    await runFilter({ text: "backup", model: "opus" }, hermes, tags);
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
    // Nothing is read over /api/ws: the roster that names the Bot Chats a filter leaves out was read on connecting (ADR 0066).
    expect(server.requests.slice(ws).map((r) => r.method)).toEqual([]);
    expect(hermes.getSnapshot().chats).toBe(chats);
  });

  it("searches the profile on screen, and refuses an answer that lands after a switch", async () => {
    const { server, hermes } = await signedIn();
    server.otherProfiles = { work: [row("w1", 1, { title: "Work backup", model: "gpt-6.1" })] };
    await hermes.switchProfile("work");
    expect(await ids(hermes, { model: "gpt" })).toEqual(["w1"]);
    const slow = runFilter({ model: "gpt" }, hermes, tags);
    await hermes.switchProfile("default");
    await expect(slow).rejects.toThrow("Switched to the default profile");
  });
});
