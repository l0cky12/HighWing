// @vitest-environment jsdom
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
import { en } from "../i18n/en";
import { es } from "../i18n/es";
import { LocaleContext } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import { Main } from "../App";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
const running: Hermes[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const p = pseudoLocale();

it("shows only catalogue words in the picker and the Goes-to line, in every state it has", { timeout: 30_000 }, async () => {
  const server = new FakeHermes();
  const profiles = ["ada", "bram", "cleo"];
  server.sessions = [row("disk", 0.5, { pinned: true, title: "Disk usage" })];
  server.otherProfiles = Object.fromEntries(profiles.map((profile, i) => [profile, [row(`${profile}-bot`, i + 1, { title: BOT_CHAT_TITLE, hidden: true })]]));
  server.profileMeta = Object.fromEntries(profiles.map((profile) => [profile, { description: `${profile} helps`, ui_meta: { "hermes-bots": { title: profile[0].toUpperCase() + profile.slice(1) } } }]));
  server.groups.seed({ id: "crew", name: "Crew", members: profiles.map((profile) => ({ profile, name: profile[0].toUpperCase() + profile.slice(1) })) });
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(
    <LocaleContext value={p}>
      <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "lena@hermes-rooms-i18n", url: "", username: "lena" }} onSignOut={async () => {}} />
    </LocaleContext>,
  );
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  await act(async () => void (await hermes.capabilities.refresh()));
  const user = userEvent.setup();
  await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="bots"]')!);
  await waitFor(() => expect(document.querySelector('[data-room="crew"] .rooms-open')).toBeTruthy());
  await user.click(document.querySelector<HTMLElement>('[data-room="crew"] .rooms-open')!);

  const foot = () => document.querySelector<HTMLElement>("[data-room-pane] .room-foot")!;
  const composer = () => within(foot()).getByRole("combobox", { name: p.groupRooms.composer.label }) as HTMLTextAreaElement;
  const line = () => foot().querySelector<HTMLElement>(".room-goes-to")!;
  const typed = async (text: string) => {
    await user.clear(composer());
    await user.type(composer(), text);
  };
  const w = p.groupRooms.goesTo;

  await typed("@");
  expect(within(foot()).getByRole("listbox", { name: p.groupRooms.composer.handles })).toBeTruthy();
  expect(within(foot()).getByText(p.groupRooms.composer.everyoneAbout)).toBeTruthy();
  expect(untranslated(foot())).toEqual([]);

  await typed("hello team");
  expect(line().textContent).toContain(w.label);
  expect(line().textContent).toContain(w.nobodyNamed);
  expect(untranslated(foot())).toEqual([]);

  await typed("@cleo and @ada, compare");
  expect(untranslated(foot())).toEqual([]);

  await typed("@all and @ada please");
  expect(line().textContent).toContain(w.everyone);
  expect(untranslated(foot())).toEqual([]);

  const notes: [string, string][] = [
    ["Thanks @bram. Can you look?", w.trailing("@bram.", "Bram", ".")],
    ["mail x@ada please", w.glued("x", "@ada")],
    ["what is `@ada` here", w.inCode("@ada", "Ada")],
    ["run `@all` now", w.inCode("@all", w.everyone)],
    ["@quill hello", w.unknown("@quill")],
    ["@q1 @q2 @q3 @q4 @q5 end", w.more(2)],
  ];
  for (const [text, sentence] of notes) {
    await typed(text);
    expect(line().textContent, text).toContain(sentence);
    expect(untranslated(foot()), text).toEqual([]);
  }
});

it("has every Goes-to word and the Everyone row's line in Spanish", () => {
  expect(Object.keys(es.groupRooms?.goesTo ?? {}).sort()).toEqual(Object.keys(en.groupRooms.goesTo).sort());
  expect(es.groupRooms?.composer?.everyoneAbout).toBeTruthy();
});
