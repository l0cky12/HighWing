// A new bot's id against what Hermes's own code answers: profileIdGolden.json is written by tools/profile-id-golden.py,
// which runs `_suggest_profile_name` from the ae2a81cc checkout. The app differs from Hermes only where nothing usable
// is left (`bot`, not my-work) and where Hermes's suggestion is reserved, which the app suffixes.
import { describe, expect, it } from "vitest";
import golden from "./profileIdGolden.json";
import { PROFILE_ID, profileIdFor, RESERVED_PROFILE_NAMES } from "./profiles";

const none: ReadonlySet<string> = new Set();

describe("profileIdFor", () => {
  it("keeps Hermes's id pattern and reserved names", () => {
    expect(PROFILE_ID.source).toBe(golden.pattern);
    expect([...RESERVED_PROFILE_NAMES].sort()).toEqual(golden.reserved);
  });

  it.each(golden.cases.filter((c) => !c.fellBack && !RESERVED_PROFILE_NAMES.has(c.id)))("derives $id from $name as Hermes does", ({ name, id }) => {
    expect(profileIdFor(name, none)).toBe(id);
  });

  it("gives bot wherever Hermes falls back to my-work", () => {
    const fellBack = golden.cases.filter((c) => c.fellBack);
    expect(fellBack.map((c) => c.name)).toContain("日本語");
    for (const { name, id } of fellBack) {
      expect(id).toBe("my-work");
      expect(profileIdFor(name, none)).toBe("bot");
    }
    expect(profileIdFor("My Work", none)).toBe("my-work");
  });

  it("suffixes an id Hermes reserves", () => {
    const reserved = golden.cases.filter((c) => RESERVED_PROFILE_NAMES.has(c.id));
    expect(reserved.map((c) => c.name)).toContain("default");
    for (const { name, id } of reserved) expect(profileIdFor(name, none)).toBe(`${id}-2`);
  });

  it("takes the first free suffix when the id is another profile's", () => {
    expect(profileIdFor("Travel Buddy", new Set(["travel-buddy"]))).toBe("travel-buddy-2");
    expect(profileIdFor("Travel Buddy", new Set(["travel-buddy", "travel-buddy-2", "travel-buddy-3"]))).toBe("travel-buddy-4");
    expect(profileIdFor("日本語", new Set(["bot"]))).toBe("bot-2");
    expect(profileIdFor("Default", new Set(["default-2"]))).toBe("default-3");
  });

  it("cuts a long id so the suffix still fits Hermes's 64 characters", () => {
    const long = "a".repeat(64);
    const taken = new Set([long, ...Array.from({ length: 8 }, (_, i) => `${"a".repeat(62)}-${i + 2}`)]);
    expect(profileIdFor(long, taken)).toBe(`${"a".repeat(61)}-10`);
    const dashed = "x".repeat(63) + " tail";
    const id = profileIdFor(dashed, new Set(["x".repeat(63) + "-"]));
    expect(id).toBe(`${"x".repeat(62)}-2`);
    for (const got of [profileIdFor(long, taken), id]) expect(got).toMatch(PROFILE_ID);
  });
});
