import { describe, expect, it } from "vitest";
import { isBotChatTitle } from "./bots";
import { THREAD_PREFIX, TOPIC_MAX, freeTitle, isThreadTitle, shelfOf, threadTitle, threadTopic, topicFrom, type ThreadTitle } from "./threads";

describe("threadTopic", () => {
  it.each([
    ["Bot Thread: VLAN plan", "VLAN plan"],
    ["Bot Thread:  VLAN plan ", "VLAN plan"],
    ["Bot Thread: VLAN plan (2)", "VLAN plan (2)"],
    ["Bot Thread: Issue #12 follow-up", "Issue #12 follow-up"],
    ["Bot Thread: Bot Chat", "Bot Chat"],
  ])("reads %j as the topic %j", (title, topic) => {
    expect(threadTopic(title)).toBe(topic);
    expect(isThreadTitle(title)).toBe(true);
  });

  it.each([
    ["Bot Chat"],
    ["Bot Chat #2"],
    ["Bot Thread: VLAN plan #2"],
    ["Bot Thread: "],
    ["Bot Thread:    "],
    ["Bot Thread:VLAN plan"],
    ["bot thread: VLAN plan"],
    [" Bot Thread: VLAN plan"],
    ["About Bot Thread: VLAN plan"],
    ["VLAN plan"],
    [""],
    [null],
    [undefined],
    [12],
  ])("doesn't take %j for a thread", (title) => {
    expect(threadTopic(title)).toBeUndefined();
    expect(isThreadTitle(title)).toBe(false);
  });

  it("never agrees with the Bot Chat's recogniser", () => {
    for (const title of ["Bot Chat", " Bot Chat ", "Bot Thread: Bot Chat", "Bot Thread: x", "Bot Chat #2", "x"]) expect(isThreadTitle(title) && isBotChatTitle(title)).toBe(false);
  });
});

describe("threadTitle", () => {
  it("puts the prefix before the topic, on one line with single spaces", () => {
    expect(threadTitle("  VLAN\n plan\t for   the lab ")).toBe("Bot Thread: VLAN plan for the lab");
  });

  it("cuts a long topic to TOPIC_MAX", () => {
    const title = threadTitle("x".repeat(200));
    expect(title).toBe(THREAD_PREFIX + "x".repeat(TOPIC_MAX));
    expect(title.length).toBeLessThanOrEqual(100);
  });

  it("rewrites an ending Hermes would read as a numbered copy, so every title it makes is a thread's", () => {
    expect(threadTitle("Issue #12")).toBe("Bot Thread: Issue 12");
    expect(threadTitle("Release #3 #4")).toBe("Bot Thread: Release #3 4");
    expect(isThreadTitle(threadTitle("Issue #12"))).toBe(true);
  });

  it("refuses a topic with nothing in it", () => {
    expect(() => threadTitle(" \n ")).toThrow("A thread needs a topic.");
  });
});

describe("freeTitle", () => {
  const title = threadTitle("VLAN plan");

  it("keeps a title nothing holds", () => {
    expect(freeTitle(title, ["Bot Chat", "Bot Thread: Backups"])).toBe(title);
  });

  it("takes the first free (n), comparing without case", () => {
    expect(freeTitle(title, ["bot thread: vlan plan"])).toBe("Bot Thread: VLAN plan (2)");
    expect(freeTitle(title, ["Bot Thread: VLAN plan", "Bot Thread: VLAN plan (2)", "Bot Thread: VLAN plan (4)"])).toBe("Bot Thread: VLAN plan (3)");
    expect(isThreadTitle(freeTitle(title, [title]))).toBe(true);
  });
});

describe("topicFrom", () => {
  it("offers the message's first line with words, without its Markdown lead, cut to 48 characters", () => {
    expect(topicFrom("\n\n## The VLAN plan\nSecond line")).toBe("The VLAN plan");
    expect(topicFrom("- " + "word ".repeat(30))).toBe("word ".repeat(9) + "wor");
    expect(topicFrom("Fix issue #7")).toBe("Fix issue 7");
  });

  it("offers nothing for a message without words", () => {
    expect(topicFrom("```\n---\n")).toBe("");
  });
});

describe("shelfOf", () => {
  const row = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, preview: "", started_at: 100, message_count: 1, source: "app", _lineage_root_id: null, ...over });

  it("keeps the threads of the answer, in its order, and drops every other row", () => {
    const shelf = shelfOf(
      {
        sessions: [
          row("t2", "Bot Thread: Backups", { preview: " Nightly\nrun ", started_at: 200, message_count: 4 }),
          row("bot", "Bot Chat"),
          row("copy", "Bot Thread: Backups #2"),
          row("c1", "Disk usage"),
          row("t1", "Bot Thread: VLAN plan", { started_at: 300 }),
        ],
      },
      "ops",
      500,
      9_000,
    );
    expect(shelf).toEqual({
      at: 9_000,
      capped: false,
      threads: [
        { profile: "ops", title: "Bot Thread: Backups", topic: "Backups", rootId: "t2", openId: "t2", preview: "Nightly run", lastActive: 200_000, messageCount: 4 },
        { profile: "ops", title: "Bot Thread: VLAN plan", topic: "VLAN plan", rootId: "t1", openId: "t1", preview: "", lastActive: 300_000, messageCount: 1 },
      ],
    });
  });

  it("reads a compacted thread's first session as its root, and the listed session as the one to open", () => {
    const [thread] = shelfOf({ sessions: [row("tip", "Bot Thread: Backups", { _lineage_root_id: "root", last_active: 500, live_message_count: 7 })] }, "ops", 500, 0).threads;
    expect(thread).toMatchObject({ rootId: "root", openId: "tip", lastActive: 500_000, messageCount: 7 });
    expect(shelfOf({ sessions: [row("root", "Bot Thread: Backups", { resolved_id: "tip" })] }, "ops", 500, 0).threads[0]).toMatchObject({ rootId: "root", openId: "tip" });
  });

  it("keeps two threads whose titles differ only in case, as Hermes does", () => {
    const shelf = shelfOf({ sessions: [row("a", "Bot Thread: VLAN plan"), row("b", "Bot Thread: vlan plan")] }, "ops", 500, 0);
    expect(shelf.threads.map((t) => t.rootId)).toEqual(["a", "b"]);
  });

  it("says the answer filled its window", () => {
    const sessions = [row("a", "Disk usage"), row("b", "Bot Thread: Backups")];
    expect(shelfOf({ sessions }, "ops", 2, 0).capped).toBe(true);
    expect(shelfOf({ sessions }, "ops", 3, 0).capped).toBe(false);
  });

  it("keeps the first of two rows with one title, and skips rows it can't read", () => {
    const shelf = shelfOf({ sessions: [row("a", "Bot Thread: Backups"), row("b", "Bot Thread: Backups"), null, "x", row("", "Bot Thread: No id")] }, "ops", 500, 0);
    expect(shelf.threads.map((t) => t.openId)).toEqual(["a"]);
  });

  it("throws for an answer that isn't a list of sessions", () => {
    for (const bad of [null, {}, { sessions: "none" }, []]) expect(() => shelfOf(bad, "ops", 500, 0)).toThrow("in a way this app doesn't read");
  });

  it("types a recognised title as a ThreadTitle", () => {
    const title: ThreadTitle = shelfOf({ sessions: [row("a", "Bot Thread: Backups")] }, "ops", 500, 0).threads[0].title;
    expect(title).toBe("Bot Thread: Backups");
  });
});
