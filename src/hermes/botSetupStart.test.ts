// Starting Bot setup, as decided from stored rows (ADR 0231, "Starting the interview"): one test per row of the ADR's
// table, then the loop over a scripted Hermes that loses answers. The real transport runs it in
// botSetupStart.transport.test.ts.
import { describe, expect, it } from "vitest";
import { botSetupMarker } from "./botSetupBrief";
import { BotSetupStarts, botSetupBegin, runStart, startState, startStep, withSetupLine, type SetupRow, type StartIo, type StartRead } from "./botSetupStart";
import type { Item } from "./model";
import { ConnectionLostError, PromptUnconfirmedError } from "./sessionProtocol";

const ID = "setup-1";
const BRIEF = `${botSetupMarker(ID)}\nThis message comes from the Highwing app.`;
const BEGIN = botSetupBegin(ID);

const rows = (...list: [role: string, text: string, hidden?: boolean][]): SetupRow[] => list.map(([role, text, hidden = false], n) => ({ rowId: n + 1, role, text, hidden }));
const read = (list: SetupRow[], more: Partial<StartRead> = {}): StartRead => ({ chatId: "bot-chat", rows: list, running: false, ...more });
const next = (r: StartRead | null, ask: "start" | "again" = "start") => startStep(startState(r), ask);

describe("what the stored rows say, and what the app does", () => {
  it("no Bot Chat: creates it with the brief seeded", () => {
    expect(startState(null)).toEqual({ at: "noChat" });
    expect(next(null)).toEqual({ do: "create" });
  });

  it("a Bot Chat with no brief row: refuses, since a second Bot Chat can't take the title", () => {
    const chat = read(rows(["user", "Hello"], ["assistant", "Hi."]));
    expect(startState(chat)).toEqual({ at: "noBrief", chatId: "bot-chat" });
    expect(next(chat)).toEqual({ do: "end", with: { kind: "refused", reason: "hasBotChat" } });
  });

  it("brief row, no begin row: sends the begin turn with the brief's id", () => {
    const chat = read(rows(["user", BRIEF, true]));
    expect(startState(chat)).toEqual({ at: "briefed", chatId: "bot-chat", id: ID, hidden: true });
    expect(next(chat)).toEqual({ do: "begin", chatId: "bot-chat", id: ID });
  });

  it("brief row stored where the owner sees it: refuses, and sends no begin turn", () => {
    const chat = read(rows(["user", BRIEF]));
    expect(startState(chat)).toMatchObject({ at: "briefed", hidden: false });
    expect(next(chat)).toEqual({ do: "end", with: { kind: "refused", reason: "notHidden" } });
  });

  it("begin row, the session is running: waits", () => {
    const chat = read(rows(["user", BRIEF, true], ["user", BEGIN, true]), { running: true });
    expect(startState(chat)).toEqual({ at: "running", chatId: "bot-chat", id: ID, beganAt: 2 });
    expect(next(chat)).toEqual({ do: "end", with: { kind: "waiting", chatId: "bot-chat", id: ID } });
    expect(next(chat, "again")).toEqual({ do: "end", with: { kind: "waiting", chatId: "bot-chat", id: ID } });
  });

  it("begin row, no reply after it, not running: says so with Hermes's error, and only the owner sends it again", () => {
    const silent = read(rows(["user", BRIEF, true], ["user", BEGIN, true]));
    expect(startState(silent)).toEqual({ at: "noReply", chatId: "bot-chat", id: ID, beganAt: 2 });
    expect(next(silent)).toEqual({ do: "end", with: { kind: "noReply", chatId: "bot-chat", id: ID } });
    const failed = { ...silent, error: "No API key for openrouter." };
    expect(next(failed)).toEqual({ do: "end", with: { kind: "noReply", chatId: "bot-chat", id: ID, error: "No API key for openrouter." } });
    expect(next(failed, "again")).toEqual({ do: "begin", chatId: "bot-chat", id: ID });
  });

  it("a reply after the begin row: started, whatever else runs", () => {
    const list = rows(["user", BRIEF, true], ["user", BEGIN, true], ["assistant", "I'm Scribe. What should I call you?"], ["user", "Liam"]);
    for (const running of [false, true]) {
      expect(startState(read(list, { running }))).toEqual({ at: "started", chatId: "bot-chat", id: ID, beganAt: 2 });
      expect(next(read(list, { running }), "again")).toEqual({ do: "end", with: { kind: "started", chatId: "bot-chat", id: ID } });
    }
  });

  it("counts a reply only after the newest begin row, and keeps the line at the first", () => {
    const again = rows(["user", BRIEF, true], ["user", BEGIN, true], ["user", BEGIN, true]);
    expect(startState(read(again))).toMatchObject({ at: "noReply", beganAt: 2 });
    expect(startState(read([...again, { rowId: 4, role: "assistant", text: "What should I call you?", hidden: false }]))).toMatchObject({ at: "started", beganAt: 2 });
  });

  it("reads the newest brief: an earlier setup's begin and replies don't start a later one", () => {
    const later = `${botSetupMarker("setup-2")}\nBot setup again.`;
    const list = rows(["user", BRIEF, true], ["user", BEGIN, true], ["assistant", "What should I call you?"], ["user", later, true]);
    expect(startState(read(list))).toEqual({ at: "briefed", chatId: "bot-chat", id: "setup-2", hidden: true });
  });

  it("takes neither the owner's words nor the bot's for a brief or a begin turn", () => {
    expect(startState(read(rows(["assistant", BRIEF])))).toMatchObject({ at: "noBrief" });
    expect(startState(read(rows(["user", BRIEF, true], ["user", `About ${BEGIN}`])))).toMatchObject({ at: "briefed" });
    expect(startState(read(rows(["user", BRIEF, true], ["assistant", BEGIN])))).toEqual({ at: "started", chatId: "bot-chat", id: ID, beganAt: 1 });
  });

  it("a brief sent as a turn, as Keep history sends it, is its own begin: running, then started, and no begin turn follows", () => {
    const kept = rows(["user", "Rome to Florence?"], ["assistant", "The 09:10 is quickest."], ["user", BRIEF, true]);
    expect(startState(read(kept, { running: true }))).toEqual({ at: "running", chatId: "bot-chat", id: ID, beganAt: 3 });
    expect(next(read(kept, { running: true }))).toEqual({ do: "end", with: { kind: "waiting", chatId: "bot-chat", id: ID } });
    const replied = read([...kept, { rowId: 4, role: "assistant", text: "Here's how I'm set up now. What should change?", hidden: false }]);
    expect(startState(replied)).toEqual({ at: "started", chatId: "bot-chat", id: ID, beganAt: 3 });
    expect(next(replied, "again")).toEqual({ do: "end", with: { kind: "started", chatId: "bot-chat", id: ID } });
    expect(next(read(kept))).toEqual({ do: "begin", chatId: "bot-chat", id: ID });
  });
});

