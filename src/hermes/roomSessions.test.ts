import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, readRow, row } from "./fakeHermes";
import { inboxEntries } from "./inbox";
import { RestError } from "./pipe";
import { connect, type Hermes } from "./transport";

const nowS = () => Date.now() / 1000;

async function signedIn() {
  const server = new FakeHermes();
  server.sessions = [readRow("home-1", 1)];
  server.otherProfiles = { ada: [readRow("ada-1", 1)], bram: [readRow("bram-1", 1)] };
  const hermes = await connect(server.openPipe, undefined);
  await hermes.sync();
  return { server, hermes };
}

const liveIds = (hermes: Hermes) => hermes.getSnapshot().live?.sessions.map((s) => s.chatId) ?? [];

const inbox = (hermes: Hermes) => {
  const s = hermes.getSnapshot();
  return inboxEntries({ profile: s.profile, chats: s.chats, connected: s.status === "connected", others: s.others, live: s.live });
};

async function nextCheck(hermes: Hermes) {
  await vi.advanceTimersByTimeAsync(20_000);
  await hermes.checkOtherProfiles();
}

afterEach(() => vi.useRealTimers());

describe("a Group room seat's session", () => {
  it("is left out of live work by the source Hermes stores, and a chat the owner titled Group: x is kept", async () => {
    const { server, hermes } = await signedIn();
    const seat = server.seatSession("ada", "r1", "The quokka census is done.");
    server.otherProfiles.bram.push(row("owner-x", 0, { title: "Group: x", source: "hermes-chat" }));
    server.liveSessions.push({ id: "rt-x", session_key: "owner-x", status: "working", last_active: nowS(), title: "Group: x" });
    await hermes.checkOtherProfiles();

    expect(liveIds(hermes)).toEqual(["owner-x"]);
    expect(hermes.getSnapshot().live?.sessions[0]).toMatchObject({ profile: "bram", title: "Group: x", source: "app" });
    expect(server.store("ada")!.find((r) => r.id === seat)).toMatchObject({ source: "bot_room", hidden: true, title: "Group: r1" });
  });

  it("drops a seat whose title isn't Group: once its lookup says bot_room", async () => {
    const { server, hermes } = await signedIn();
    const seat = server.seatSession("ada", "r1", "Hello.");
    server.store("ada")!.find((r) => r.id === seat)!.title = "Renamed";
    server.liveSessions = server.liveSessions.map((l) => ({ ...l, title: "Renamed" }));
    await hermes.checkOtherProfiles();

    expect(liveIds(hermes)).toEqual([]);
  });

  it("holds a row titled Group: until its lookup has run, then shows it when the stored source isn't bot_room", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    server.otherProfiles.bram.push(row("owner-x", 0, { title: "Group: x", source: "hermes-chat" }));
    server.liveSessions.push({ id: "rt-x", session_key: "owner-x", status: "working", last_active: nowS(), title: "Group: x" });
    const lookup = server.rest["GET /api/sessions/owner-x"];
    server.rest["GET /api/sessions/owner-x"] = () => {
      throw new RestError(503, "busy");
    };
    await hermes.checkOtherProfiles();
    expect(liveIds(hermes)).toEqual([]);

    if (lookup) server.rest["GET /api/sessions/owner-x"] = lookup;
    else delete server.rest["GET /api/sessions/owner-x"];
    await nextCheck(hermes);
    expect(liveIds(hermes)).toEqual(["owner-x"]);
  });

  it("never shows, when more seats are live than one check looks up", async () => {
    vi.useFakeTimers();
    const { server, hermes } = await signedIn();
    for (const [profile, room] of [["ada", "r1"], ["bram", "r1"], ["ada", "r2"], ["bram", "r2"]]) server.seatSession(profile, room, "Hello.");
    server.otherProfiles.bram.push(readRow("bram-busy", 0, { title: "Plain work" }));
    server.liveSessions.push({ id: "rt-b", session_key: "bram-busy", status: "working", last_active: nowS(), title: "Plain work" });
    const lookups = () => new Set(server.restRequests.filter((r) => r.path.startsWith("/api/sessions/seat-")).map((r) => r.path)).size;

    await hermes.checkOtherProfiles();
    expect(lookups()).toBe(3);
    expect(liveIds(hermes)).toEqual(["bram-busy"]);

    await nextCheck(hermes);
    await nextCheck(hermes);
    expect(liveIds(hermes)).toEqual(["bram-busy"]);
    expect(hermes.getSnapshot().live?.sessions[0]).toMatchObject({ profile: "bram" });
  });

  it("reaches no inbox entry, working or waiting", async () => {
    const { server, hermes } = await signedIn();
    server.seatSession("ada", "r1", "Hello.");
    server.seatSession("bram", "r1", "Hello.");
    server.liveSessions[1].status = "waiting";
    await hermes.checkOtherProfiles();

    const { entries, unmatched } = inbox(hermes);
    expect(entries.filter((e) => e.kind === "running" || e.kind === "approval")).toEqual([]);
    expect(unmatched).toBe(0);
  });

  it("is left out of search, which Hermes doesn't filter for hidden sessions", async () => {
    const { server, hermes } = await signedIn();
    server.seatSession("default", "r1", "The quokka census is done.");
    server.sessions.push(row("owner-x", 0, { title: "Group: x", source: "hermes-chat" }));
    server.storeMessage("owner-x", { role: "user", text: "Count the quokka too." });

    const raw = server.restRequests.length;
    expect((await hermes.searchIn("default", "quokka")).hits.map((h) => h.chatId)).toEqual(["owner-x"]);
    expect((await hermes.search("quokka")).map((f) => f.chatId)).toEqual(["owner-x"]);
    expect(server.restRequests.slice(raw).some((r) => r.path === "/api/sessions/search")).toBe(true);
  });
});
