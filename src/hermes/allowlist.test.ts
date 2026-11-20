// Settings → Approvals' data layer against the fake dashboard: the list read, and Remove's check, write and read back.
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { RestError } from "./pipe";
import { sameEntries, without } from "./allowlist";
import { connect } from "./transport";

async function setup(list: unknown = ["git force push", "recursive delete"]) {
  const server = new FakeHermes();
  server.commandAllowlist.work = list;
  server.otherProfiles.work = [];
  const hermes = await connect(server.openPipe, "default");
  server.restRequests.length = 0;
  return { server, api: hermes.allowlist };
}

/** Each config call since `setup`, as `METHOD path?query` and its body. */
const calls = (server: FakeHermes) => server.restRequests.filter((r) => r.path === "/api/config").map((r) => [`${r.method} ${r.path}?${r.query}`, r.body]);

/** Runs `then` against the fake when the `n`th call to `METHOD /api/config` arrives, before Hermes handles it. */
function onCall(server: FakeHermes, method: string, n: number, then: () => void) {
  let seen = 0;
  server.restTap = (req) => {
    if (req.method === method && req.path === "/api/config" && ++seen === n) then();
  };
}

describe("Reading what Hermes always allows", () => {
  it("reads the profile's list from its config", async () => {
    const { server, api } = await setup();
    expect(await api.list("work")).toEqual({ kind: "list", entries: ["git force push", "recursive delete"] });
    expect(calls(server)).toEqual([["GET /api/config?profile=work", undefined]]);
  });

  it("reads no list as an empty one, as Hermes does", async () => {
    const { api } = await setup(null);
    expect(await api.list("work")).toEqual({ kind: "list", entries: [] });
    expect(await api.list("default")).toEqual({ kind: "list", entries: [] });
  });

  it("says why when Hermes ignores the list or reads it only from an old form", async () => {
    for (const [raw, why] of [
      [["a", 1], "it has an item that isn't text, so Hermes ignores the whole list"],
      ["['a']", "it's written as text in an old form, not as a list"],
      [{ a: true }, "it isn't a list, so Hermes ignores it"],
    ] as const) {
      const { api } = await setup(raw);
      expect(await api.list("work")).toEqual({ kind: "unreadable", why });
    }
  });
});

