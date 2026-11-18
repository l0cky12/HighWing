import { describe, expect, it } from "vitest";
import { CHAT_POLICY, chatKind, policyOf } from "./chatKind";

describe("chatKind", () => {
  it.each([
    [{ title: "Disk usage", source: "app" }, "ordinary"],
    [{ title: "Old notes", source: "import" }, "imported"],
    [{ title: "Nightly report", source: "cron" }, "jobRun"],
    [{ title: "Bot Chat", source: "app" }, "bot"],
    [{ title: "anything", source: "app", bot: true }, "bot"],
    [{ title: "Bot Chat #2", source: "app" }, "ordinary"],
    [{ title: "Bot Thread: VLAN plan", source: "app" }, "thread"],
    [{ title: "Bot Thread: VLAN plan #2", source: "app" }, "ordinary"],
  ] as const)("takes %j for %s", (chat, kind) => {
    expect(chatKind(chat)).toBe(kind);
  });

  it("lets the thread title decide before the Bot Chat mark and the source", () => {
    expect(chatKind({ title: "Bot Thread: VLAN plan", source: "app", bot: true })).toBe("thread");
    expect(chatKind({ title: "Bot Thread: VLAN plan", source: "cron" })).toBe("thread");
  });
});

describe("CHAT_POLICY", () => {
  it("keeps a thread out of the list, with its bot, deletable and renamed by topic", () => {
    expect(policyOf({ title: "Bot Thread: VLAN plan", source: "app" })).toEqual({
      listed: false,
      inbox: true,
      session: "live",
      replay: true,
      branch: false,
      threadFrom: false,
      organize: false,
      remove: true,
      rename: "topic",
      ofBot: true,
      link: false,
    });
  });

  it("gives a Bot Chat Thread from here, and nothing that would rename or delete it", () => {
    expect(CHAT_POLICY.bot).toEqual({
      listed: false,
      inbox: true,
      session: "live",
      replay: true,
      branch: true,
      threadFrom: true,
      organize: false,
      remove: false,
      rename: "none",
      ofBot: true,
      link: false,
    });
  });

  it("offers Thread from here only in a Bot Chat, and a link only to a chat opened by its id", () => {
    const kinds = Object.keys(CHAT_POLICY) as (keyof typeof CHAT_POLICY)[];
    expect(kinds.filter((k) => CHAT_POLICY[k].threadFrom)).toEqual(["bot"]);
    expect(kinds.filter((k) => CHAT_POLICY[k].ofBot)).toEqual(["bot", "thread"]);
    expect(kinds.filter((k) => CHAT_POLICY[k].link === CHAT_POLICY[k].ofBot)).toEqual([]);
    expect(kinds.filter((k) => CHAT_POLICY[k].organize)).toEqual(["ordinary", "imported"]);
  });
});
