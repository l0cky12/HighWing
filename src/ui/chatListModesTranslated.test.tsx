// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { BOT_CHAT_TITLE } from "../hermes/bots";
import { FakeHermes, row } from "../hermes/fakeHermes";
import { memoryCache } from "../hermes/memoryCache";
import { connect, type Hermes } from "../hermes/transport";
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
const nowS = () => Date.now() / 1000;

type Live = { id: string; session_key: string; status: "waiting" | "working"; last_active: number };

async function launch(live: Live[]) {
  const server = new FakeHermes();
  server.sessions = [row("disk", 0.5, { pinned: true, title: "Disk usage" }), row("old", 3, { title: "Old notes", last_read_at: nowS() })];
  server.otherProfiles = {
    scribe: [row("scribe-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true })],
    ops: [row("ops-bot", 0.01, { title: BOT_CHAT_TITLE, hidden: true })],
  };
  server.transcripts = { "scribe-bot": [{ role: "assistant", text: "Release notes drafted." }], "ops-bot": [{ role: "assistant", text: "Deploy is waiting." }] };
  server.profileMeta = { scribe: { ui_meta: { "hermes-bots": { title: "Scribe" } } }, ops: { ui_meta: { "hermes-bots": { title: "Ops" } } } };
  server.seedThread("scribe", "Changelog wording", { hours: 5 });
  server.liveSessions = live;
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(
    <LocaleContext value={p}>
      <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "lena@hermes-i18n", url: "", username: "lena" }} onSignOut={async () => {}} />
    </LocaleContext>,
  );
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  await act(async () => void (await hermes.checkOtherProfiles()));
  await waitFor(() => expect(panel().querySelector(".sb-needs-you")).toBeTruthy());
  return userEvent.setup();
}

const panel = () => document.querySelector<HTMLElement>(".sidebar")!;
const parts = (...sel: string[]) => sel.flatMap((s) => [...panel().querySelectorAll(s)].flatMap(untranslated));
const waiting = (key: string): Live => ({ id: `rt-${key}`, session_key: key, status: "waiting", last_active: nowS() });

it("shows only catalogue words in Chats mode with one bot that needs the owner", async () => {
  await launch([waiting("scribe-bot")]);
  expect(parts(".sb-mode", ".sb-needs-you-slot", ".sb-profile .profile-btn > *")).toEqual([]);
  expect(panel().querySelector(".sb-profile .profile-btn")!.getAttribute("aria-label")).toMatch(/^⟦.*⟧$/);
  expect(untranslated(document.querySelector("textarea[data-composer]")!)).toEqual([]);
});

it("shows only catalogue words for several bots that need the owner, in Bots mode with a bot's threads, and in a thread's and a Bot Chat's pane", { timeout: 30_000 }, async () => {
  const user = await launch([waiting("scribe-bot"), waiting("ops-bot")]);
  expect(parts(".sb-mode", ".sb-needs-you-slot")).toEqual([]);

  await user.click(panel().querySelector<HTMLElement>('[role=tab][data-mode="bots"]')!);
  await waitFor(() => expect(panel().querySelector(".bots-row")).toBeTruthy());
  expect(parts(".sb-mode")).toEqual([]);
  const scribes = () => panel().querySelector<HTMLElement>('.bots-threads[data-threads-of="scribe"]')!;
  await waitFor(() => expect(scribes().querySelector(".bots-threads-toggle")!.textContent).toMatch(/1/));
  await user.click(scribes().querySelector<HTMLElement>(".bots-threads-toggle")!);
  expect(scribes().querySelector(".bots-thread")).toBeTruthy();
  expect(parts(".bots-threads")).toEqual([]);
  await user.click(scribes().querySelector<HTMLElement>(".bots-thread-new")!);
  expect(parts(".bots-threads")).toEqual([]);
  await user.keyboard("{Escape}");
  await user.click(scribes().querySelector<HTMLElement>(".bots-thread-open")!);
  await waitFor(() => expect(document.querySelector(".chat-head .chat-title-topic")).toBeTruthy());
  expect(untranslated(document.querySelector(".chat-head .chat-title")!)).toEqual([]);

  await user.click(panel().querySelector<HTMLElement>('.bots-row[data-profile="scribe"] .bots-open')!);
  await waitFor(() => expect(document.querySelector(".chat-head .bots-face")).toBeTruthy());
  expect(untranslated(document.querySelector(".chat-head .chat-title")!)).toEqual([]);
  expect(untranslated(document.querySelector("textarea[data-composer]")!)).toEqual([]);
});
