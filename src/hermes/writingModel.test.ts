import { describe, expect, it } from "vitest";
import { FakeHermes, fakeModelConfig, row } from "./fakeHermes";
import { RestError } from "./pipe";
import { connect } from "./transport";
import { WritingFailed, writingRoute, type WritingFacts, type WritingKind, type WritingPick, type WritingRoute } from "./writingModel";

const main = { provider: "openai-codex", model: "gpt-6.1-sol" };
const textPin = { provider: "openrouter", model: "z-ai/glm-5.3-flash" };
const instructionsPin = { provider: "nous", model: "hermes-5-70b" };
const pick: WritingPick = { provider: "openrouter", model: "deepseek/deepseek-v4-flash" };

describe("writingRoute", () => {
  it.each<[string, WritingFacts, WritingKind, WritingPick | undefined, WritingRoute]>([
    ["a Text generation pin wins over the Writing model", { main, text: textPin }, "persona", pick, { via: "pin", pin: "text", ...textPin }],
    ["the Writing model wins over the bot's own model", { main }, "persona", pick, { via: "app", ...pick }],
    ["with neither, the bot writes with its own model", { main }, "persona", undefined, { via: "main", ...main }],
    ["a Project instructions pin wins for instructions", { main, text: textPin, instructions: instructionsPin }, "instructions", pick, { via: "pin", pin: "instructions", ...instructionsPin }],
    ["a Project instructions pin doesn't write personas", { main, instructions: instructionsPin }, "persona", pick, { via: "app", ...pick }],
    ["instructions fall back to the Text generation pin", { main, text: textPin }, "instructions", pick, { via: "pin", pin: "text", ...textPin }],
    ["instructions with no pin use the Writing model", { main }, "instructions", pick, { via: "app", ...pick }],
    ["a bot with no main model and no setting has nothing to write with", { main: { provider: "", model: "" } }, "persona", undefined, { via: "main", provider: "", model: "" }],
  ])("%s", (_, facts, kind, p, route) => expect(writingRoute(facts, kind, p)).toEqual(route));

  it("never lets a stale mirror decide", () => {
    const mirror = { provider: "nous", model: "hermes-5-405b", baseUrl: "" };
    expect(writingRoute({ main, mirror }, "persona", undefined)).toEqual({ via: "main", ...main });
  });
});

async function twoBots(o: { pick?: WritingPick } = {}) {
  const server = new FakeHermes();
  const wazuh = fakeModelConfig();
  wazuh.model = { provider: "openai-codex", default: "gpt-6.1-sol" };
  wazuh.auxiliary.title_generation = { provider: "auto", model: "" };
  server.profileModelConfigs.set("wazuh", wazuh);
  const hermes = await connect(server.openPipe, "default");
  let pick = o.pick;
  const desk = hermes.writingDesk(() => pick);
  const call = { instructions: "Write a persona.", input: "<notes>calm</notes>", maxTokens: 400 };
  const puts = () => server.configWrites.filter((w) => w.profile === "wazuh");
  return { server, hermes, desk, call, puts, setPick: (p?: WritingPick) => (pick = p) };
}

const MIRROR_BLOCK = { reasoning_effort: "", base_url: "", api_key: "", api: "", key_env: "", api_key_env: "", api_mode: "" };

