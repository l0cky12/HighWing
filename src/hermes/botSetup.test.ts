// New profile's Skills and Tools (botSetup.ts, ADR 0195) through the real transport against FakeHermes, whose create
// follows `hermes_cli/web_routers/profiles.py` at `f0d94882`: the create carries neither, Hermes seeds its built-in
// skills all on, and each choice is then applied to the new profile alone, one switch or toolset change at a time, and
// read back. All data is synthetic.
import { describe, expect, it } from "vitest";
import { applySkills, applyToolsets, retrySkill, retryToolset, skillOptions, toolsetOptions, type SetupItem, type SkillOption } from "./botSetup";
import { FakeHermes } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
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
    const items = await applySkills(apis, "picky", options, new Set());
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
    const items = await applySkills(apis, "picky", BUILT_IN.map(option), new Set(["arxiv", "hermes-agent"]));
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
    const items = await applySkills(apis, "bare", ["arxiv", "git-helper"].map(option), new Set());
    expect(states(items)).toEqual({ arxiv: "applied", "git-helper": "applied" });
    expect([...(server.skills.disabled.bare ?? [])].sort()).toEqual(["arxiv", "git-helper"]);
    expect((await apis.skills.rows("bare")).find((r) => r.name === "recipes")?.enabled).toBe(true);
  });

  it("says Hermes's words when a switch fails, and Try again judges it as the first apply did", async () => {
    const { server, hermes, apis } = await signedIn((s) => (s.skills.toggleRefusal = { status: 400, detail: "Skill changes are locked on this server." }));
    await hermes.manageProfiles.create({ name: "picky" });
    const items = await applySkills(apis, "picky", BUILT_IN.map(option), new Set(["arxiv", "hermes-agent"]));
    expect(states(items)).toEqual({ arxiv: "applied", "git-helper": "said", "hermes-agent": "applied", recipes: "said" });
    expect(items.find((i) => i.name === "recipes")?.state).toEqual({ kind: "failed", miss: { kind: "said", text: expect.stringContaining("Skill changes are locked on this server.") } });
    server.skills.toggleRefusal = undefined;
    const fixed = await retrySkill(apis, "picky", items.find((i) => i.name === "recipes")!);
    expect(fixed).toMatchObject({ name: "recipes", want: false, state: { kind: "applied" } });
    expect(server.skills.disabled.picky?.has("recipes")).toBe(true);
  });

  it("counts a skill chosen off that the new profile doesn't list as applied, first time and on Try again, without a switch", async () => {
    const { server, hermes, apis } = await signedIn();
    await hermes.manageProfiles.create({ name: "picky" });
    const gone: SetupItem = { area: "skill", name: "weather", label: "weather", want: false, state: { kind: "failed", miss: { kind: "said", text: "x" } } };
    expect(states(await applySkills(apis, "picky", [option("weather")], new Set()))).toEqual({ weather: "applied" });
    expect((await retrySkill(apis, "picky", gone)).state).toEqual({ kind: "applied" });
    expect((await retrySkill(apis, "picky", { ...gone, want: true })).state).toEqual({ kind: "failed", miss: { kind: "missing" } });
    expect(toggles(server)).toEqual([]);
  });

  it("marks every skill unchecked with why when the list can't be read", async () => {
    const { server, hermes, apis } = await signedIn();
    await hermes.manageProfiles.create({ name: "picky" });
    server.skills.routes = false;
    const items = await applySkills(apis, "picky", ["arxiv", "recipes"].map(option), new Set(["arxiv"]));
    expect(items.map((i) => i.state)).toEqual([0, 1].map(() => ({ kind: "failed", miss: { kind: "said", text: expect.stringMatching(/no GET \/api\/skills route/) } })));
  });
});

describe("Tools, set on the new profile and read back", () => {
  it("starts from the profile in use, and changes only the toolsets the new profile has otherwise", async () => {
    const { server, hermes, apis } = await signedIn();
    const options = toolsetOptions(await apis.toolsets.list("default"));
    expect(options.filter((o) => o.on).map((o) => o.name)).toEqual(["web", "terminal", "file", "stt"]);
    await hermes.manageProfiles.create({ name: "writer" });
    const items = await applyToolsets(apis, "writer", options, new Set(["file", "stt", "image_gen"]));
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
    const [item] = (await applyToolsets(apis, "desk", options, on)).filter((i) => i.state.kind !== "applied");
    expect(item).toMatchObject({ name: "computer_use", want: true, state: { kind: "confirm", cautions: [{ kind: "install", keys: ["cua_driver"] }] } });
    expect(server.toolsetWrites).toEqual([]);
    const applied = await retryToolset(apis, "desk", item, item.state.kind === "confirm" ? item.state.cautions : []);
    expect(applied.state).toEqual({ kind: "applied", notes: [{ kind: "installing", keys: "cua_driver" }] });
    expect(server.toolsetWrites).toEqual([{ profile: "desk", name: "computer_use", enabled: true }]);
  });

  it("keeps Hermes's own words when it refuses, and Try again applies it once it takes it", async () => {
    const { server, hermes, apis } = await signedIn((s) => (s.toolsetRefusal = { status: 400, detail: "Toolset changes are locked on this server." }));
    const options = toolsetOptions(await apis.toolsets.list("default"));
    await hermes.manageProfiles.create({ name: "locked" });
    const items = await applyToolsets(apis, "locked", options, new Set(["file", "stt", "terminal"]));
    expect(items.find((i) => i.name === "web")?.state).toEqual({ kind: "failed", miss: { kind: "said", text: "Toolset changes are locked on this server." } });
    server.toolsetRefusal = undefined;
    expect((await retryToolset(apis, "locked", items.find((i) => i.name === "web")!)).state).toEqual({ kind: "applied" });
  });

  it("leaves out a toolset whose name this app doesn't send", () => {
    const options = toolsetOptions({ profile: "default", readAt: 0, toolsets: [{ name: "a/b", label: "Odd", description: "", platform: "cli", platformLabel: "CLI", enabled: true, configured: true, tools: [], configOnly: false }] });
    expect(options).toEqual([{ name: "a/b", label: "Odd", description: "", on: true, changeable: false }]);
  });
});
