// Set up again's Start fresh as a table of steps (ADR 0231, "Set up again"): what each step's failure leaves in Hermes,
// run over a scripted Hermes. The real transport runs it in botSetupAgain.transport.test.ts.
import { describe, expect, it } from "vitest";
import { FRESH_STEPS, againBusy, currentSetup, runFresh, type FreshIo, type FreshStepName } from "./botSetupAgain";
import type { HermesNow } from "./botSetupCard";
import type { Item } from "./model";

const STARTED = { kind: "waiting", chatId: "new-chat", id: "setup-2" } as const;

/** A Hermes that takes every step, and records the calls. `over`: what a step does instead. */
function scripted(over: Partial<FreshIo> = {}) {
  const calls: string[] = [];
  const said = <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) => (...a: A) => (calls.push(name), fn(...a));
  const io: FreshIo = {
    find: said("find", over.find ?? (async () => ({ chatId: "old-chat" }))),
    unnamed: said("unnamed", over.unnamed ?? (async () => null)),
    leave: said("leave", over.leave ?? (async () => {})),
    archive: said("archive", over.archive ?? (async () => {})),
    titleTaken: said("titleTaken", over.titleTaken ?? (async () => false)),
    unarchive: said("unarchive", over.unarchive ?? (async () => true)),
    retitle: said("retitle", over.retitle ?? (async () => {})),
    clearMemory: said("clearMemory", over.clearMemory ?? (async () => 0)),
    start: said("start", over.start ?? (async () => STARTED)),
  };
  return { io, calls };
}
const fails = (why: string) => async () => Promise.reject(new Error(why));

describe("Start fresh's steps", () => {
  it("run in the ADR's order: leave, archive, check the title, retitle, clear memory, start", async () => {
    expect(FRESH_STEPS.map((s) => s.name)).toEqual(["check", "leave", "archive", "lookup", "retitle", "memory"]);
    const { io, calls } = scripted();
    expect(await runFresh(io)).toEqual({ kind: "fresh", start: STARTED, missed: {}, memoryLeft: 0 });
    expect(calls).toEqual(["find", "leave", "archive", "titleTaken", "retitle", "clearMemory", "start"]);
  });

  for (const busy of ["replying", "waiting"] as const)
    it(`refuses while the Bot Chat is ${busy}, before anything is archived or cleared`, async () => {
      const { io, calls } = scripted({ find: async () => ({ chatId: "old-chat", busy }) });
      expect(await runFresh(io)).toEqual({ kind: "refused", reason: busy });
      expect(calls).toEqual(["find"]);
    });

  it("unarchives the old chat and clears no memory when the title lookup still finds it", async () => {
    const { io, calls } = scripted({ titleTaken: async () => true });
    expect(await runFresh(io)).toEqual({ kind: "titleKept", restored: true });
    expect(calls).toEqual(["find", "leave", "archive", "titleTaken", "unarchive"]);
    const stuck = scripted({ titleTaken: async () => true, unarchive: fails("offline") });
    expect(await runFresh(stuck.io)).toEqual({ kind: "titleKept", restored: false });
  });

  const stops: [FreshStepName, keyof FreshIo, string, string[]][] = [
    ["check", "find", "asItWas", ["find"]],
    ["leave", "leave", "asItWas", ["find", "leave"]],
    ["archive", "archive", "archived", ["find", "leave", "archive", "titleTaken"]],
    ["lookup", "titleTaken", "archived", ["find", "leave", "archive", "titleTaken"]],
    ["start", "start", "noChat", ["find", "leave", "archive", "titleTaken", "retitle", "clearMemory", "start"]],
  ];
  for (const [at, call, left, sent] of stops)
    it(`stops at a failed ${at} with Hermes ${left}, and sends nothing after it`, async () => {
      const { io, calls } = scripted({ [call]: fails("Hermes didn't answer.") });
      expect(await runFresh(io)).toEqual({ kind: "stopped", at, left, why: "Hermes didn't answer." });
      expect(calls).toEqual(sent);
    });

  it("stops at an archive Hermes didn't confirm as it was only while the title lookup still finds the old chat", async () => {
    const kept = scripted({ archive: fails("Couldn't read the chat back."), titleTaken: async () => true });
    expect(await runFresh(kept.io)).toEqual({ kind: "stopped", at: "archive", left: "asItWas", why: "Couldn't read the chat back." });
    expect(kept.calls).toEqual(["find", "leave", "archive", "titleTaken"]);
    const unsure = scripted({ archive: fails("Couldn't read the chat back."), titleTaken: fails("state.db is busy") });
    expect(await runFresh(unsure.io)).toMatchObject({ kind: "stopped", at: "archive", left: "archived" });
    expect(unsure.calls).not.toContain("start");
  });

  it("carries on past a failed retitle and a failed memory clear, since the title is already freed, and says so", async () => {
    const { io, calls } = scripted({ retitle: fails("Title in use."), clearMemory: fails("Memory can't be read.") });
    expect(await runFresh(io)).toEqual({ kind: "fresh", start: STARTED, missed: { retitle: "Title in use.", memory: "Memory can't be read." }, memoryLeft: 0 });
    expect(calls.slice(-2)).toEqual(["clearMemory", "start"]);
  });

  it("reports the memory entries still there", async () => {
    expect(await runFresh(scripted({ clearMemory: async () => 2 }).io)).toMatchObject({ kind: "fresh", memoryLeft: 2 });
  });

  it("a bot with no Bot Chat, as after a Start fresh that stopped: clears memory and starts, with nothing to archive", async () => {
    const { io, calls } = scripted({ find: async () => null });
    expect(await runFresh(io)).toMatchObject({ kind: "fresh" });
    expect(calls).toEqual(["find", "unnamed", "clearMemory", "start"]);
  });

  it("names the old chat an earlier run archived and stopped before naming, before it clears the memory", async () => {
    const named: string[] = [];
    const { io, calls } = scripted({ find: async () => null, unnamed: async () => "old-chat", retitle: async (id) => void named.push(id) });
    expect(await runFresh(io)).toMatchObject({ kind: "fresh", missed: {} });
    expect(calls).toEqual(["find", "unnamed", "retitle", "clearMemory", "start"]);
    expect(named).toEqual(["old-chat"]);
  });

  it("carries on into the new Bot Chat when the old chat an earlier run archived can't be read, as if it were gone", async () => {
    const { io, calls } = scripted({ find: async () => null, unnamed: fails("Hermes didn't answer.") });
    expect(await runFresh(io)).toMatchObject({ kind: "fresh", missed: {} });
    expect(calls).toEqual(["find", "unnamed", "clearMemory", "start"]);
  });
});

