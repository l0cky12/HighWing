// Who holds the screen, as ScreenControl publishes it (ADR 0217), when an answer arrives after the scope it was asked in.
import { describe, expect, it } from "vitest";
import type { DisplayObserve } from "./screen";
import { ScreenControl, type ScreenState } from "./screenControl";

describe("ScreenControl", () => {
  it("drops an observe answered for the profile left, so its lease never shows on the profile picked", async () => {
    let profile = "default";
    const connection = {};
    let answer!: (seen: DisplayObserve) => void;
    const published: (ScreenState | undefined)[] = [];
    const control = new ScreenControl({
      request: () => new Promise((r) => (answer = r as (seen: DisplayObserve) => void)),
      profile: () => profile,
      connection: () => connection,
      publish: (s) => published.push(s),
    });
    const observing = control.observe();
    profile = "work";
    control.rescope();
    answer({
      supported: true,
      installed: true,
      missing: [],
      running: true,
      profile_key: "/home/lena/.hermes",
      lease: { holder: "human", viewer_hash: "0123456789ab", since: 2, epoch: 1 },
      ticket: "t",
      viewer_id: "viewer-1",
    });
    await observing;
    expect(published.at(-1)).toBeUndefined();
  });
});