describe("A writing call on the fake server", () => {
  it("copies the Writing model into an unpinned bot once, and runs on it", async () => {
    const { server, desk, call, puts } = await twoBots({ pick });
    const writer = desk.writer("wazuh", "persona");
    expect(await writer.ask(call)).toEqual({ text: "A new title", route: { via: "app", ...pick } });
    expect(puts()).toEqual([{ profile: "wazuh", config: { auxiliary: { highwing_writing: { provider: pick.provider, model: pick.model, ...MIRROR_BLOCK } } } }]);
    expect(server.oneshotCalls).toEqual([{ profile: "wazuh", task: "highwing_writing", model: pick.model }]);

    await writer.ask(call);
    expect(puts()).toHaveLength(1);
    expect(server.oneshotCalls[1]).toEqual({ profile: "wazuh", task: "highwing_writing", model: pick.model });
  });

  it("writes once more when the Writing model changes, and runs on the new one", async () => {
    const { server, desk, call, puts, setPick } = await twoBots({ pick });
    await desk.writer("wazuh", "persona").ask(call);
    setPick({ provider: "nous", model: "hermes-5-70b" });
    expect((await desk.writer("wazuh", "persona").ask(call)).route).toEqual({ via: "app", provider: "nous", model: "hermes-5-70b" });
    expect(puts()).toHaveLength(2);
    expect(server.oneshotCalls.at(-1)).toEqual({ profile: "wazuh", task: "highwing_writing", model: "hermes-5-70b" });
  });

  it("runs a bot pinned on the server on its pin, writing nothing", async () => {
    const { server, desk, call } = await twoBots({ pick });
    expect((await desk.writer("default", "persona").ask(call)).route).toEqual({ via: "pin", pin: "text", provider: "openrouter", model: "deepseek/deepseek-v4-flash" });
    expect(server.configWrites).toEqual([]);
    expect(server.oneshotCalls).toEqual([{ profile: "default", task: "title_generation", model: "deepseek/deepseek-v4-flash" }]);
  });

  it("runs on the bot's own model, writing nothing, with no Writing model set", async () => {
    const { server, desk, call } = await twoBots();
    expect((await desk.writer("wazuh", "persona").ask(call)).route).toEqual({ via: "main", provider: "openai-codex", model: "gpt-6.1-sol" });
    expect(server.configWrites).toEqual([]);
    expect(server.oneshotCalls).toEqual([{ profile: "wazuh", task: "title_generation", model: "gpt-6.1-sol" }]);
  });

  it("writes instructions on a Project instructions pin, and treats an emptied one as no pin", async () => {
    const { server, desk, call } = await twoBots({ pick });
    server.profileModelConfigs.get("wazuh")!.unslottedAuxiliary.project_instructions = { provider: "nous", model: "hermes-5-405b" };
    expect((await desk.writer("wazuh", "instructions").ask(call)).route).toEqual({ via: "pin", pin: "instructions", provider: "nous", model: "hermes-5-405b" });
    expect(server.oneshotCalls.at(-1)).toEqual({ profile: "wazuh", task: "project_instructions", model: "hermes-5-405b" });

    server.profileModelConfigs.get("wazuh")!.unslottedAuxiliary.project_instructions = { provider: "", model: "" };
    expect((await desk.writer("wazuh", "instructions").ask(call)).route).toEqual({ via: "app", ...pick });
  });

  it("sends no call when the copy can't be written", async () => {
    const { server, desk, call } = await twoBots({ pick });
    server.rest["PUT /api/config"] = () => {
      throw new RestError(500, `{"detail":"disk full"}`);
    };
    await expect(desk.writer("wazuh", "persona").ask(call)).rejects.toThrow();
    expect(server.oneshotCalls).toEqual([]);
  });

  it.each<[string, (s: FakeHermes) => void, string, WritingRoute["via"]]>([
    ["a pin", (s) => s.signedOut.add("openrouter"), "default", "pin"],
    ["the Writing model", (s) => s.signedOut.add("openrouter"), "wazuh", "app"],
    ["the bot's own model", (s) => s.signedOut.add("openai-codex"), "wazuh", "main"],
  ])("fails on %s with no sign-in, carrying the route it ran on", async (_, signOut, profile, via) => {
    const { server, desk, call, setPick } = await twoBots({ pick });
    if (via === "main") setPick(undefined);
    signOut(server);
    const failed = await desk.writer(profile, "persona").ask(call).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(WritingFailed);
    // On its own model Hermes doesn't name a sign-in: it says it found no provider for the task at all.
    expect(failed).toMatchObject({ profile, route: { via }, cause: via === "main" ? "no-provider" : "sign-in" });
  });

  it("leaves chat titles alone: Text generation's block and a Regenerate title's model don't move", async () => {
    const { server, hermes, desk, call } = await twoBots({ pick });
    server.sessions = [row("a", 1, { title: "Lisbon trip" })];
    server.rest["GET /api/sessions/a/messages"] = () => ({ session_id: "a", profile: "default", messages: [{ id: 1, role: "user", content: "Plan my trip" }], pagination: {} });
    await hermes.sync();
    const before = structuredClone(server.modelConfig.auxiliary.title_generation);
    for (const p of ["default", "wazuh"]) await desk.writer(p, "persona").ask(call);
    expect(server.modelConfig.auxiliary.title_generation).toEqual(before);
    expect(server.profileModelConfigs.get("wazuh")!.auxiliary.title_generation).toEqual({ provider: "auto", model: "" });
    server.oneshotCalls.length = 0;
    await hermes.regenerateTitle("a");
    expect(server.oneshotCalls).toEqual([{ profile: "default", task: "title_generation", model: "deepseek/deepseek-v4-flash" }]);
  });
});

describe("Every bot's writing model, for Settings", () => {
  it("says for each bot whether it's pinned, uses the Writing model or its own, and one unread bot doesn't hide the rest", async () => {
    const { server, desk } = await twoBots({ pick });
    const read = server.rest["GET /api/config"];
    server.rest["GET /api/config"] = (r) => {
      if (r.query.get("profile") === "ghost") throw new RestError(404, `{"detail":"Profile not found"}`);
      return read(r);
    };
    expect(await desk.bots(["default", "wazuh", "ghost"])).toEqual([
      { profile: "default", route: { via: "pin", pin: "text", provider: "openrouter", model: "deepseek/deepseek-v4-flash" } },
      { profile: "wazuh", route: { via: "app", ...pick } },
      { profile: "ghost", unread: expect.any(String) },
    ]);
    expect(server.configWrites).toEqual([]);
  });
});
