// @vitest-environment jsdom
// The New profile form's Write with AI, Skills, Tools and MCP servers (ADR 0197, 0204), shared by Settings → Profiles
// and Bots mode's New bot, through the real transport against FakeHermes at `f0d94882`. What the owner sees, and what
// Hermes received: the rewrite only on a click, in the field with Undo, and each chosen skill and toolset read
// back from the new profile before any success is said. All data is synthetic.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TEXT_TASK } from "../hermes/modelSettings";
import { FakeHermes } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { RestError } from "../hermes/pipe";
import { connect, type Hermes } from "../hermes/transport";
import { en } from "../i18n/en";
import { LocaleContext } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import { ProfileForm, type FormResult, type Notice, type ProfilesWiring } from "./ProfileSettings";

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

type Options = {
  connected?: boolean;
  rephrase?: boolean;
  setup?: boolean;
  seed?: (s: FakeHermes) => void;
  locale?: ReturnType<typeof pseudoLocale>;
  forgetFails?: boolean;
  /** Offers one provider and model to pick, as App's catalogue does. */
  models?: boolean;
  /** As Bots mode's New bot: no Set model after a create that didn't set it. */
  noEdit?: boolean;
};

/**
 * The New form over a fake Hermes, wired as App wires it; `done` gets what the form finished with, and `notified` what
 * the app is told once the form has closed. `reconnect` draws it again connected or not, with Write with AI wired
 * only while connected, as App does; `switchProfile` draws it again with another profile in use.
 */
