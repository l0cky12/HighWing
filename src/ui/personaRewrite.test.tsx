// @vitest-environment jsdom
// Write with AI on Edit's Persona (ADR 0206, 0209), through the real transport against FakeHermes at `f0d94882`. What
// the owner sees, and what Hermes received: the rewrite only on a click, run as the profile edited, in the field with
// Undo, and nothing saved until Save. All data is synthetic.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeHermes } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { LocaleContext } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import type { WritingPick } from "../hermes/writingModel";
import { ProfileForm, type FormResult, type ProfilesWiring } from "./ProfileSettings";

beforeAll(() => {
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const ROUGH = "helps me plan meals, short answers, never orders groceries";
const REWRITTEN = "You are a meal-planning helper. Keep answers short. Never order groceries.";

type Options = {
  connected?: boolean;
  rephrase?: boolean;
  seed?: (s: FakeHermes) => void;
  locale?: ReturnType<typeof pseudoLocale>;
  writingPick?: WritingPick;
};

/**
 * Edit profile on `default` over a fake Hermes, wired as App wires it; `done` gets what the form finished with.
 * `reconnect` draws it again connected or not, with Write with AI wired only while connected, as App does.
 */
async function open({ connected = true, rephrase = true, seed = () => {}, locale, writingPick }: Options = {}) {
  const server = new FakeHermes();
  server.oneshotAnswer = REWRITTEN;
  seed(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  await hermes.sync();
  const row = (await hermes.manageProfiles.list()).find((r) => r.name === "default")!;
  const done = vi.fn<(r: FormResult) => void>();
  const at = { connected };
  const wiring = (connected: boolean): Omit<ProfilesWiring, "showTab"> => ({
    api: hermes.manageProfiles,
    inUse: "default",
    connected,
    unread: () => undefined,
    catalog: async () => [],
    busy: () => undefined,
    lostMessages: () => 0,
    jobCount: async () => 0,
    switchTo: async () => true,
    local: { pending: () => undefined, note: () => {}, clear: () => {}, renamed: async () => {}, deleted: async () => {} },
    copyText: async () => {},
    persona: hermes.persona,
    ...(rephrase &&
      connected && {
        rephrase: (p) => hermes.writingDesk(() => writingPick).writer(p, "persona"),
      }),
    makeBot: async () => ({ profile: "", visited: false }),
    botSetupOff: () => undefined,
  });
  const form = () => {
    const f = <ProfileForm wiring={wiring(at.connected)} row={row} rows={[{ name: "default" }]} lacking={() => false} returnTo={createRef()} onDone={done} onClose={() => {}} />;
    return locale ? <LocaleContext value={locale}>{f}</LocaleContext> : f;
  };
  const { rerender } = render(form());
  const reconnect = (c: boolean) => {
    at.connected = c;
    rerender(form());
  };
  await waitFor(() => expect(persona().disabled).toBe(false));
  return { server, hermes, done, reconnect, user: userEvent.setup() };
}

const dialog = () => screen.getByRole("dialog");
const persona = () => dialog().querySelector<HTMLTextAreaElement>("textarea.profile-soul")!;
const generate = () => within(dialog()).getByRole("button", { name: /Write with AI/ });
const save = () => within(dialog()).getByRole("button", { name: /Save changes/ });
const hintOf = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby")!)?.textContent;
const oneshots = (server: FakeHermes) => server.requests.filter((r) => r.method === "llm.oneshot");

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

  it("says why it can't run without a connection, without wiring, or with no model to write with", async () => {
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
    await waitFor(() => expect(hintOf(generate())).toBe("default has no model to write with. Pick a Writing model in Settings → Model."));
    await none.user.click(generate());
    expect(oneshots(none.server)).toEqual([]);
    expect(oneshots(off.server)).toEqual([]);
  });

  it("runs only on a click, as the profile edited on its pinned Text generation model, names that model, and rewrites the field in place", async () => {
    const { server, user } = await open();
    await user.type(persona(), ROUGH);
    await waitFor(() => expect(hintOf(generate())).toMatch(/^default writes with openrouter · deepseek-v4-flash, its Text generation model, pinned on the server\./));
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

  it("says why it failed and names the setting in words, with no link to open Settings behind the form, and keeps the persona as typed", async () => {
    const { user } = await open({ seed: (s) => s.signedOut.add("openrouter") });
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    const alert = await within(dialog()).findByRole("alert");
    expect(alert.textContent).toMatch(/^Hermes couldn't rewrite it: default's Text generation model is pinned on the server to openrouter.* Your persona is unchanged\./);
    expect(alert.textContent).not.toMatch(/sk-|api_key=/i);
    expect(persona().value).toBe(ROUGH);
    expect(within(alert).queryByRole("button")).toBeNull();
  });

  it("writes with the Writing model for a bot with no pin, copying it into the bot's config once", async () => {
    const pick = { provider: "nous", model: "hermes-5-70b" };
    const { server, user } = await open({ writingPick: pick, seed: (s) => (s.modelConfig.auxiliary.title_generation = { provider: "auto", model: "" }) });
    await user.type(persona(), ROUGH);
    await waitFor(() => expect(hintOf(generate())).toMatch(/^Your Writing model writes it: nous · hermes-5-70b\./));
    expect(server.configWrites).toEqual([]);
    await user.click(generate());
    await waitFor(() => expect(persona().value).toBe(REWRITTEN));
    expect(oneshots(server)[0].params).toMatchObject({ profile: "default", task: "highwing_writing" });
    expect(server.configWrites).toHaveLength(1);
    expect(server.oneshotCalls).toEqual([{ profile: "default", task: "highwing_writing", model: "hermes-5-70b" }]);
  });

  it("steers to the Writing model when the bot's own model can't write", async () => {
    const { user } = await open({
      seed: (s) => {
        s.modelConfig.auxiliary.title_generation = { provider: "auto", model: "" };
        s.signedOut.add("openrouter");
      },
    });
    await user.type(persona(), ROUGH);
    await waitFor(() => expect(hintOf(generate())).toMatch(/^No Writing model is set, so default writes with its own model: openrouter · glm-5.3-flash\./));
    await user.click(generate());
    const alert = await within(dialog()).findByRole("alert");
    expect(alert.textContent).toContain("default writes with its own model, openrouter · glm-5.3-flash, and Hermes couldn't use it for writing. Pick a Writing model in Settings → Model.");
    expect(within(alert).queryByRole("button")).toBeNull();
  });

  it("blocks Save only while asking, saves nothing before it, and saves the rewritten persona", async () => {
    const { server, user, done } = await open();
    const gate = hold(server);
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    expect(save()).toHaveProperty("disabled", true);
    expect(save().title).toBe("Wait for the persona's rewrite, or stop it, first.");
    await act(async () => gate.go());
    await waitFor(() => expect(persona().value).toBe(REWRITTEN));
    expect(server.souls.default ?? "").toBe("");
    expect(save()).toHaveProperty("disabled", false);
    await user.click(save());
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(server.souls.default).toBe(REWRITTEN);
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

  it("lets Save run again once a connection drops during a rewrite and comes back", async () => {
    const { server, user, done, reconnect } = await open();
    hold(server);
    await user.type(persona(), ROUGH);
    await modelReadDone();
    await user.click(generate());
    expect(save().title).toBe("Wait for the persona's rewrite, or stop it, first.");
    reconnect(false);
    reconnect(true);
    await modelReadDone();
    expect(within(dialog()).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(save()).toHaveProperty("disabled", false);
    await user.click(save());
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(server.souls.default).toBe(ROUGH);
  });

  it("is reached by Tab from the Persona label's row, before the field", async () => {
    const { user } = await open();
    persona().focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(generate());
  });
});

describe("Elsewhere", () => {
  it("leaves Skills, Tools and MCP servers out of Edit, and asks Hermes for neither skills nor toolsets", async () => {
    const { server } = await open();
    for (const name of ["Skills", "Tools", "MCP servers"]) expect(within(dialog()).queryByRole("group", { name })).toBeNull();
    expect(server.restRequests.filter((r) => r.path === "/api/skills" || r.path === "/api/tools/toolsets")).toEqual([]);
  });

  it("shows only catalogue words: the form, a rewrite and a failed one", async () => {
    const p = pseudoLocale();
    const { server, user } = await open({ locale: p });
    const box = () => screen.getByRole("dialog");
    await waitFor(() => expect(persona().disabled).toBe(false));
    expect(untranslated(box())).toEqual([]);
    await user.type(persona(), ROUGH);
    await waitFor(() => expect(within(box()).getByText(new RegExp(`writes with`))).toBeTruthy());
    await user.click(within(box()).getByRole("button", { name: new RegExp(p.profiles.form.rephrase.generate.replace(/[⟦⟧]/g, ".")) }));
    await within(box()).findByRole("button", { name: p.profiles.form.rephrase.undo });
    expect(untranslated(box())).toEqual([]);
    await user.click(within(box()).getByRole("button", { name: p.profiles.form.rephrase.undo }));
    server.oneshotAnswer = " ";
    await user.click(within(box()).getByRole("button", { name: new RegExp(p.profiles.form.rephrase.generate.replace(/[⟦⟧]/g, ".")) }));
    await within(box()).findByRole("alert");
    expect(untranslated(box())).toEqual([]);
  });
});

/** Holds every `llm.oneshot` answer until `go`. */
function hold(server: FakeHermes) {
  let go = () => {};
  server.oneshotGate = new Promise<void>((r) => (go = r));
  return { go: () => go() };
}

async function modelReadDone() {
  await waitFor(() => expect(hintOf(generate())).not.toBe("Checking which model would write it…"));
}
