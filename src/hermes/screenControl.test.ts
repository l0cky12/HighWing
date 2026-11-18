// Who holds the screen, as ScreenControl publishes it (ADR 0217), when an answer arrives after the scope it was asked in.
import { describe, expect, it, vi } from "vitest";
import type { DisplayLease, DisplayObserve, DisplayStatus } from "./screen";
import { ScreenControl, type ScreenState } from "./screenControl";

const status: DisplayStatus = {
  supported: true,
  installed: true,
  missing: [],
  running: true,
  profile_key: "/home/lena/.hermes",
  lease: { holder: "agent", viewer_hash: null, since: 1, epoch: 1 },
};

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
  it("sends one acquire for holds asked for while one is on its way, and drops its lease once the profile changed", async () => {
    let profile = "default";
    const connection = {};
    const sent: string[] = [];
    let acquired!: (a: { lease: DisplayLease }) => void;
    const published: (ScreenState | undefined)[] = [];
    const control = new ScreenControl({
      request: async (method) => {
        sent.push(method);
        if (method === "display.lease.acquire") return new Promise((r) => (acquired = r as typeof acquired));
        if (method === "display.observe") return { ...status, ticket: "t", viewer_id: "viewer-1" };
        return status;
      },
      profile: () => profile,
      connection: () => connection,
      publish: (s) => published.push(s),
    });
    await control.status();
    const first = control.hold("Stopped");
    const second = control.hold("Stopped");
    await vi.waitFor(() => expect(sent.filter((m) => m === "display.lease.acquire")).toHaveLength(1));
    profile = "work";
    control.rescope();
    acquired({ lease: { holder: "human", viewer_hash: "0123456789ab", since: 3, epoch: 2 } });
    expect(await first).toEqual({ kind: "held" });
    expect(await second).toEqual({ kind: "held" });
    expect(sent.filter((m) => m === "display.lease.acquire")).toHaveLength(1);
    expect(published.at(-1)).toBeUndefined();
  });
});
