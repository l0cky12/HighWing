// New profile's Skills and Tools (botSetup.ts, ADR 0195) through the real transport against FakeHermes, whose create
// follows `hermes_cli/web_routers/profiles.py` at `f0d94882`: the create carries neither, Hermes seeds its built-in
// skills all on, and each choice is then applied to the new profile alone, one switch or toolset change at a time, and
// read back. All data is synthetic.
import { describe, expect, it } from "vitest";
import { applySetup, retryItem, skillOptions, toolsetOptions, type SetupItem, type SkillOption } from "./botSetup";
import { FakeHermes } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { RestError } from "./pipe";
import { connect } from "./transport";

const BUILT_IN = ["arxiv", "git-helper", "hermes-agent", "recipes"];

async function signedIn(setup: (s: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  for (const name of BUILT_IN)
    server.skills.add("default", { dir: `/home/liam/.hermes/skills/${name}`, source: "bundled" }, `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name}.\n`);
  server.skills.add("default", { dir: "/home/liam/.hermes/skills/mine", source: "agent" }, "---\nname: mine\ndescription: Mine\n---\nMine.\n");
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  await hermes.sync();
  return { server, hermes, apis: { skills: hermes.skills, toolsets: hermes.toolsets } };
}

const states = (items: SetupItem[]) => Object.fromEntries(items.map((i) => [i.name, i.state.kind === "failed" ? i.state.miss.kind : i.state.kind]));
const toggles = (server: FakeHermes) => server.restRequests.filter((r) => r.method === "PUT" && r.path === "/api/skills/toggle").map((r) => [r.query.get("profile"), r.body]);
const option = (name: string): SkillOption => ({ name, description: `The ${name} skill`, ...(name === "hermes-agent" && { locked: "essential" as const }) });

describe("Skills, applied to the new profile and read back", () => {
  it("offers only the built-in skills listed for the profile in use, with the one Hermes keeps on locked", async () => {
    const { apis } = await signedIn();
    expect(skillOptions(await apis.skills.rows("default"))).toEqual(BUILT_IN.map(option));
  });

  it("locks a built-in skill whose name this app doesn't send, and never switches it", async () => {
    const { server, hermes, apis } = await signedIn((s) =>
      s.skills.add("default", { dir: "/home/liam/.hermes/skills/odd", source: "bundled" }, "---\nname: a//b\ndescription: Odd\n---\nOdd.\n"),
    );
    const options = skillOptions(await apis.skills.rows("default"));
    expect(options.find((o) => o.name === "a//b")).toEqual({ name: "a//b", description: "Odd", locked: "unsendable" });
    await hermes.manageProfiles.create({ name: "picky" });
    const items = await applySetup(apis, "picky", { skills: { options: options, on: new Set() } });
    expect(items.map((i) => i.name)).toEqual(BUILT_IN);
    expect(toggles(server).map(([, body]) => body)).toEqual([
      { name: "arxiv", enabled: false },
      { name: "git-helper", enabled: false },
      { name: "recipes", enabled: false },
    ]);
  });

  it("turns off only the skills the owner unticked, on the new profile alone, and reads the ticked ones back on", async () => {
    const { server, hermes, apis } = await signedIn();
    await hermes.manageProfiles.create({ name: "picky" });
    const items = await applySetup(apis, "picky", { skills: { options: BUILT_IN.map(option), on: new Set(["arxiv", "hermes-agent"]) } });
    expect(states(items)).toEqual({ arxiv: "applied", "git-helper": "applied", "hermes-agent": "applied", recipes: "applied" });
    expect(toggles(server)).toEqual([
      ["picky", { name: "git-helper", enabled: false }],
      ["picky", { name: "recipes", enabled: false }],
    ]);
    expect([...(server.skills.disabled.picky ?? [])].sort()).toEqual(["git-helper", "recipes"]);
    expect(server.skills.disabled.default ?? new Set()).toEqual(new Set());
  });

  it("never touches a skill the owner wasn't shown, even when none is chosen", async () => {
    const { server, hermes, apis } = await signedIn();
    await hermes.manageProfiles.create({ name: "bare" });
    // `recipes` is seeded in the new profile, but wasn't in the list the owner chose from.
    const items = await applySetup(apis, "bare", { skills: { options: ["arxiv", "git-helper"].map(option), on: new Set() } });
    expect(states(items)).toEqual({ arxiv: "applied", "git-helper": "applied" });
    expect([...(server.skills.disabled.bare ?? [])].sort()).toEqual(["arxiv", "git-helper"]);
    expect((await apis.skills.rows("bare")).find((r) => r.name === "recipes")?.enabled).toBe(true);
  });

  it("says Hermes's words when a switch fails, and Try again judges it as the first apply did", async () => {
    const { server, hermes, apis } = await signedIn((s) => (s.skills.toggleRefusal = { status: 400, detail: "Skill changes are locked on this server." }));
    await hermes.manageProfiles.create({ name: "picky" });
    const items = await applySetup(apis, "picky", { skills: { options: BUILT_IN.map(option), on: new Set(["arxiv", "hermes-agent"]) } });
    expect(states(items)).toEqual({ arxiv: "applied", "git-helper": "said", "hermes-agent": "applied", recipes: "said" });
    expect(items.find((i) => i.name === "recipes")?.state).toEqual({ kind: "failed", miss: { kind: "said", text: expect.stringContaining("Skill changes are locked on this server.") } });
    server.skills.toggleRefusal = undefined;
    const fixed = await retryItem(apis, "picky", items.find((i) => i.name === "recipes")!);
    expect(fixed).toMatchObject({ name: "recipes", want: false, state: { kind: "applied" } });
    expect(server.skills.disabled.picky?.has("recipes")).toBe(true);
  });

  it("counts a skill chosen off that the new profile doesn't list as applied, first time and on Try again, without a switch", async () => {
    const { server, hermes, apis } = await signedIn();
    await hermes.manageProfiles.create({ name: "picky" });
    const gone: SetupItem = { area: "skill", name: "weather", label: "weather", want: false, state: { kind: "failed", miss: { kind: "said", text: "x" } } };
    expect(states(await applySetup(apis, "picky", { skills: { options: [option("weather")], on: new Set() } }))).toEqual({ weather: "applied" });
    expect((await retryItem(apis, "picky", gone)).state).toEqual({ kind: "applied" });
    expect((await retryItem(apis, "picky", { ...gone, want: true })).state).toEqual({ kind: "failed", miss: { kind: "missing" } });
    expect(toggles(server)).toEqual([]);
  });

  it("marks every skill unchecked with why when the list can't be read", async () => {
    const { server, hermes, apis } = await signedIn();
    await hermes.manageProfiles.create({ name: "picky" });
    server.skills.routes = false;
    const items = await applySetup(apis, "picky", { skills: { options: ["arxiv", "recipes"].map(option), on: new Set(["arxiv"]) } });
    expect(items.map((i) => i.state)).toEqual([0, 1].map(() => ({ kind: "failed", miss: { kind: "said", text: expect.stringMatching(/no GET \/api\/skills route/) } })));
  });

  it("only reads back the skill Hermes keeps on, never switching it, first time or on Try again", async () => {
    const { server, hermes, apis } = await signedIn();
    await hermes.manageProfiles.create({ name: "picky" });
    server.skills.disabled.picky = new Set(["hermes-agent"]);
    const [item] = await applySetup(apis, "picky", { skills: { options: [option("hermes-agent")], on: new Set() } });
    expect(item).toMatchObject({ name: "hermes-agent", want: true, state: { kind: "failed", miss: { kind: "readOff" } } });
    expect((await retryItem(apis, "picky", item)).state).toEqual({ kind: "failed", miss: { kind: "readOff" } });
    expect(toggles(server)).toEqual([]);
  });
});

describe("One run over skills and tools", () => {
  it("counts each item judged, from none", async () => {
    const { hermes, apis } = await signedIn();
    const options = toolsetOptions(await apis.toolsets.list("default"));
    await hermes.manageProfiles.create({ name: "counted" });
    const heard: [number, number][] = [];
    const items = await applySetup(apis, "counted", { skills: { options: BUILT_IN.map(option), on: new Set(["arxiv"]) }, toolsets: { options, on: new Set() } }, (done, total) =>
      heard.push([done, total]),
    );
    const total = BUILT_IN.length + options.filter((o) => o.changeable).length;
    expect(items).toHaveLength(total);
    expect(heard).toEqual(Array.from({ length: total + 1 }, (_, n) => [n, total]));
  });

  it("sends nothing more once a skill switch and its read back go unanswered, and Try again still works", async () => {
    const { server, hermes, apis } = await signedIn();
    const options = toolsetOptions(await apis.toolsets.list("default"));
    await hermes.manageProfiles.create({ name: "picky" });
    let down = false;
    server.restTap = (req) => {
      if (req.path === "/api/skills/toggle") down = true;
      if (down) throw new Error("Can't reach the Hermes dashboard: connection reset");
    };
    const before = server.restRequests.length;
    const items = await applySetup(apis, "picky", { skills: { options: BUILT_IN.map(option), on: new Set(["hermes-agent"]) }, toolsets: { options, on: new Set() } });
    expect(server.restRequests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/skills",
      "PUT /api/skills/toggle",
      "GET /api/skills",
    ]);
    expect(items.find((i) => i.name === "arxiv")?.state).toEqual({ kind: "failed", miss: { kind: "said", text: expect.stringMatching(/^Couldn't tell whether arxiv was turned off/) } });
    const rest = items.slice(1);
    expect(rest.every((i) => i.state.kind === "failed" && i.state.miss.kind === "unsent" && /^Couldn't tell whether arxiv/.test(i.state.miss.text))).toBe(true);
    expect(rest.map((i) => i.area)).toContain("toolset");
    server.restTap = undefined;
    expect((await retryItem(apis, "picky", items.find((i) => i.name === "recipes")!)).state).toEqual({ kind: "applied" });
    expect(server.skills.disabled.picky?.has("recipes")).toBe(true);
  });

  it("sends nothing more once a skill switch goes unanswered and the list read after it doesn't show the change", async () => {
    const { server, hermes, apis } = await signedIn();
    const options = toolsetOptions(await apis.toolsets.list("default"));
    await hermes.manageProfiles.create({ name: "picky" });
    // The switch never reaches Hermes; the list read after it does, and shows the skill still on.
    server.restTap = (req) => {
      if (req.path === "/api/skills/toggle") throw new Error("Can't reach the Hermes dashboard: connection reset");
    };
    const before = server.restRequests.length;
    const items = await applySetup(apis, "picky", { skills: { options: BUILT_IN.map(option), on: new Set(["hermes-agent"]) }, toolsets: { options, on: new Set() } });
    expect(server.restRequests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/skills", "PUT /api/skills/toggle", "GET /api/skills", "GET /api/config"]);
    expect(items[0]).toMatchObject({ name: "arxiv", state: { kind: "failed", miss: { kind: "said", text: expect.stringContaining("connection reset") } } });
    expect(items.slice(1).every((i) => i.state.kind === "failed" && i.state.miss.kind === "unsent")).toBe(true);
  });

  it("stops the toolsets once the skills list read gets no answer", async () => {
    const { server, hermes, apis } = await signedIn();
    const options = toolsetOptions(await apis.toolsets.list("default"));
    await hermes.manageProfiles.create({ name: "picky" });
    server.restTap = (req) => {
      if (req.path === "/api/skills") throw new Error("Can't reach the Hermes dashboard: connection reset");
    };
    const before = server.restRequests.length;
    const items = await applySetup(apis, "picky", { skills: { options: BUILT_IN.map(option), on: new Set() }, toolsets: { options, on: new Set() } });
    expect(server.restRequests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/skills"]);
    expect(items.filter((i) => i.area === "toolset").every((i) => i.state.kind === "failed" && i.state.miss.kind === "unsent")).toBe(true);
  });

  it("goes on with the toolsets after a skills list read Hermes answered with an error", async () => {
    const { server, hermes, apis } = await signedIn();
    const options = toolsetOptions(await apis.toolsets.list("default"));
    await hermes.manageProfiles.create({ name: "picky" });
    server.restTap = (req) => {
      if (req.path === "/api/skills") throw new RestError(401, JSON.stringify({ detail: "Session expired." }));
    };
    const items = await applySetup(apis, "picky", { skills: { options: BUILT_IN.map(option), on: new Set() }, toolsets: { options, on: new Set(["file"]) } });
    expect(items.filter((i) => i.area === "skill").every((i) => i.state.kind === "failed" && i.state.miss.kind === "said")).toBe(true);
    expect(server.toolsetWrites.map((w) => w.name)).toEqual(["web", "terminal", "stt"]);
  });

  it("still tries a later toolset after one Hermes refused with a 4xx, or answered with a server error", async () => {
    for (const refuse of [
      (server: FakeHermes) => {
        // The read just before Web's change is turned down.
        let reads = 0;
        server.restTap = (req) => {
          if (req.method === "GET" && req.path === "/api/tools/toolsets" && ++reads === 2) throw new RestError(403, JSON.stringify({ detail: "Not for this sign-in." }));
        };
      },
      (server: FakeHermes) => {
        server.toolsetRefusal = { status: 500, detail: "Internal Server Error" };
      },
    ]) {
      const { server, hermes, apis } = await signedIn();
      const options = toolsetOptions(await apis.toolsets.list("default"));
      await hermes.manageProfiles.create({ name: "writer" });
      refuse(server);
      const items = await applySetup(apis, "writer", { toolsets: { options, on: new Set(["file", "stt"]) } });
      expect(items.find((i) => i.name === "web")?.state).toMatchObject({ kind: "failed", miss: { kind: "said" } });
      expect(server.restRequests.filter((r) => r.method === "PUT" && r.path === "/api/tools/toolsets/terminal")).toHaveLength(1);
    }
  });

  it("stops once a toolset read or change takes longer than its limit, first time and on Try again", async () => {
    const { server, hermes, apis } = await signedIn();
    const options = toolsetOptions(await apis.toolsets.list("default"));
    await hermes.manageProfiles.create({ name: "writer" });
    server.toolsetGateBeforeWrite = new Promise<void>(() => {});
    const limits = { readMs: 1_000, writeMs: 20 };
    const items = await applySetup(apis, "writer", { toolsets: { options, on: new Set(["file", "stt"]) } }, undefined, limits);
    expect(items.find((i) => i.name === "web")?.state).toEqual({ kind: "failed", miss: { kind: "said", text: "Hermes didn't answer the change to Web Search & Scraping within 0 seconds." } });
    expect(items.find((i) => i.name === "terminal")?.state).toMatchObject({ kind: "failed", miss: { kind: "unsent" } });
    server.toolsetListGateOnce = new Promise<void>(() => {});
    const again = await retryItem(apis, "writer", items.find((i) => i.name === "terminal")!, [], { readMs: 20, writeMs: 20 });
    expect(again.state).toEqual({ kind: "failed", miss: { kind: "said", text: "Hermes didn't answer the toolset list within 0 seconds." } });
  });

  it("sends nothing more once Hermes doesn't confirm a toolset change", async () => {
    const { server, hermes, apis } = await signedIn();
    const options = toolsetOptions(await apis.toolsets.list("default"));
    await hermes.manageProfiles.create({ name: "writer" });
    server.dropOnToolsetWrite = "lost";
    const items = await applySetup(apis, "writer", { toolsets: { options, on: new Set(["file", "stt"]) } });
    expect(items.find((i) => i.name === "web")?.state).toEqual({ kind: "failed", miss: { kind: "said", text: expect.stringContaining("connection reset") } });
    expect(items.find((i) => i.name === "terminal")?.state).toEqual({ kind: "failed", miss: { kind: "unsent", text: expect.stringContaining("connection reset") } });
    expect(server.restRequests.filter((r) => r.method === "PUT" && r.path.startsWith("/api/tools/toolsets/")).map((r) => r.path)).toEqual(["/api/tools/toolsets/web"]);
  });
});

describe("Tools, set on the new profile and read back", () => {
  it("starts from the profile in use, and changes only the toolsets the new profile has otherwise", async () => {
    const { server, hermes, apis } = await signedIn();
    const options = toolsetOptions(await apis.toolsets.list("default"));
    expect(options.filter((o) => o.on).map((o) => o.name)).toEqual(["web", "terminal", "file", "stt"]);
    await hermes.manageProfiles.create({ name: "writer" });
    const items = await applySetup(apis, "writer", { toolsets: { options: options, on: new Set(["file", "stt", "image_gen"]) } });
    expect(items.every((i) => i.state.kind === "applied")).toBe(true);
    expect(server.toolsetWrites).toEqual([
      { profile: "writer", name: "web", enabled: false },
      { profile: "writer", name: "terminal", enabled: false },
      { profile: "writer", name: "image_gen", enabled: true },
    ]);
    expect([...server.enabledToolsets("writer")].sort()).toEqual(["file", "image_gen", "stt"]);
    expect([...server.enabledToolsets("default")].sort()).toEqual(["file", "stt", "terminal", "web"]);
  });

  it("never accepts a caution itself: Apply anyway sends it with the owner's yes", async () => {
    const { server, hermes, apis } = await signedIn();
    const options = toolsetOptions(await apis.toolsets.list("default"));
    await hermes.manageProfiles.create({ name: "desk" });
    const on = new Set(["web", "terminal", "file", "stt", "computer_use"]);
    const [item] = (await applySetup(apis, "desk", { toolsets: { options: options, on: on } })).filter((i) => i.state.kind !== "applied");
    expect(item).toMatchObject({ name: "computer_use", want: true, state: { kind: "confirm", cautions: [{ kind: "install", keys: ["cua_driver"] }] } });
    expect(server.toolsetWrites).toEqual([]);
    const applied = await retryItem(apis, "desk", item, item.state.kind === "confirm" ? item.state.cautions : []);
    expect(applied.state).toEqual({ kind: "applied", notes: [{ kind: "installing", keys: "cua_driver" }] });
    expect(server.toolsetWrites).toEqual([{ profile: "desk", name: "computer_use", enabled: true }]);
  });

  it("keeps Hermes's own words when it refuses, and Try again applies it once it takes it", async () => {
    const { server, hermes, apis } = await signedIn((s) => (s.toolsetRefusal = { status: 400, detail: "Toolset changes are locked on this server." }));
    const options = toolsetOptions(await apis.toolsets.list("default"));
    await hermes.manageProfiles.create({ name: "locked" });
    const items = await applySetup(apis, "locked", { toolsets: { options: options, on: new Set(["file", "stt", "terminal"]) } });
    expect(items.find((i) => i.name === "web")?.state).toEqual({ kind: "failed", miss: { kind: "said", text: "Toolset changes are locked on this server." } });
    server.toolsetRefusal = undefined;
    expect((await retryItem(apis, "locked", items.find((i) => i.name === "web")!)).state).toEqual({ kind: "applied" });
  });

  it("leaves out a toolset whose name this app doesn't send", () => {
    const options = toolsetOptions({ profile: "default", readAt: 0, toolsets: [{ name: "a/b", label: "Odd", description: "", platform: "cli", platformLabel: "CLI", enabled: true, configured: true, tools: [], configOnly: false }] });
    expect(options).toEqual([{ name: "a/b", label: "Odd", description: "", on: true, changeable: false }]);
  });
});
