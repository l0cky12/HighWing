import { describe, expect, it } from "vitest";
import { CHAT_POLICY, askRule, chatKind } from "./chatKind";

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
      asks: "named",
    });
  });

  it("keeps a Bot Chat as the one chat of a bot, and a link only to a chat opened by its id", () => {
    const kinds = Object.keys(CHAT_POLICY) as (keyof typeof CHAT_POLICY)[];
    expect(kinds.filter((k) => CHAT_POLICY[k].ofBot)).toEqual(["bot"]);
    expect(kinds.filter((k) => CHAT_POLICY[k].link === CHAT_POLICY[k].ofBot)).toEqual([]);
    expect(kinds.filter((k) => CHAT_POLICY[k].organize)).toEqual(["ordinary", "imported"]);
  });
});

describe("which @handle words ask a bot", () => {
  it("lets a Bot Chat's typed or picked handle ask, an ordinary chat's picked one only, and no other chat's", () => {
    const rules = Object.fromEntries(Object.entries(CHAT_POLICY).map(([kind, p]) => [kind, p.asks]));
    expect(rules).toEqual({ ordinary: "picked", imported: "none", bot: "named", jobRun: "none" });
  });

  it("takes an ordinary chat's asks away in Compare and leaves every other chat's as it is", () => {
    expect(askRule(CHAT_POLICY.ordinary, true)).toBe("none");
    expect(askRule(CHAT_POLICY.ordinary, false)).toBe("picked");
    expect(askRule(CHAT_POLICY.bot, true)).toBe("named");
    expect(askRule(CHAT_POLICY.imported, true)).toBe("none");
  });
});