async function open({ connected = true, rephrase = true, setup = true, seed = () => {}, locale, forgetFails = false, models = false, noEdit = true }: Options = {}) {
  const server = new FakeHermes();
  for (const name of BUILT_IN)
    server.skills.add("default", { dir: `/home/liam/.hermes/skills/${name}`, source: "bundled" }, `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name}.\n`);
  server.oneshotAnswer = REWRITTEN;
  seed(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  await hermes.sync();
  const done = vi.fn<(r: FormResult) => void>();
  const notified = vi.fn<(n: Notice) => void>();
  const closed = vi.fn();
  /** What the form told the app, each time, about an unsaved persona. */
  const personaReports: boolean[] = [];
  const at = { connected, inUse: "default" };
  const deleted = vi.fn(async () => {
    if (forgetFails) throw new Error("The drafts folder is read-only.");
  });
  const wiring = (connected: boolean, inUse: string): Omit<ProfilesWiring, "showTab"> => ({
    api: hermes.manageProfiles,
    inUse,
    connected,
    unread: () => undefined,
    catalog: async () => (models ? [{ slug: "openai", name: "OpenAI", models: ["gpt-6.1"], caps: {} }] : []),
    busy: () => undefined,
    lostMessages: () => 0,
    jobCount: async () => 0,
    switchTo: async () => true,
    local: { pending: () => undefined, note: () => {}, clear: () => {}, renamed: async () => {}, deleted },
    copyText: async () => {},
    onPersonaDirty: (dirty) => void personaReports.push(dirty),
    ...(rephrase &&
      connected && {
        rephrase: (p) => ({
          ask: (c) => hermes.askForEdit({ profile: p, instructions: c.instructions, input: c.input, maxTokens: c.maxTokens, task: TEXT_TASK }).then((r) => r.text),
          model: () => hermes.modelSettings.textModel(p),
        }),
      }),
    ...(setup && { setup: { skills: hermes.skills, toolsets: hermes.toolsets } }),
    notify: notified,
  });
  const form = () => {
    const f = (
      <ProfileForm
        wiring={wiring(at.connected, at.inUse)}
        rows={[{ name: "default" }]}
        lacking={() => false}
        returnTo={createRef()}
        heading={(locale ?? en).bots.newBot}
        createLabel={(locale ?? en).bots.createBot}
        noEdit={noEdit}
        onDone={done}
        onClose={closed}
      />
    );
    return locale ? <LocaleContext value={locale}>{f}</LocaleContext> : f;
  };
  const { rerender, unmount } = render(form());
  const reconnect = (c: boolean) => {
    at.connected = c;
    rerender(form());
  };
  const switchProfile = (name: string) => {
    at.inUse = name;
    rerender(form());
  };
  return { server, hermes, done, notified, closed, deleted, unmount, reconnect, switchProfile, personaReports, user: userEvent.setup() };
}

const dialog = () => screen.getByRole("dialog");
const persona = () => within(dialog()).getByLabelText("Persona (optional)") as HTMLTextAreaElement;
const generate = () => within(dialog()).getByRole("button", { name: /Write with AI/ });
const create = () => within(dialog()).getByRole("button", { name: /Create bot/ });
const hintOf = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby")!)?.textContent;
const oneshots = (server: FakeHermes) => server.requests.filter((r) => r.method === "llm.oneshot");
const creates = (server: FakeHermes) => server.restRequests.filter((r) => r.method === "POST" && r.path === "/api/profiles");
const createBody = (server: FakeHermes) => creates(server)[0]?.body;
const toggles = (server: FakeHermes) => server.restRequests.filter((r) => r.method === "PUT" && r.path === "/api/skills/toggle").map((r) => [r.query.get("profile"), r.body]);
const LOCKED = { status: 400, detail: "Skill changes are locked on this server." };

async function named(user: ReturnType<typeof userEvent.setup>, name = "chef") {
  await user.type(within(dialog()).getByLabelText("Name"), name);
}

describe("Write with AI", () => {
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

  it("runs only on a click, as the profile in use on Text generation, and rewrites the field in place", async () => {
    const { server, user } = await open();
    await user.type(persona(), ROUGH);
    await waitFor(() => expect(hintOf(generate())).toMatch(/^Rewritten by deepseek-v4-flash, the Text generation model of default,/));
    expect(oneshots(server)).toEqual([]);
    await user.click(generate());
    await waitFor(() => expect(persona().value).toBe(REWRITTEN));
    expect(oneshots(server)).toHaveLength(1);
    expect(oneshots(server)[0].params).toMatchObject({ profile: "default", task: "title_generation", input: expect.stringContaining(`<persona>${ROUGH}</persona>`) });
    expect(within(dialog()).queryAllByRole("textbox").filter((t) => t.tagName === "TEXTAREA")).toHaveLength(1);
  });

  it("puts the owner's text back on Undo, with focus in the field", async () => {
    const { user } = await open();
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    await waitFor(() => expect(persona().value).toBe(REWRITTEN));
    await user.click(within(dialog()).getByRole("button", { name: "Undo" }));
    expect(persona().value).toBe(ROUGH);
    expect(within(dialog()).queryByRole("button", { name: "Undo" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(persona()));
  });

  it("stops offering Undo once the owner edits the rewrite", async () => {
    const { user } = await open();
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    await waitFor(() => expect(persona().value).toBe(REWRITTEN));
    await user.type(persona(), " Vegetarian.");
    expect(persona().value).toBe(`${REWRITTEN} Vegetarian.`);
    expect(within(dialog()).queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("keeps the field read-only while asking, and drops an answer that comes after Stop", async () => {
    const { server, user } = await open();
    const gate = hold(server);
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    expect(within(dialog()).getByText(/Hermes is rewriting your persona…/)).toBeTruthy();
    expect(within(dialog()).getByText("Hermes can't cancel the call. Stop throws its answer away, even if it still finishes.")).toBeTruthy();
    expect(persona().readOnly).toBe(true);
    await user.click(within(dialog()).getByRole("button", { name: "Stop" }));
    await act(async () => gate.go());
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(persona().value).toBe(ROUGH);
    expect(persona().readOnly).toBe(false);
    expect(within(dialog()).queryByRole("button", { name: "Undo" })).toBeNull();
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
    await waitFor(() => expect(persona().value).toBe(REWRITTEN));
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

  it("blocks Create only while asking, and creates with the rewritten persona", async () => {
    const { server, user, done } = await open();
    const gate = hold(server);
    await named(user);
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    expect(create().getAttribute("aria-disabled")).toBe("true");
    expect(hintOf(create())).toBe("Wait for the persona's rewrite, or stop it, first.");
    await user.click(create());
    expect(creates(server)).toEqual([]);
    await act(async () => gate.go());
    await waitFor(() => expect(persona().value).toBe(REWRITTEN));
    expect(create().getAttribute("aria-disabled")).toBeNull();
    await user.click(create());
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(createBody(server)).toEqual({ name: "chef", soul: REWRITTEN });
  });

  it("says an empty answer failed, in the catalogue's words", async () => {
    const { user } = await open({ seed: (s) => (s.oneshotAnswer = "  \n") });
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    expect((await within(dialog()).findByRole("alert")).textContent).toBe("Hermes couldn't rewrite it: Hermes answered with no text. Your persona is unchanged.");
    expect(persona().value).toBe(ROUGH);
  });

  it("won't rewrite a persona too long to send whole, so its end isn't lost", async () => {
    let asked = 0;
    const { user } = await open({ seed: (s) => (s.oneshotAnswer = () => (asked++, REWRITTEN)) });
    await user.click(persona());
    await user.paste(`${ROUGH} `.repeat(200));
    await modelReadDone();
    await user.click(generate());
    expect(generate().getAttribute("aria-disabled")).toBe("true");
    expect(hintOf(generate())).toBe("Write with AI rewrites up to 8000 characters, and this persona is longer. Shorten it first, or edit it by hand.");
    expect(asked).toBe(0);
    expect(persona().value).toBe(`${ROUGH} `.repeat(200));
  });

  it("lets Create run again once a connection drops during a rewrite and comes back", async () => {
    const { server, user, done, reconnect } = await open();
    hold(server);
    await named(user);
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    expect(hintOf(create())).toBe("Wait for the persona's rewrite, or stop it, first.");
    reconnect(false);
    reconnect(true);
    await modelReadDone();
    expect(within(dialog()).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(create().getAttribute("aria-disabled")).toBeNull();
    await user.click(create());
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(createBody(server)).toEqual({ name: "chef", soul: ROUGH });
  });

  it("is reached by Tab from the Persona label's row, before the field", async () => {
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

  it("creates as before, then turns off only the unticked built-in skills on the new profile, and only then says created", async () => {
    const { server, user, done } = await open();
    await named(user);
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await within(skills).findByLabelText(/recipes/);
    expect(within(skills).getByText(/^The built-in skills listed for default\. .*Any built-in skill this list doesn't show stays as Hermes sets it\.$/)).toBeTruthy();
    expect(within(skills).getByText("4 of 4 on")).toBeTruthy();
    await user.type(within(skills).getByLabelText("Filter skills"), "git");
    expect(within(skills).queryByLabelText(/recipes/)).toBeNull();
    await user.click(within(skills).getByLabelText(/git-helper/));
    await user.clear(within(skills).getByLabelText("Filter skills"));
    await user.click(within(skills).getByLabelText(/recipes/));
    expect(within(skills).getByText("2 of 4 on")).toBeTruthy();
    await user.click(create());
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(createBody(server)).toEqual({ name: "chef" });
    expect(toggles(server)).toEqual([
      ["chef", { name: "git-helper", enabled: false }],
      ["chef", { name: "recipes", enabled: false }],
    ]);
    expect([...(server.skills.disabled.chef ?? [])].sort()).toEqual(["git-helper", "recipes"]);
    expect(done.mock.calls[0][0]).toEqual({ notice: { tone: "muted", text: "Created chef with the skills and tools you chose.", open: "chef" }, select: "chef" });
  });

  it("keeps the skill Hermes keeps on ticked and focusable, with why, whatever is clicked", async () => {
    const { user } = await open();
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    const kept = (await within(skills).findByLabelText(/hermes-agent/)) as HTMLInputElement;
    expect(kept.disabled).toBe(false);
    expect(kept.getAttribute("aria-disabled")).toBe("true");
    expect(hintOf(kept)).toBe("Hermes keeps this one on.");
    await user.click(kept);
    await user.click(within(skills).getByRole("button", { name: "All off" }));
    expect(kept.checked).toBe(true);
    expect(within(skills).getByText("1 of 4 on")).toBeTruthy();
  });

  it("turns every listed skill off when none is kept, and sends nothing for them in the create", async () => {
    const { server, user, done } = await open({ seed: (s) => (s.skills.folders.default = s.skills.folders.default!.filter((f) => !f.dir.endsWith("hermes-agent"))) });
    await named(user);
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await within(skills).findByLabelText(/recipes/);
    await user.click(within(skills).getByRole("button", { name: "All off" }));
    expect(within(skills).getByText("0 of 3 on")).toBeTruthy();
    await user.click(create());
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(createBody(server)).toEqual({ name: "chef" });
    expect([...(server.skills.disabled.chef ?? [])].sort()).toEqual(["arxiv", "git-helper", "recipes"]);
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
    const also = await within(dialog()).findByRole("list", { name: "Hermes also" });
    expect(also.textContent).toMatch(/^Hermes started installing cua_driver on the server for Computer Use.*, in the background\.$/);
    await user.click(within(dialog()).getByRole("button", { name: "Done" }));
    expect(done.mock.calls[0][0].notice).toMatchObject({
      tone: "muted",
      text: expect.stringMatching(/^Created chef with the skills and tools you chose\. Hermes started installing cua_driver on the server for Computer Use/),
    });
  });

  it("keeps the dialog open on a failed stage, with no success, and Keep it as is names what isn't applied", async () => {
    const { user, done } = await open({ seed: (s) => (s.skills.toggleRefusal = LOCKED) });
    await named(user);
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await user.click(await within(skills).findByLabelText(/recipes/));
    await user.click(create());
    const outcome = await within(dialog()).findByRole("list", { name: "Not applied" });
    expect(within(dialog()).getByText("chef was created, but not everything you chose is in place.")).toBeTruthy();
    expect(within(dialog()).getByText("3 of 4 applied and read back.")).toBeTruthy();
    expect(within(outcome).getByText("Skill recipes")).toBeTruthy();
    expect(within(outcome).getByText(/Skill changes are locked on this server\./)).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Delete chef" })).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(done).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Keep it as is" }));
    expect(done.mock.calls[0][0]).toEqual({ notice: { tone: "bad", text: "Created chef, but these aren't as you chose: Skill recipes.", open: "chef" }, select: "chef" });
  });

  it("shows what a create came to from its top, however far the form was scrolled", async () => {
    const { user } = await open({ seed: (s) => (s.skills.toggleRefusal = LOCKED) });
    await named(user);
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await user.click(await within(skills).findByLabelText(/recipes/));
    dialog().scrollTop = 500;
    await user.click(create());
    await within(dialog()).findByRole("list", { name: "Not applied" });
    expect(dialog().scrollTop).toBe(0);
  });

  it("Try again applies a failed skill and reads it back", async () => {
    const { server, user, done } = await open({ seed: (s) => (s.skills.toggleRefusal = LOCKED) });
    await named(user);
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await user.click(await within(skills).findByLabelText(/recipes/));
    await user.click(create());
    const outcome = await within(dialog()).findByRole("list", { name: "Not applied" });
    server.skills.toggleRefusal = undefined;
    await user.click(within(outcome).getByRole("button", { name: "Try again" }));
    await within(dialog()).findByText("Everything you chose is now applied and read back.");
    expect(server.skills.disabled.chef?.has("recipes")).toBe(true);
    await user.click(within(dialog()).getByRole("button", { name: "Done" }));
    expect(done.mock.calls[0][0].notice?.tone).toBe("muted");
  });

  it("Delete removes the profile it made and forgets it here, with no success notice", async () => {
    const { server, user, done, deleted } = await open({ seed: (s) => (s.skills.toggleRefusal = LOCKED) });
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

  it("says when Hermes is still settling a deleted profile, with the command it gives", async () => {
    for (const [command, notice] of [
      ["hermes profile finish-delete chef", { tone: "warn", text: en.profiles.del.settling("chef"), command: "hermes profile finish-delete chef" }],
      ["", { tone: "warn", text: en.profiles.del.settlingNoCommand("chef") }],
    ] as const) {
      const { server, user, done } = await open({
        seed: (s) => {
          s.skills.toggleRefusal = LOCKED;
          s.profileSettlementPending = command;
        },
      });
      await named(user);
      const skills = within(dialog()).getByRole("group", { name: "Skills" });
      await user.click(within(skills).getByRole("radio", { name: "Choose" }));
      await user.click(await within(skills).findByLabelText(/recipes/));
      await user.click(create());
      await user.click(await within(dialog()).findByRole("button", { name: "Delete chef" }));
      await waitFor(() => expect(done).toHaveBeenCalled());
      expect("chef" in server.otherProfiles).toBe(false);
      expect(done.mock.calls).toEqual([[{ notice }]]);
      cleanup();
    }
  });

  it("stops calling the persona unsaved once Create made the profile, while the form says what didn't apply", async () => {
    const { user, personaReports } = await open({ models: true, seed: (s) => (s.profileModelError = "Model not listed.") });
    await named(user);
    await user.type(persona(), ROUGH);
    expect(personaReports.at(-1)).toBe(true);
    const provider = within(dialog()).getByLabelText("Provider") as HTMLSelectElement;
    await waitFor(() => expect(provider.options.length).toBeGreaterThan(1));
    await user.selectOptions(provider, "openai");
    await user.type(within(dialog()).getByLabelText("Model name"), "gpt-6.1");
    await user.click(create());
    await within(dialog()).findByText("Profile created, but Hermes didn't set the model: Model not listed.");
    expect(personaReports.at(-1)).toBe(false);
  });

  it("offers Set model when Hermes didn't set the model picked, and goes on to Edit with what didn't apply", async () => {
    const pick = async (noEdit: boolean) => {
      const opened = await open({ models: true, noEdit, seed: (s) => (s.profileModelError = "Model not listed.") });
      await named(opened.user);
      const provider = within(dialog()).getByLabelText("Provider") as HTMLSelectElement;
      await waitFor(() => expect(provider.options.length).toBeGreaterThan(1));
      await opened.user.selectOptions(provider, "openai");
      await opened.user.type(within(dialog()).getByLabelText("Model name"), "gpt-6.1");
      const tools = within(dialog()).getByRole("group", { name: "Tools" });
      await opened.user.click(within(tools).getByRole("radio", { name: "Choose" }));
      await opened.user.click(await within(tools).findByLabelText(/Terminal & Processes/));
      await opened.user.click(create());
      await within(dialog()).findByText("Profile created, but Hermes didn't set the model: Model not listed.");
      return opened;
    };
    const { user, done } = await pick(false);
    await user.click(within(dialog()).getByRole("button", { name: "Set model…" }));
    expect(done.mock.calls).toEqual([[{ notice: { tone: "bad", text: "Created chef, but these aren't as you chose: the model.", open: "chef" }, select: "chef", edit: "chef" }]]);
    cleanup();
    await pick(true);
    expect(within(dialog()).queryByRole("button", { name: "Set model…" })).toBeNull();
    expect(within(dialog()).getByRole("button", { name: "Keep it as is" })).toBeTruthy();
  });

  it("chooses from the newest list read: an older read ending meanwhile neither flips the choice nor lets Create run", async () => {
    const { server, user } = await open();
    await named(user);
    const tools = within(dialog()).getByRole("group", { name: "Tools" });
    const lists = () => server.restRequests.filter((r) => r.method === "GET" && r.path === "/api/tools/toolsets").length;
    let first = () => {};
    server.toolsetListGateOnce = new Promise<void>((r) => (first = r));
    await user.click(within(tools).getByRole("radio", { name: "Choose" }));
    await waitFor(() => expect(lists()).toBe(1));
    await user.click(within(tools).getByRole("radio", { name: "Hermes's defaults" }));
    let second = () => {};
    server.toolsetListGateOnce = new Promise<void>((r) => (second = r));
    await user.click(within(tools).getByRole("radio", { name: "Choose" }));
    await waitFor(() => expect(lists()).toBe(2));
    await act(async () => first());
    expect(within(tools).getByRole("radio", { name: "Choose" })).toHaveProperty("checked", true);
    expect(within(tools).queryAllByRole("checkbox")).toEqual([]);
    expect(hintOf(create())).toBe("Wait for the list of skills or tools to be read.");
    await act(async () => second());
    await user.click(await within(tools).findByLabelText(/Terminal & Processes/));
    expect(within(tools).getByLabelText(/Terminal & Processes/)).toHaveProperty("checked", false);
    expect(within(tools).getByRole("radio", { name: "Choose" })).toHaveProperty("checked", true);
  });

  it("reads the lists and the rewrite's model again from a profile switched to, keeping only the ticks the owner changed", async () => {
    const { server, user, switchProfile } = await open({
      seed: (s) => {
        s.otherProfiles = { work: [] };
        s.skills.add("work", { dir: "/home/liam/.hermes/profiles/work/skills/arxiv", source: "bundled" }, "---\nname: arxiv\ndescription: The arxiv skill\n---\nDo arxiv.\n");
        s.toolsetsOn.work = new Set(["file", "discord"]);
      },
    });
    await user.type(persona(), ROUGH);
    await waitFor(() => expect(hintOf(generate())).toMatch(/the Text generation model of default,/));
    const tools = within(dialog()).getByRole("group", { name: "Tools" });
    await user.click(within(tools).getByRole("radio", { name: "Choose" }));
    await user.click(await within(tools).findByLabelText(/File Operations/));
    await user.click(within(tools).getByLabelText(/Image Generation/));
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await user.click(await within(skills).findByLabelText(/recipes/));
    const read = (path: string, profile: string) => server.restRequests.filter((r) => r.method === "GET" && r.path === path && r.query.get("profile") === profile).length;
    const auxReads = server.restRequests.filter((r) => r.path === "/api/model/auxiliary").length;
    switchProfile("work");
    await waitFor(() => expect(within(tools).getByText(/^Starts from what work has on\./)).toBeTruthy());
    expect(read("/api/tools/toolsets", "work")).toBe(1);
    await waitFor(() => expect(hintOf(generate())).toMatch(/the Text generation model of work,/));
    expect(server.restRequests.filter((r) => r.path === "/api/model/auxiliary").length).toBe(auxReads + 1);
    const ticked = (label: RegExp) => (within(tools).getByLabelText(label) as HTMLInputElement).checked;
    // The owner's own changes, over what work has on.
    expect([ticked(/File Operations/), ticked(/Image Generation/)]).toEqual([false, true]);
    // Left as the owner found them: now as work has them.
    expect([ticked(/Discord/), ticked(/Web Search/), ticked(/Terminal & Processes/)]).toEqual([true, false, false]);
    expect(within(tools).queryByRole("status")).toBeNull();
    await within(skills).findByLabelText(/arxiv/);
    expect(read("/api/skills", "work")).toBe(1);
    expect(within(skills).queryByLabelText(/recipes/)).toBeNull();
    expect(within(skills).getByRole("status").textContent).toBe(en.profiles.form.setup.switchDropped("work", "recipes"));
  });

  it("says the choice went back to Hermes's defaults when the list can't be read again from a profile switched to", async () => {
    const { server, user, switchProfile } = await open({ seed: (s) => (s.otherProfiles = { work: [] }) });
    const tools = within(dialog()).getByRole("group", { name: "Tools" });
    await user.click(within(tools).getByRole("radio", { name: "Choose" }));
    await within(tools).findByLabelText(/File Operations/);
    server.restTap = (req) => {
      if (req.path === "/api/tools/toolsets" && req.query.get("profile") === "work") throw new RestError(500, JSON.stringify({ detail: "Internal Server Error" }));
    };
    switchProfile("work");
    await within(tools).findByText(en.profiles.form.setup.switchReset("work"));
    expect(within(tools).getByRole("radio", { name: "Hermes's defaults" })).toHaveProperty("checked", true);
    expect(within(tools).getByRole("alert").textContent).toMatch(/^Couldn't read the list: Internal Server Error/);
  });

  it("says when Delete removed the profile but not this computer's data for it", async () => {
    const { server, user, done } = await open({ forgetFails: true, seed: (s) => (s.skills.toggleRefusal = LOCKED) });
    await named(user);
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await user.click(await within(skills).findByLabelText(/recipes/));
    await user.click(create());
    await user.click(await within(dialog()).findByRole("button", { name: "Delete chef" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect("chef" in server.otherProfiles).toBe(false);
    expect(done.mock.calls[0][0]).toEqual({
      notice: { tone: "bad", text: "Deleted chef on Hermes, since not everything you chose applied, but some of this computer's data for it couldn't be removed." },
    });
  });

  it("sends one create however fast Create is activated, and says what it came to", async () => {
    const { server, user, done } = await open();
    await named(user);
    const tools = within(dialog()).getByRole("group", { name: "Tools" });
    await user.click(within(tools).getByRole("radio", { name: "Choose" }));
    await user.click(await within(tools).findByLabelText(/Terminal & Processes/));
    act(() => {
      create().click();
      create().click();
    });
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(creates(server)).toHaveLength(1);
    expect(server.toolsetWrites).toEqual([{ profile: "chef", name: "terminal", enabled: false }]);
    expect(done.mock.calls).toEqual([[{ notice: { tone: "muted", text: "Created chef with the skills and tools you chose.", open: "chef" }, select: "chef" }]]);
  });

  it("still says what a create came to, through the app, when the whole view closes while its choices are applied", async () => {
    const { server, user, done, notified, unmount } = await open();
    let go = () => {};
    server.toolsetGateBeforeWrite = new Promise<void>((r) => (go = r));
    await named(user);
    const tools = within(dialog()).getByRole("group", { name: "Tools" });
    await user.click(within(tools).getByRole("radio", { name: "Choose" }));
    await user.click(await within(tools).findByLabelText(/Computer Use/));
    await user.click(within(tools).getByLabelText(/Terminal & Processes/));
    await user.click(create());
    await within(dialog()).findByText(/Applying the skills and tools you chose/);
    await waitFor(() => expect(server.restRequests.some((r) => r.method === "PUT" && r.path === "/api/tools/toolsets/terminal")).toBe(true));
    unmount();
    go();
    await waitFor(() => expect(notified).toHaveBeenCalled());
    expect(notified.mock.calls).toEqual([[{ tone: "bad", text: expect.stringMatching(/^Created chef, but these aren't as you chose: Tool Computer Use/), open: "chef" }]]);
    expect(done).not.toHaveBeenCalled();
    expect(server.toolsetWrites).toEqual([{ profile: "chef", name: "terminal", enabled: false }]);
  });

  it("still says what a plain create or a failed one came to, through the app, when the view closes before Hermes answers", async () => {
    const plain = await open();
    await named(plain.user);
    act(() => create().click());
    plain.unmount();
    await waitFor(() => expect(plain.notified).toHaveBeenCalled());
    expect(plain.notified.mock.calls).toEqual([[{ tone: "muted", text: "Created chef.", open: "chef" }]]);
    cleanup();
    const refused = await open({ seed: (s) => (s.profileCreateError = "Disk full.") });
    await named(refused.user);
    act(() => create().click());
    refused.unmount();
    await waitFor(() => expect(refused.notified).toHaveBeenCalled());
    expect(refused.notified.mock.calls).toEqual([[{ tone: "bad", text: expect.stringMatching(/^chef wasn't created\. .*Disk full\./) }]]);
    expect(refused.done).not.toHaveBeenCalled();
  });

  it("still says what Try again and Delete came to, through the app, once the view has closed", async () => {
    const outcome = async (seed: (s: FakeHermes) => void = () => {}) => {
      const opened = await open({ seed: (s) => ((s.skills.toggleRefusal = LOCKED), seed(s)) });
      await named(opened.user);
      const skills = within(dialog()).getByRole("group", { name: "Skills" });
      await opened.user.click(within(skills).getByRole("radio", { name: "Choose" }));
      await opened.user.click(await within(skills).findByLabelText(/recipes/));
      await opened.user.click(create());
      await within(dialog()).findByRole("list", { name: "Not applied" });
      return opened;
    };
    const retried = await outcome();
    retried.server.skills.toggleRefusal = undefined;
    act(() => within(dialog()).getByRole("button", { name: "Try again" }).click());
    retried.unmount();
    await waitFor(() => expect(retried.notified).toHaveBeenCalled());
    expect(retried.notified.mock.calls).toEqual([[{ tone: "muted", text: "Created chef with the skills and tools you chose.", open: "chef" }]]);
    cleanup();
    const settling = await outcome((s) => (s.profileSettlementPending = "hermes profile finish-delete chef"));
    act(() => within(dialog()).getByRole("button", { name: "Delete chef" }).click());
    settling.unmount();
    await waitFor(() => expect(settling.notified).toHaveBeenCalled());
    expect(settling.notified.mock.calls).toEqual([[{ tone: "warn", text: en.profiles.del.settling("chef"), command: "hermes profile finish-delete chef" }]]);
    cleanup();
    const kept = await outcome((s) => s.profileRoutesMissing.add("remove"));
    act(() => within(dialog()).getByRole("button", { name: "Delete chef" }).click());
    kept.unmount();
    await waitFor(() => expect(kept.notified).toHaveBeenCalled());
    expect(kept.notified.mock.calls).toEqual([
      [{ tone: "bad", text: expect.stringMatching(/^Created chef, but these aren't as you chose: Skill recipes\. It wasn't deleted: /), open: "chef" }],
    ]);
    expect(kept.done).not.toHaveBeenCalled();
  });

  it("says how many of the chosen items it has applied so far", async () => {
    const { server, user, done } = await open();
    let go = () => {};
    server.toolsetGateBeforeWrite = new Promise<void>((r) => (go = r));
    await named(user);
    const tools = within(dialog()).getByRole("group", { name: "Tools" });
    await user.click(within(tools).getByRole("radio", { name: "Choose" }));
    const terminal = await within(tools).findByLabelText(/Terminal & Processes/);
    const boxes = within(tools).getAllByRole("checkbox");
    await user.click(terminal);
    await user.click(create());
    // Every toolset before Terminal is already as chosen; Terminal's change waits.
    const count = await within(dialog()).findByRole("status");
    await waitFor(() => expect(count.textContent).toBe(`${boxes.indexOf(terminal)} of ${boxes.length} done…`));
    expect(count.parentElement!.textContent).toBe(` Created. Applying the skills and tools you chose, then reading them back: ${count.textContent}`);
    go();
    await waitFor(() => expect(done).toHaveBeenCalled());
  });

  it("sends nothing more once Hermes stops answering mid-apply, says so for the rest, and Try again still works", async () => {
    const { server, user, done } = await open();
    await named(user);
    const skills = within(dialog()).getByRole("group", { name: "Skills" });
    await user.click(within(skills).getByRole("radio", { name: "Choose" }));
    await user.click(await within(skills).findByLabelText(/git-helper/));
    await user.click(within(skills).getByLabelText(/recipes/));
    const tools = within(dialog()).getByRole("group", { name: "Tools" });
    await user.click(within(tools).getByRole("radio", { name: "Choose" }));
    await user.click(await within(tools).findByLabelText(/Terminal & Processes/));
    let down = false;
    server.restTap = (req) => {
      if (req.path === "/api/skills/toggle") down = true;
      if (down) throw new Error("Can't reach the Hermes dashboard: connection reset");
    };
    await user.click(create());
    const outcome = await within(dialog()).findByRole("list", { name: "Not applied" });
    const sent = server.restRequests.slice(server.restRequests.findIndex((r) => r.path === "/api/skills/toggle"));
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /api/skills/toggle", "GET /api/skills"]);
    const recipes = within(outcome).getByText("Skill recipes").closest("li")!;
    expect(recipes.textContent).toMatch(/Not tried\. Hermes didn't answer an earlier call, so nothing was sent for it: Couldn't tell whether git-helper was turned off: /);
    expect(recipes.querySelector('[translate="no"]')?.textContent).toMatch(/^Couldn't tell whether git-helper was turned off: /);
    expect(within(outcome).getByText("Tool Terminal & Processes").closest("li")!.textContent).toMatch(/Not tried/);
    expect(done).not.toHaveBeenCalled();
    server.restTap = undefined;
    await user.click(within(recipes).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(outcome).queryByText("Skill recipes")).toBeNull());
    expect(server.skills.disabled.chef?.has("recipes")).toBe(true);
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
  it("leaves Skills, Tools and MCP servers out of Edit", async () => {
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
          rephrase: () => ({ ask: async () => "x", model: async () => ({ provider: "p", model: "m" }) }),
          setup: { skills: hermes.skills, toolsets: hermes.toolsets },
          notify: () => {},
        }}
        row={row}
        rows={[{ name: "default" }, { name: "work" }]}
        lacking={() => false}
        returnTo={createRef()}
        onDone={() => {}}
        onClose={() => {}}
      />,
    );
    expect(within(dialog()).queryByRole("group", { name: "Skills" })).toBeNull();
    expect(within(dialog()).queryByRole("group", { name: "MCP servers" })).toBeNull();
    expect(server.restRequests.filter((r) => r.path === "/api/skills" || r.path === "/api/tools/toolsets")).toEqual([]);
  });

  it("shows only catalogue words: the form, a rewrite, chosen lists and what didn't apply", async () => {
    const p = pseudoLocale();
    const { server, user } = await open({ locale: p, seed: (s) => (s.skills.toggleRefusal = LOCKED) });
    const box = () => screen.getByRole("dialog");
    expect(untranslated(box())).toEqual([]);
    await user.type(within(box()).getByLabelText(p.profiles.form.name), "chef");
    await user.type(within(box()).getByLabelText(p.profiles.form.personaOptional), ROUGH);
    await waitFor(() => expect(within(box()).getByText(new RegExp(`Rewritten by`))).toBeTruthy());
    await user.click(within(box()).getByRole("button", { name: new RegExp(p.profiles.form.rephrase.generate.replace(/[⟦⟧]/g, ".")) }));
    await within(box()).findByRole("button", { name: p.profiles.form.rephrase.undo });
    expect(untranslated(box())).toEqual([]);
    await user.click(within(box()).getByRole("button", { name: p.profiles.form.rephrase.undo }));
    server.oneshotAnswer = " ";
    await user.click(within(box()).getByRole("button", { name: new RegExp(p.profiles.form.rephrase.generate.replace(/[⟦⟧]/g, ".")) }));
    await within(box()).findByRole("alert");
    expect(untranslated(box())).toEqual([]);
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