describe("a Bot Chat too busy for Set up again", () => {
  const approval: Item = { kind: "approval", id: "q", requestId: "r", command: "rm -rf /tmp/x", description: "", choices: ["once", "deny"], allowSession: true, allowPermanent: true };
  it("is one with a reply running or a Question waiting", () => {
    expect(againBusy(undefined)).toBeUndefined();
    expect(againBusy({ items: [] })).toBeUndefined();
    expect(againBusy({ running: true, items: [] })).toBe("replying");
    expect(againBusy({ running: true, items: [approval] })).toBe("waiting");
    expect(againBusy({ items: [{ ...approval, answer: "once" }] })).toBeUndefined();
  });
});

describe("the current setup in Set up again's brief", () => {
  const now: HermesNow = {
    persona: "You are Travel Buddy.",
    description: "Plans trips.",
    model: "claude-sonnet-4-5",
    color: "#14b8a6",
    memory: ["The owner wants to be called Lena."],
    skills: [
      { name: "find-nearby", enabled: true },
      { name: "rail-europe", enabled: false },
    ],
    toolsets: [
      { name: "web", enabled: true },
      { name: "terminal", enabled: false },
    ],
    models: ["claude-sonnet-4-5"],
    bots: [],
    picture: null,
    pictures: [
      { name: "plane", key: "00000000000000a1" },
      { name: "moon", key: "00000000000000a2" },
    ],
  };

  it("is what Hermes has: persona, description, model, and only what is on", () => {
    expect(currentSetup(now)).toEqual({ persona: "You are Travel Buddy.", description: "Plans trips.", model: "claude-sonnet-4-5", color: "teal", picture: null, skillsOn: ["find-nearby"], toolsetsOn: ["web"] });
  });

  it("names the bot's picture when it is one of the set's, and says only that another one is uploaded", () => {
    expect(currentSetup({ ...now, picture: "00000000000000a2" }).picture).toBe("moon");
    expect(currentSetup({ ...now, picture: "00000000000000ff" }).picture).toBe("uploaded");
    expect(currentSetup(now).picture).toBeNull();
  });

  it("names a colour the brief lists, and keeps any other as Hermes has it", () => {
    expect(currentSetup({ ...now, color: "#123456" }).color).toBe("#123456");
    expect(currentSetup({ ...now, color: null }).color).toBeNull();
  });

  it("lists the MCP servers only where MCP is offered", () => {
    expect(currentSetup({ ...now, mcp: { catalog: ["airbnb"], servers: ["airbnb"] } }).mcp).toEqual(["airbnb"]);
  });
});
