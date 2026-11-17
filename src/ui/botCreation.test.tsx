// @vitest-environment jsdom
// The New profile form's Generate with AI, Skills, Tools and MCP servers (ADR 0195), shared by Settings → Profiles and
// the Bots view's New bot, through the real transport against FakeHermes at `f0d94882`. What the owner sees, and what
// Hermes received: the rewrite only on a click and only into the box on Replace, and each chosen skill and toolset read
// back from the new profile before any success is said. All data is synthetic.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TEXT_TASK } from "../hermes/modelSettings";
import { FakeHermes } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { en } from "../i18n/en";
import { LocaleContext } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import { ProfileForm, type FormResult, type ProfilesWiring } from "./ProfileSettings";

beforeAll(() => {
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const BUILT_IN = ["arxiv", "git-helper", "hermes-agent", "recipes"];
const ROUGH = "helps me plan meals, short answers, never orders groceries";
const REWRITTEN = "You are a meal-planning helper. Keep answers short. Never order groceries.";

type Options = { connected?: boolean; rephrase?: boolean; setup?: boolean; seed?: (s: FakeHermes) => void; locale?: ReturnType<typeof pseudoLocale> };

/** The New form over a fake Hermes, wired as App wires it; `done` gets what the form finished with. */
async function open({ connected = true, rephrase = true, setup = true, seed = () => {}, locale }: Options = {}) {
  const server = new FakeHermes();
  for (const name of BUILT_IN)
    server.skills.add("default", { dir: `/home/liam/.hermes/skills/${name}`, source: "bundled" }, `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name}.\n`);
  server.oneshotAnswer = REWRITTEN;
  seed(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  await hermes.sync();
  const done = vi.fn<(r: FormResult) => void>();
  const closed = vi.fn();
  const deleted = vi.fn(async () => {});
  const wiring: Omit<ProfilesWiring, "showTab"> = {
    api: hermes.manageProfiles,
    inUse: "default",
    connected,
    unread: () => undefined,
    catalog: async () => [],
    busy: () => undefined,
    lostMessages: () => 0,
    jobCount: async () => 0,
    switchTo: async () => true,
    local: { pending: () => undefined, note: () => {}, clear: () => {}, renamed: async () => {}, deleted },
    copyText: async () => {},
    ...(rephrase && {
      rephrase: {
        ask: (c) => hermes.askForEdit({ profile: "default", instructions: c.instructions, input: c.input, maxTokens: c.maxTokens, task: TEXT_TASK }).then((r) => r.text),
        model: () => hermes.modelSettings.textModel(),
      },
    }),
    ...(setup && { setup: { skills: hermes.skills, toolsets: hermes.toolsets } }),
  };
  const form = (
    <ProfileForm wiring={wiring} rows={[{ name: "default" }]} lacking={() => false} returnTo={createRef()} heading={(locale ?? en).bots.newBot} createLabel={(locale ?? en).bots.createBot} noEdit onDone={done} onClose={closed} />
  );
  render(locale ? <LocaleContext value={locale}>{form}</LocaleContext> : form);
  return { server, hermes, done, closed, deleted, user: userEvent.setup() };
}

const dialog = () => screen.getByRole("dialog");
const persona = () => within(dialog()).getByLabelText("Persona (optional)") as HTMLTextAreaElement;
const generate = () => within(dialog()).getByRole("button", { name: /Generate with AI/ });
const create = () => within(dialog()).getByRole("button", { name: /Create bot/ });
const hintOf = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby")!)?.textContent;
const oneshots = (server: FakeHermes) => server.requests.filter((r) => r.method === "llm.oneshot");
const createBody = (server: FakeHermes) => server.restRequests.find((r) => r.method === "POST" && r.path === "/api/profiles")?.body;

async function named(user: ReturnType<typeof userEvent.setup>, name = "chef") {
  await user.type(within(dialog()).getByLabelText("Name"), name);
}

describe("Generate with AI", () => {
  it("can't run on an empty persona, and says why next to it", async () => {
    const { server, user } = await open();
    await waitFor(() => expect(hintOf(generate())).toBe("Type a rough persona first. AI rewrites what you write; it doesn't make one up."));
    expect(generate().getAttribute("aria-disabled")).toBe("true");
    await user.click(generate());
    await user.type(persona(), "   ");
    await user.click(generate());
    expect(oneshots(server)).toEqual([]);
  });

  it("says why it can't run without a connection, without wiring, or without a Text generation model", async () => {
    const off = await open({ connected: false });
    expect(hintOf(generate())).toBe("Connect to Hermes to rewrite the persona with AI.");
    cleanup();
    await open({ rephrase: false });
    expect(hintOf(generate())).toBe("Rewriting with AI isn't available here.");
    cleanup();
    const none = await open({
      seed: (s) => {
        s.modelConfig.auxiliary.title_generation = { provider: "auto", model: "" };
        s.modelConfig.model = { provider: "", default: "" };
      },
    });
    await none.user.type(persona(), ROUGH);
    await waitFor(() => expect(hintOf(generate())).toBe("No Text generation model is set for default. Pick one in Settings → Model."));
    await none.user.click(generate());
    expect(oneshots(none.server)).toEqual([]);
    expect(oneshots(off.server)).toEqual([]);
  });

  it("runs only on a click, as the profile in use on Text generation, and names that model", async () => {
    const { server, user } = await open();
    await user.type(persona(), ROUGH);
    await waitFor(() => expect(hintOf(generate())).toMatch(/^Rewritten by deepseek-v4-flash, the Text generation model of default\./));
    expect(oneshots(server)).toEqual([]);
    await user.click(generate());
    const suggestion = await within(dialog()).findByLabelText("Suggested persona");
    expect(oneshots(server)).toHaveLength(1);
    expect(oneshots(server)[0].params).toMatchObject({ profile: "default", task: "title_generation", input: expect.stringContaining(`<persona>${ROUGH}</persona>`) });
    expect(suggestion).toHaveProperty("value", REWRITTEN);
    expect(persona().value).toBe(ROUGH);
  });

  it("lets the owner edit the suggestion, and only Replace persona puts it in the box, with focus back there", async () => {
    const { user } = await open();
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    const suggestion = await within(dialog()).findByLabelText("Suggested persona");
    await user.type(suggestion, " Use metric units.");
    await user.click(within(dialog()).getByRole("button", { name: "Replace persona" }));
    expect(persona().value).toBe(`${REWRITTEN} Use metric units.`);
    expect(within(dialog()).queryByLabelText("Suggested persona")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(persona()));
    await user.type(persona(), " Vegetarian.");
    expect(persona().value).toBe(`${REWRITTEN} Use metric units. Vegetarian.`);
  });

  it("asks before replacing text the owner changed since asking", async () => {
    const { server, user } = await open();
    const gate = hold(server);
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    await user.type(persona(), " and desserts");
    await act(async () => gate.go());
    await within(dialog()).findByLabelText("Suggested persona");
    expect(within(dialog()).getByRole("alert").textContent).toMatch(/You changed the persona since asking/);
    expect(within(dialog()).queryByRole("button", { name: "Replace persona" })).toBeNull();
    await user.click(within(dialog()).getByRole("button", { name: "Replace anyway" }));
    expect(persona().value).toBe(REWRITTEN);
  });

  it("drops an answer that comes after Stop, and keeps the persona", async () => {
    const { server, user } = await open();
    const gate = hold(server);
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    expect(within(dialog()).getByRole("status").textContent).toMatch(/Hermes is rewriting your persona…/);
    expect(within(dialog()).getByText("Hermes can't cancel the call. Stop throws its answer away, even if it still finishes.")).toBeTruthy();
    await user.click(within(dialog()).getByRole("button", { name: "Stop" }));
    await act(async () => gate.go());
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(within(dialog()).queryByLabelText("Suggested persona")).toBeNull();
    expect(persona().value).toBe(ROUGH);
    await waitFor(() => expect(document.activeElement).toBe(persona()));
  });

  it("sends one call however fast it's clicked", async () => {
    const { server, user } = await open();
    const gate = hold(server);
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.tripleClick(generate());
    await user.click(generate());
    await waitFor(() => expect(oneshots(server)).toHaveLength(1));
    await act(async () => gate.go());
    await within(dialog()).findByLabelText("Suggested persona");
    expect(oneshots(server)).toHaveLength(1);
  });

  it("says why it failed in Hermes's words and keeps the persona as typed", async () => {
    const { user } = await open({ seed: (s) => s.signedOut.add("openrouter") });
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    const alert = await within(dialog()).findByRole("alert");
    expect(alert.textContent).toMatch(/^Hermes couldn't rewrite it: .*openrouter.* Your persona is unchanged\.$/);
    expect(alert.textContent).not.toMatch(/sk-|api_key=/i);
    expect(persona().value).toBe(ROUGH);
  });

  it("blocks Create while a suggestion is open, and never sends one that wasn't applied", async () => {
    const { server, user, done } = await open();
    await named(user);
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    await within(dialog()).findByLabelText("Suggested persona");
    expect(create()).toHaveProperty("disabled", true);
    expect(within(dialog()).getByText("Replace the persona with the suggestion, or discard it, before creating.")).toBeTruthy();
    await user.click(within(dialog()).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(document.activeElement).toBe(persona()));
    await user.click(create());
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(createBody(server)).toEqual({ name: "chef", soul: ROUGH });
  });

  it("counts an open suggestion as unsaved when leaving", async () => {
    const { user, closed } = await open();
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    await within(dialog()).findByLabelText("Suggested persona");
    await user.clear(persona());
    await user.keyboard("{Escape}");
    expect(within(dialog()).getByText("The changes you made here aren't saved.")).toBeTruthy();
    expect(closed).not.toHaveBeenCalled();
  });

  it("is reached by Tab from the Persona label's row, before the box", async () => {
    const { user } = await open();
    persona().focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(generate());
  });
});

describe("Skills, Tools and MCP servers", () => {
  it("keeps Hermes's defaults unless chosen: the create sends nothing more and says only Created", async () => {
    const { server, user, done } = await open();
    expect(within(dialog()).getAllByRole("radio", { name: "Hermes's defaults" }).every((r) => (r as HTMLInputElement).checked)).toBe(true);
    await named(user);
    await user.click(create());
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(createBody(server)).toEqual({ name: "chef" });
    expect(server.toolsetWrites).toEqual([]);
    expect(done.mock.calls[0][0].notice).toMatchObject({ tone: "muted", text: "Created chef." });
  });

  it("says MCP servers can't be added while creating, and where to add them after", async () => {
    await open();
    expect(within(dialog()).getByRole("group", { name: "MCP servers" }).textContent).toMatch(
      /can't add MCP servers while creating a profile: Hermes would have to copy them without their secrets.*Settings → MCP servers/,
    );
  });

  it("sends the chosen built-in skills as keep_skills, reads them back, and only then says created", async () => {
    const { server, user, done } = await open();
    await named(user);
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await within(skills).findByLabelText(/recipes/);
    expect(within(skills).getByText("4 of 4 on")).toBeTruthy();
    expect(within(skills).getByLabelText(/hermes-agent/)).toHaveProperty("disabled", true);
    await user.type(within(skills).getByLabelText("Filter skills"), "git");
    expect(within(skills).queryByLabelText(/recipes/)).toBeNull();
    await user.click(within(skills).getByLabelText(/git-helper/));
    await user.clear(within(skills).getByLabelText("Filter skills"));
    await user.click(within(skills).getByLabelText(/recipes/));
    expect(within(skills).getByText("2 of 4 on")).toBeTruthy();
    await user.click(create());
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(createBody(server)).toEqual({ name: "chef", keep_skills: ["arxiv", "hermes-agent"] });
    expect(server.restRequests.some((r) => r.method === "GET" && r.path === "/api/skills" && r.query.get("profile") === "chef")).toBe(true);
    expect([...(server.skills.disabled.chef ?? [])].sort()).toEqual(["git-helper", "recipes"]);
    expect(done.mock.calls[0][0]).toEqual({ notice: { tone: "muted", text: "Created chef with the skills and tools you chose.", open: "chef" }, select: "chef" });
  });

  it("sends no_skills when every built-in skill is turned off", async () => {
    const { server, user, done } = await open({ seed: (s) => (s.skills.folders.default = s.skills.folders.default!.filter((f) => !f.dir.endsWith("hermes-agent"))) });
    await named(user);
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await within(skills).findByLabelText(/recipes/);
    await user.click(within(skills).getByRole("button", { name: "All off" }));
    expect(within(skills).getByText("0 of 3 on")).toBeTruthy();
    await user.click(create());
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(createBody(server)).toEqual({ name: "chef", no_skills: true });
    expect(server.skills.folders.chef ?? []).toEqual([]);
  });

  it("sets each toolset that differs on the new profile, reads it back, and leaves the profile in use alone", async () => {
    const { server, user, done } = await open();
    await named(user);
    const tools = within(dialog()).getByRole("group", { name: "Tools" });
    await user.click(within(tools).getByRole("radio", { name: "Choose" }));
    await within(tools).findByLabelText(/Terminal & Processes/);
    expect(within(tools).getByText(/Starts from what default has on/)).toBeTruthy();
    await user.click(within(tools).getByLabelText(/Terminal & Processes/));
    await user.click(within(tools).getByLabelText(/Image Generation/));
    await user.click(create());
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(createBody(server)).toEqual({ name: "chef" });
    expect(server.toolsetWrites).toEqual([
      { profile: "chef", name: "terminal", enabled: false },
      { profile: "chef", name: "image_gen", enabled: true },
    ]);
    expect([...server.enabledToolsets("default")].sort()).toEqual(["file", "stt", "terminal", "web"]);
    expect(done.mock.calls[0][0].notice?.text).toBe("Created chef with the skills and tools you chose.");
  });

  it("asks before a toolset whose change carries a caution, and applies it only on Apply anyway", async () => {
    const { server, user, done } = await open();
    await named(user);
    const tools = within(dialog()).getByRole("group", { name: "Tools" });
    await user.click(within(tools).getByRole("radio", { name: "Choose" }));
    await user.click(await within(tools).findByLabelText(/Computer Use/));
    await user.click(create());
    const outcome = await within(dialog()).findByRole("list", { name: "Not applied" });
    expect(done).not.toHaveBeenCalled();
    expect(server.toolsetWrites).toEqual([]);
    expect(within(outcome).getByText(/Hermes starts installing cua_driver on the server when Computer Use .* is turned on/)).toBeTruthy();
    await user.click(within(outcome).getByRole("button", { name: "Apply anyway" }));
    await waitFor(() => expect(server.toolsetWrites).toEqual([{ profile: "chef", name: "computer_use", enabled: true }]));
    await user.click(await within(dialog()).findByRole("button", { name: "Done" }));
    expect(done.mock.calls[0][0].notice).toMatchObject({ tone: "muted", text: "Created chef with the skills and tools you chose." });
  });

  it("keeps the dialog open on a failed stage, with no success, and Keep it as is names what isn't applied", async () => {
    const { user, done } = await open({ seed: (s) => (s.profileKeepSkillsFails = true) });
    await named(user);
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await user.click(await within(skills).findByLabelText(/recipes/));
    await user.click(create());
    const outcome = await within(dialog()).findByRole("list", { name: "Not applied" });
    expect(within(dialog()).getByText("chef was created, but not everything you chose is in place.")).toBeTruthy();
    expect(within(dialog()).getByText("3 of 4 applied and read back.")).toBeTruthy();
    expect(within(outcome).getByText("Skill recipes")).toBeTruthy();
    expect(within(outcome).getByText("Hermes reads it back as on.")).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Delete chef" })).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(done).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Keep it as is" }));
    expect(done.mock.calls[0][0]).toEqual({ notice: { tone: "bad", text: "Created chef, but these aren't as you chose: Skill recipes.", open: "chef" }, select: "chef" });
  });

  it("Try again applies a failed skill and reads it back", async () => {
    const { server, user, done } = await open({ seed: (s) => (s.profileKeepSkillsFails = true) });
    await named(user);
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await user.click(await within(skills).findByLabelText(/recipes/));
    await user.click(create());
    const outcome = await within(dialog()).findByRole("list", { name: "Not applied" });
    await user.click(within(outcome).getByRole("button", { name: "Try again" }));
    await within(dialog()).findByText("Everything you chose is now applied and read back.");
    expect(server.skills.disabled.chef?.has("recipes")).toBe(true);
    await user.click(within(dialog()).getByRole("button", { name: "Done" }));
    expect(done.mock.calls[0][0].notice?.tone).toBe("muted");
  });

  it("Delete removes the profile it made and forgets it here, with no success notice", async () => {
    const { server, user, done, deleted } = await open({ seed: (s) => (s.profileKeepSkillsFails = true) });
    await named(user);
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await user.click(await within(skills).findByLabelText(/recipes/));
    await user.click(create());
    await user.click(await within(dialog()).findByRole("button", { name: "Delete chef" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect("chef" in server.otherProfiles).toBe(false);
    expect(deleted).toHaveBeenCalledWith("chef");
    expect(done.mock.calls[0][0]).toEqual({ notice: { tone: "warn", text: "Deleted chef, since not everything you chose applied." } });
  });

  it("writes nothing more after a lost create answer, and says skills and tools weren't checked", async () => {
    const { server, user, done } = await open({ seed: (s) => (s.profileCreateLost = "The connection dropped.") });
    await named(user);
    const tools = within(dialog()).getByRole("group", { name: "Tools" });
    await user.click(within(tools).getByRole("radio", { name: "Choose" }));
    await user.click(await within(tools).findByLabelText(/Terminal & Processes/));
    await user.click(create());
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(server.toolsetWrites).toEqual([]);
    expect(server.restRequests.filter((r) => r.query.get("profile") === "chef")).toEqual([]);
    expect(done.mock.calls[0][0].notice).toMatchObject({ tone: "warn", text: expect.stringMatching(/^Hermes's answer was lost, but it lists chef now\. Its skills and tools weren't checked/) });
    expect(within(dialog()).queryByRole("button", { name: "Delete chef" })).toBeNull();
  });

  it("shows a list it couldn't read, keeps the defaults, and says when the server can't list them", async () => {
    const { server, user } = await open({ seed: (s) => (s.toolsetRoutes = "none") });
    const tools = within(dialog()).getByRole("group", { name: "Tools" });
    await user.click(within(tools).getByRole("radio", { name: "Choose" }));
    await waitFor(() => expect(within(tools).getByRole("radio", { name: "Choose" })).toHaveProperty("disabled", true));
    expect(within(tools).getByText(/no \/api\/tools\/toolsets route.*The new profile gets Hermes's defaults\./)).toBeTruthy();
    expect(within(tools).getByRole("radio", { name: "Hermes's defaults" })).toHaveProperty("checked", true);
    server.skills.routes = true;
  });
});

describe("Elsewhere", () => {
  it("leaves Edit as it was: no Generate with AI, Skills, Tools or MCP servers", async () => {
    const server = new FakeHermes();
    server.otherProfiles = { work: [] };
    const hermes = await connect(server.openPipe, undefined, memoryCache());
    running.push(hermes);
    await hermes.sync();
    const row = (await hermes.manageProfiles.list()).find((r) => r.name === "work")!;
    render(
      <ProfileForm
        wiring={{
          api: hermes.manageProfiles,
          inUse: "default",
          connected: true,
          unread: () => undefined,
          catalog: async () => [],
          busy: () => undefined,
          lostMessages: () => 0,
          jobCount: async () => 0,
          switchTo: async () => true,
          local: { pending: () => undefined, note: () => {}, clear: () => {}, renamed: async () => {}, deleted: async () => {} },
          copyText: async () => {},
          rephrase: { ask: async () => "x", model: async () => ({ provider: "p", model: "m" }) },
          setup: { skills: hermes.skills, toolsets: hermes.toolsets },
        }}
        row={row}
        rows={[{ name: "default" }, { name: "work" }]}
        lacking={() => false}
        returnTo={createRef()}
        onDone={() => {}}
        onClose={() => {}}
      />,
    );
    expect(within(dialog()).queryByRole("button", { name: /Generate with AI/ })).toBeNull();
    expect(within(dialog()).queryByRole("group", { name: "Skills" })).toBeNull();
    expect(within(dialog()).queryByRole("group", { name: "MCP servers" })).toBeNull();
    expect(server.restRequests.filter((r) => r.path === "/api/model/auxiliary" || r.path === "/api/skills" || r.path === "/api/tools/toolsets")).toEqual([]);
  });

  it("shows only catalogue words: the form, a suggestion, chosen lists and what didn't apply", async () => {
    const p = pseudoLocale();
    const { user } = await open({ locale: p, seed: (s) => (s.profileKeepSkillsFails = true) });
    const box = () => screen.getByRole("dialog");
    expect(untranslated(box())).toEqual([]);
    await user.type(within(box()).getByLabelText(p.profiles.form.name), "chef");
    await user.type(within(box()).getByLabelText(p.profiles.form.persona), ROUGH);
    await waitFor(() => expect(within(box()).getByText(new RegExp(`Rewritten by`))).toBeTruthy());
    await user.click(within(box()).getByRole("button", { name: new RegExp(p.profiles.form.rephrase.generate.replace(/[⟦⟧]/g, ".")) }));
    await within(box()).findByLabelText(p.profiles.form.rephrase.suggestion);
    expect(untranslated(box())).toEqual([]);
    await user.click(within(box()).getByRole("button", { name: p.profiles.form.rephrase.discard }));
    for (const area of [p.profiles.form.setup.skills, p.profiles.form.setup.tools]) {
      const group = within(box()).getByRole("group", { name: area });
      await user.click(within(group).getAllByRole("radio")[1]);
      await within(group).findAllByRole("checkbox");
    }
    await user.click(within(within(box()).getByRole("group", { name: p.profiles.form.setup.skills })).getByLabelText(/recipes/));
    await user.click(within(within(box()).getByRole("group", { name: p.profiles.form.setup.tools })).getByLabelText(/Computer Use/));
    expect(untranslated(box())).toEqual([]);
    await user.click(within(box()).getByRole("button", { name: new RegExp(p.bots.createBot.replace(/[⟦⟧]/g, ".")) }));
    await within(box()).findByRole("list", { name: p.profiles.form.setup.notApplied });
    expect(untranslated(box())).toEqual([]);
  });
});

/** Holds every `llm.oneshot` answer until `go`. */
function hold(server: FakeHermes) {
  let go = () => {};
  server.oneshotGate = new Promise<void>((r) => (go = r));
  return { go: () => go() };
}

/** Waits for the Text generation model read the form makes as it opens. */
async function modelReadDone() {
  await waitFor(() => expect(hintOf(generate())).not.toBe("Checking which model would rewrite it…"));
}
