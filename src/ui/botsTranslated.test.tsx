// @vitest-environment jsdom
// Bots mode is a converted screen (ADR 0100): every word in it, above its rows, in a row's menu, in Edit bot and in New
// bot comes from the catalogue. The app runs under the pseudo-locale, which marks each catalogue string, so a literal
// left in stands out. Bot names, descriptions and message previews are data, marked translate="no". The Clone dialog a
// row's menu opens isn't converted yet, and isn't opened here. All data is synthetic.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
const bots = () => document.querySelector<HTMLElement>(".sidebar .sb-bots")!;

it("shows only catalogue words above the bots, in their rows, a row's menu, Edit bot with a field changed elsewhere, Delete and New bot", { timeout: 30_000 }, async () => {
  const server = new FakeHermes();
  const ago = Date.now() / 1000 - 7200;
  server.sessions = [row("disk", 0.5, { pinned: true, title: "Disk usage" })];
  server.otherProfiles = {
    scribe: [row("scribe-bot", 2, { title: BOT_CHAT_TITLE, hidden: true, last_active: ago })],
    ops: [row("ops-side", 3, { title: "Deploy log", last_active: ago })],
    quiet: [row("quiet-bot", 4, { title: BOT_CHAT_TITLE, hidden: true, last_active: ago })],
  };
  server.transcripts = { "scribe-bot": [{ role: "assistant", text: "Release notes drafted." }], disk: [{ role: "user", text: "How full is the disk?" }] };
  server.profileMeta = {
    scribe: { description: "Writes release notes", ui_meta: { "hermes-bots": { title: "Scribe", color: "#44aa77", pinned: true } } },
    quiet: { ui_meta: { "hermes-bots": { hidden: true } } },
  };
  server.botAvatars = { scribe: "data:image/png;base64,iVBORw0KGgo=" };
  server.liveSessions = [{ id: "rt-s", session_key: "scribe-bot", status: "working", last_active: Date.now() / 1000 }];
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  running.push(hermes);
  render(
    <LocaleContext value={p}>
      <Main hermes={hermes} connection={{ mode: "ssh", sshTarget: "lena@hermes-bots-i18n", url: "", username: "lena" }} onSignOut={async () => {}} />
    </LocaleContext>,
  );
  await waitFor(() => expect(hermes.hasListed()).toBe(true));
  await act(async () => void (await hermes.idle()));
  await act(async () => void (await hermes.checkOtherProfiles()));
  const user = userEvent.setup();

  // An Approval waiting here, so a row in another profile asks first.
  await user.click(screen.getByText("Disk usage"));
  await waitFor(() => expect(hermes.getSnapshot().chats.find((c) => c.id === "disk")?.runtimeId).toBeTruthy());
  await act(async () => void server.askApproval(server.runtimeIdOf("disk")!));

  await user.click(document.querySelector<HTMLElement>('.sidebar [role=tab][data-mode="bots"]')!);
  await waitFor(() => expect(bots().querySelectorAll(".bots-row")).toHaveLength(3));
  await user.click(within(bots()).getByRole("button", { name: p.bots.hidden(1) }));
  expect(bots().querySelectorAll(".bots-row")).toHaveLength(4);
  expect(untranslated(bots())).toEqual([]);

  await user.click(bots().querySelector<HTMLElement>('.bots-row[data-profile="ops"] .bots-open')!);
  expect(within(bots()).getByRole("alertdialog", { name: p.bots.switchTitle("ops") })).toBeTruthy();
  expect(untranslated(bots())).toEqual([]);
  await user.keyboard("{Escape}");

  const menuOf = async (profile: string) => {
    await user.pointer({ keys: "[MouseRight]", target: bots().querySelector<HTMLElement>(`.bots-row[data-profile="${profile}"] .bots-open`)! });
    return screen.getByRole("menu");
  };
  // Default's menu says why it can't be deleted.
  const defaultMenu = await menuOf("default");
  expect(within(defaultMenu).getByText(p.profiles.builtInKept)).toBeTruthy();
  expect(untranslated(defaultMenu)).toEqual([]);
  await user.keyboard("{Escape}");

  const scribeMenu = await menuOf("scribe");
  expect(untranslated(scribeMenu)).toEqual([]);
  await user.click(within(scribeMenu).getByRole("menuitem", { name: p.bots.menu.settings }));
  const edit = await screen.findByRole("dialog", { name: p.bots.editTitle("Scribe") });
  expect(untranslated(edit)).toEqual([]);
  server.writeBotAsOtherClient("scribe", { title: "Quill", color: null });
  server.botAvatars.scribe = "data:image/png;base64,iVBORw0KGgoA";
  await user.type(within(edit).getByLabelText(p.profiles.form.botName), " II");
  await user.click(within(edit).getByRole("button", { name: p.profiles.form.colorClear }));
  await user.click(within(edit).getByRole("button", { name: p.profiles.form.pictureRemove }));
  await user.click(within(edit).getByRole("button", { name: new RegExp(p.profiles.form.save.replace(/[⟦⟧]/g, "\\$&")) }));
  expect(await within(edit).findByText(p.profiles.form.changedElsewhere("Quill"))).toBeTruthy();
  expect(within(edit).getByText(p.profiles.form.changedPicture, { exact: false })).toBeTruthy();
  expect(untranslated(edit)).toEqual([]);
  await user.click(within(edit).getByRole("button", { name: p.common.cancel }));
  expect(untranslated(edit)).toEqual([]);
  await user.click(screen.getByRole("button", { name: p.profiles.form.discard }));

  await user.click(within(await menuOf("scribe")).getByRole("menuitem", { name: p.bots.menu.delete }));
  const del = await screen.findByRole("alertdialog", { name: /scribe/ });
  await waitFor(() => expect(within(del).getByText(p.profiles.del.jobsCount(0))).toBeTruthy());
  expect(untranslated(del)).toEqual([]);
  await user.click(within(del).getByRole("button", { name: p.common.cancel }));

  await user.click(within(bots()).getByRole("button", { name: p.bots.newBot }));
  const made = await screen.findByRole("dialog", { name: p.bots.newBot });
  expect(untranslated(made)).toEqual([]);
  await user.keyboard("{Escape}");

  server.handlers["profiles.list"] = (r) => server.fail(r.id, -32000, "profiles are locked");
  await user.click(within(bots()).getByRole("button", { name: p.bots.reload }));
  expect(await within(bots()).findByRole("alert")).toBeTruthy();
  expect(untranslated(bots())).toEqual([]);
});