describe("Removing an entry", () => {
  it("checks the list, writes it without the entry, and reads it back", async () => {
    const { server, api } = await setup();
    const out = await api.remove("work", ["git force push", "recursive delete"], "recursive delete");
    expect(out).toEqual({ kind: "removed", now: { kind: "list", entries: ["git force push"] } });
    expect(calls(server)).toEqual([
      ["GET /api/config?profile=work", undefined],
      ["PUT /api/config?profile=work", { config: { command_allowlist: ["git force push"] } }],
      ["GET /api/config?profile=work", undefined],
    ]);
    expect(server.commandAllowlist.work).toEqual(["git force push"]);
  });

  it("writes an empty list when the last entry goes, which replaces the stored one", async () => {
    const { server, api } = await setup(["recursive delete"]);
    expect((await api.remove("work", ["recursive delete"], "recursive delete")).kind).toBe("removed");
    expect(server.commandAllowlist.work).toEqual([]);
  });

  it("sends nothing when the list changed since it was shown", async () => {
    const { server, api } = await setup();
    server.commandAllowlist.work = ["git force push", "recursive delete", "kill a process"];
    const out = await api.remove("work", ["git force push", "recursive delete"], "recursive delete");
    expect(out).toEqual({ kind: "changed", now: { kind: "list", entries: ["git force push", "recursive delete", "kill a process"] } });
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("counts the same entries in another order as unchanged, since Hermes keeps a set and saves it sorted", async () => {
    const { api } = await setup();
    expect((await api.remove("work", ["recursive delete", "git force push"], "git force push")).kind).toBe("removed");
  });

  it("sends nothing when the list became unreadable", async () => {
    const { server, api } = await setup();
    server.commandAllowlist.work = "oops";
    expect((await api.remove("work", ["git force push", "recursive delete"], "recursive delete")).kind).toBe("changed");
    expect(server.commandAllowlist.work).toBe("oops");
  });

  it("names what another client added after the write", async () => {
    const { server, api } = await setup();
    onCall(server, "GET", 2, () => (server.commandAllowlist.work = ["git force push", "kill a process"]));
    const out = await api.remove("work", ["git force push", "recursive delete"], "recursive delete");
    expect(out).toEqual({ kind: "differs", now: { kind: "list", entries: ["git force push", "kill a process"] }, back: false, added: ["kill a process"], gone: [], writeError: undefined });
  });

  it("says when the entry is back after the write", async () => {
    const { server, api } = await setup();
    onCall(server, "GET", 2, () => (server.commandAllowlist.work = ["git force push", "recursive delete"]));
    const out = await api.remove("work", ["git force push", "recursive delete"], "recursive delete");
    expect(out).toMatchObject({ kind: "differs", back: true, added: [], gone: [] });
  });

  it("loses an entry another client adds between the check and the write, which no read can tell", async () => {
    // The risk that remains without a conditional write (ADR 0242): the list sent overwrites the new grant, and the read
    // back matches what was sent. Hermes then asks again before that command, the safe way to fail.
    const { server, api } = await setup();
    onCall(server, "PUT", 1, () => (server.commandAllowlist.work = ["git force push", "kill a process", "recursive delete"]));
    const out = await api.remove("work", ["git force push", "recursive delete"], "recursive delete");
    expect(out).toEqual({ kind: "removed", now: { kind: "list", entries: ["git force push"] }, writeError: undefined });
  });

  it("puts back an entry another client removes between the check and the write, which no read can tell", async () => {
    // The other side of that risk (ADR 0242): the list sent still has the entry the other client revoked, so the write
    // allows it again and the read back matches what was sent.
    const { server, api } = await setup();
    onCall(server, "PUT", 1, () => (server.commandAllowlist.work = ["recursive delete"]));
    const out = await api.remove("work", ["git force push", "recursive delete"], "recursive delete");
    expect(out).toEqual({ kind: "removed", now: { kind: "list", entries: ["git force push"] }, writeError: undefined });
  });

  it("stops at a refusal, and says what Hermes holds", async () => {
    const { server, api } = await setup();
    onCall(server, "PUT", 1, () => {
      throw new RestError(403, '{"detail":"command_allowlist is pinned by an administrator"}');
    });
    const out = await api.remove("work", ["git force push", "recursive delete"], "recursive delete");
    expect(out).toEqual({ kind: "refused", why: "command_allowlist is pinned by an administrator", now: { kind: "list", entries: ["git force push", "recursive delete"] } });
  });

  it("lets the read decide a write whose answer was an error", async () => {
    const { server, api } = await setup();
    onCall(server, "PUT", 1, () => {
      throw new RestError(500, '{"detail":"Internal server error"}');
    });
    const out = await api.remove("work", ["git force push", "recursive delete"], "recursive delete");
    expect(out).toMatchObject({ kind: "differs", back: true, writeError: expect.stringContaining("500") });
  });

  it("says nothing is known when the write and the read after it both fail", async () => {
    const { server, api } = await setup();
    let puts = 0;
    server.restTap = (req) => {
      if (req.method === "PUT") puts++;
      if (puts > 0) throw new Error("connection reset");
    };
    expect(await api.remove("work", ["git force push", "recursive delete"], "recursive delete")).toEqual({ kind: "unknown", why: "connection reset" });
  });

  it("runs one Remove at a time, so the second is checked against what the first wrote", async () => {
    const { server, api } = await setup();
    const shown = ["git force push", "recursive delete"];
    const [a, b] = await Promise.all([api.remove("work", shown, "recursive delete"), api.remove("work", shown, "git force push")]);
    expect(a.kind).toBe("removed");
    expect(b).toEqual({ kind: "changed", now: { kind: "list", entries: ["git force push"] } });
    expect(server.commandAllowlist.work).toEqual(["git force push"]);
  });
});

describe("List helpers", () => {
  it("drops every copy of the entry and keeps the rest in order", () => {
    expect(without(["b", "a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("compares lists as sets", () => {
    expect(sameEntries(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameEntries(["a", "a"], ["a"])).toBe(true);
    expect(sameEntries(["a"], ["a", "b"])).toBe(false);
  });
});
