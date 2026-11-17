// New profile's Skills and Tools (botSetup.ts, ADR 0195) through the real transport against FakeHermes, whose create
// follows `hermes_cli/web_routers/profiles.py` at `f0d94882`: keep_skills and no_skills in the create, best-effort, then
// each choice read back from the new profile and its toolsets set one at a time. All data is synthetic.
import { describe, expect, it } from "vitest";
import {
  applyToolsets,
  checkSkills,
  createFields,
  retrySkill,
  retryToolset,
  skillOptions,
  toolsetOptions,
  type SetupItem,
} from "./botSetup";
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
const createBody = (server: FakeHermes) => server.restRequests.find((r) => r.method === "POST" && r.path === "/api/profiles")?.body;

describe("What a create carries for the owner's choice", () => {
  it("adds nothing for Hermes's defaults, the kept skills sorted, or none at all", () => {
    expect(createFields({ skills: { kind: "defaults" }, toolsets: { kind: "chosen", on: new Set(["web"]) } })).toEqual({});
    expect(createFields({ skills: { kind: "chosen", on: new Set(["recipes", "arxiv"]) }, toolsets: { kind: "defaults" } })).toEqual({ keepSkills: ["arxiv", "recipes"] });
    expect(createFields({ skills: { kind: "chosen", on: new Set() }, toolsets: { kind: "defaults" } })).toEqual({ noSkills: true });
  });

  it("sends a defaults create exactly as before, and keep_skills or no_skills when chosen", async () => {
    const { server, hermes } = await signedIn();
    await hermes.manageProfiles.create({ name: "plain", soul: "You are terse." });
    expect(createBody(server)).toEqual({ name: "plain", soul: "You are terse." });
    server.restRequests.length = 0;
    expect(await hermes.manageProfiles.create({ name: "picky", keepSkills: ["arxiv", "hermes-agent"] })).toEqual({ name: "picky", answered: true, modelSet: true, skillsDisabled: 2 });
    expect(createBody(server)).toEqual({ name: "picky", keep_skills: ["arxiv", "hermes-agent"] });
    server.restRequests.length = 0;
    await hermes.manageProfiles.create({ name: "bare", noSkills: true });
    expect(createBody(server)).toEqual({ name: "bare", no_skills: true });
    expect(server.skills.folders.bare ?? []).toEqual([]);
  });

  it("never sends both", async () => {
    const { server, hermes } = await signedIn();
    await expect(hermes.manageProfiles.create({ name: "both", keepSkills: ["arxiv"], noSkills: true })).rejects.toMatchObject({ failure: { kind: "unsent" } });
    expect(createBody(server)).toBeUndefined();
  });
});

describe("Skills, read back from the new profile", () => {
  it("offers only the built-in skills listed for the profile in use, with the one Hermes keeps on marked", async () => {
    const { apis } = await signedIn();
    expect(skillOptions(await apis.skills.rows("default"))).toEqual(BUILT_IN.map((name) => ({ name, description: `The ${name} skill`, essential: name === "hermes-agent" })));
  });

  it("finds each chosen skill on and each other one off", async () => {
    const { hermes, apis } = await signedIn();
    const on = new Set(["arxiv", "hermes-agent"]);
    await hermes.manageProfiles.create({ name: "picky", ...createFields({ skills: { kind: "chosen", on }, toolsets: { kind: "defaults" } }) });
    expect(states(await checkSkills(apis, "picky", BUILT_IN, on))).toEqual({ arxiv: "applied", "git-helper": "applied", "hermes-agent": "applied", recipes: "applied" });
  });

  it("names each skill Hermes didn't turn off, and Try again turns it off and reads it back", async () => {
    const { server, hermes, apis } = await signedIn((s) => (s.profileKeepSkillsFails = true));
    const on = new Set(["arxiv", "hermes-agent"]);
    const made = await hermes.manageProfiles.create({ name: "picky", keepSkills: [...on] });
    expect(made.skillsDisabled).toBe(0);
    const items = await checkSkills(apis, "picky", BUILT_IN, on);
    expect(states(items)).toEqual({ arxiv: "applied", "git-helper": "readOn", "hermes-agent": "applied", recipes: "readOn" });
    const fixed = await retrySkill(apis, "picky", items.find((i) => i.name === "recipes")!);
    expect(fixed.state).toEqual({ kind: "applied" });
    expect(server.skills.disabled.picky?.has("recipes")).toBe(true);
  });

  it("marks every skill unchecked with why when the list can't be read", async () => {
    const { server, hermes, apis } = await signedIn();
    await hermes.manageProfiles.create({ name: "picky", keepSkills: ["arxiv"] });
    server.skills.routes = false;
    const items = await checkSkills(apis, "picky", ["arxiv", "recipes"], new Set(["arxiv"]));
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
    expect(applied.state).toEqual({ kind: "applied" });
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
