import { describe, expect, it } from "vitest";
import { CHAT_POLICY, chatKind } from "./chatKind";

describe("chatKind", () => {
  it.each([
    [{ title: "Disk usage", source: "app" }, "ordinary"],
    [{ title: "Old notes", source: "import" }, "imported"],
    [{ title: "Nightly report", source: "cron" }, "jobRun"],
    [{ title: "Bot Chat", source: "app" }, "bot"],
    [{ title: "anything", source: "app", bot: true }, "bot"],
    [{ title: "Bot Chat #2", source: "app" }, "ordinary"],
  ] as const)("takes %j for %s", (chat, kind) => {
    expect(chatKind(chat)).toBe(kind);
  });
});

describe("CHAT_POLICY", () => {
  it("gives a Bot Chat Branch from here, and nothing that would rename or delete it", () => {
    expect(CHAT_POLICY.bot).toEqual({
      listed: false,
      inbox: true,
      session: "live",
      replay: true,
      branch: true,
      organize: false,
      remove: false,
      rename: "none",
      ofBot: true,
      link: false,
    });
  });

  it("keeps a Bot Chat as the one chat of a bot, and a link only to a chat opened by its id", () => {
    const kinds = Object.keys(CHAT_POLICY) as (keyof typeof CHAT_POLICY)[];
    expect(kinds.filter((k) => CHAT_POLICY[k].ofBot)).toEqual(["bot"]);
    expect(kinds.filter((k) => CHAT_POLICY[k].link === CHAT_POLICY[k].ofBot)).toEqual([]);
    expect(kinds.filter((k) => CHAT_POLICY[k].organize)).toEqual(["ordinary", "imported"]);
  });
});