describe("the Setup started line", () => {
  const reply: Item = { kind: "assistant", id: "a-0", text: "What should I call you?", rowId: 3 };
  const answer: Item = { kind: "user", id: "u-1", text: "Liam", rowId: 4 };
  const line = { kind: "returned", id: "w", body: "", process: false, setup: { id: ID } };

  it("goes where the begin row falls among the rows shown, and last while the begin turn is going out", () => {
    expect(withSetupLine([reply, answer], { id: ID }, "w", 2)).toEqual([{ ...line, rowId: 2 }, reply, answer]);
    expect(withSetupLine([reply, answer], { id: ID }, "w", 5)).toEqual([reply, answer, { ...line, rowId: 5 }]);
    expect(withSetupLine([reply], { id: ID }, "w")).toEqual([reply, line]);
  });

  it("is one line per setup: shown again, it stays where it is and learns its row", () => {
    const shown = withSetupLine([], { id: ID }, "w");
    expect(withSetupLine([...shown, reply], { id: ID }, "w2", 2)).toEqual([{ ...line, rowId: 2 }, reply]);
  });
});

/** A Hermes of one Bot Chat's stored rows, which loses the answers it is told to. */
function scripted(lose: { create?: "stored" | "lost"; begin?: "stored" | "lost" } = {}) {
  const stored: SetupRow[] = [];
  let chat = false;
  let running = false;
  const sent = { create: 0, begin: 0 };
  const add = (text: string) => stored.push({ rowId: stored.length + 1, role: "user", text, hidden: true });
  const io: StartIo = {
    read: async () => (chat ? { chatId: "bot-chat", rows: [...stored], running } : null),
    create: async (id) => {
      sent.create++;
      const how = lose.create;
      lose.create = undefined;
      if (how !== "lost") {
        chat = true;
        add(`${botSetupMarker(id)}\nBRIEF`);
      }
      if (how) throw new ConnectionLostError("Connection closed");
    },
    begin: async (_chatId, id) => {
      sent.begin++;
      const how = lose.begin;
      lose.begin = undefined;
      if (how !== "lost") {
        add(botSetupBegin(id));
        running = true;
      }
      if (how) throw new PromptUnconfirmedError("Connection closed");
    },
    show: () => {},
    readBack: () => {},
  };
  const kinds = () => stored.map((r) => (r.text.startsWith("[highwing:bot-setup v1") ? "brief" : "begin"));
  return { io, sent, kinds, stop: () => (running = false) };
}

describe("a start, read from the rows after every request", () => {
  it("creates, begins and waits", async () => {
    const h = scripted();
    expect(await runStart(h.io, "start", () => ID)).toEqual({ kind: "waiting", chatId: "bot-chat", id: ID });
    expect(h.kinds()).toEqual(["brief", "begin"]);
  });

  it("settles a create whose answer was lost by reading the rows, never by a second create", async () => {
    const h = scripted({ create: "stored" });
    expect(await runStart(h.io, "start")).toMatchObject({ kind: "waiting" });
    expect(h.sent).toEqual({ create: 1, begin: 1 });
    expect(h.kinds()).toEqual(["brief", "begin"]);
  });

  it("stops when Hermes never got the create, and the next start creates once", async () => {
    const h = scripted({ create: "lost" });
    await expect(runStart(h.io, "start")).rejects.toThrow("no second one was started");
    expect(h.sent.create).toBe(1);
    expect(await runStart(h.io, "start")).toMatchObject({ kind: "waiting" });
    expect(h.kinds()).toEqual(["brief", "begin"]);
  });

  it("settles a begin turn whose answer was lost by reading the rows", async () => {
    const h = scripted({ begin: "stored" });
    expect(await runStart(h.io, "start")).toMatchObject({ kind: "waiting" });
    expect(h.sent.begin).toBe(1);
    expect(h.kinds()).toEqual(["brief", "begin"]);
  });

  it("doesn't send a lost begin turn twice in one start; the next start reads again and sends it with the same id", async () => {
    const h = scripted({ begin: "lost" });
    await expect(runStart(h.io, "start", () => ID)).rejects.toThrow("wasn't sent twice");
    expect(h.kinds()).toEqual(["brief"]);
    expect(await runStart(h.io, "start", () => "another-id")).toEqual({ kind: "waiting", chatId: "bot-chat", id: ID });
    expect(h.kinds()).toEqual(["brief", "begin"]);
  });

  it("sends nothing again for a start already under way, and one more begin turn when the owner asks", async () => {
    const h = scripted();
    await runStart(h.io, "start");
    expect(await runStart(h.io, "start")).toMatchObject({ kind: "waiting" });
    h.stop();
    expect(await runStart(h.io, "start")).toMatchObject({ kind: "noReply" });
    expect(h.sent).toEqual({ create: 1, begin: 1 });
    expect(await runStart(h.io, "again")).toMatchObject({ kind: "waiting" });
    expect(h.sent).toEqual({ create: 1, begin: 2 });
  });

  it("passes on what Hermes refuses", async () => {
    const h = scripted();
    h.io.begin = async () => {
      throw new Error("session busy");
    };
    await expect(runStart(h.io, "start")).rejects.toThrow("session busy");
  });

  it("joins a second start for the same profile while one runs", async () => {
    const h = scripted();
    const starts = new BotSetupStarts();
    const [a, b] = await Promise.all([starts.start("scribe", () => runStart(h.io, "start")), starts.start("scribe", () => runStart(h.io, "start"))]);
    expect(a).toBe(b);
    expect(h.kinds()).toEqual(["brief", "begin"]);
    await starts.start("scribe", () => runStart(h.io, "start"));
    expect(h.sent).toEqual({ create: 1, begin: 1 });
  });
});
