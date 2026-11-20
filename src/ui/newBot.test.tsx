// @vitest-environment jsdom
// The name dialog behind New bot and New profile (NewBot.tsx, ADR 0231): the id line, Create, Skip's two choices,
// Cancel, the keyboard, a failed create, and a Hermes that runs no Bot setup. All data is synthetic.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NewBotHow } from "../hermes/newBot";
import { ProfileError, type ProfileRow } from "../hermes/profiles";
import { LocaleContext } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import type { BotSetupRefusal } from "../hermes/botSetupStart";
import { NewBot } from "./NewBot";

beforeAll(() => {
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
});
afterEach(cleanup);

const ROWS: ProfileRow[] = [{ name: "default", description: "" }, { name: "scribe", description: "" }];

function open({ off, copy = true, make }: { off?: BotSetupRefusal; copy?: boolean; make?: (name: string, how: NewBotHow) => Promise<void> } = {}) {
  const made = vi.fn<(name: string, how: NewBotHow) => Promise<void>>(make ?? (async () => {}));
  const copied = vi.fn<(id: string) => void>();
  const closed = vi.fn();
  const back = document.createElement("button");
  document.body.append(back);
  back.focus();
  render(<NewBot heading="New bot" list={async () => ROWS} off={off} returnTo={{ current: back }} make={made} onCopy={copy ? copied : undefined} onClose={closed} />);
  return { made, copied, closed, back, user: userEvent.setup() };
}

const dialog = () => screen.getByRole("dialog", { name: "New bot" });
const nameBox = () => within(dialog()).getByLabelText("Name") as HTMLInputElement;
const idLine = () => document.getElementById(nameBox().getAttribute("aria-describedby") ?? "")?.textContent;
const create = () => dialog().querySelector<HTMLButtonElement>(".confirm-actions .primary")!;
const skip = () => within(dialog()).getByRole("button", { name: /^Skip/ });

describe("The name dialog", () => {
  it("asks only for a name, with focus in it, and names the id Hermes's own clients will show", async () => {
    const { user } = open();
    expect(document.activeElement).toBe(nameBox());
    expect(within(dialog()).getAllByRole("textbox")).toHaveLength(1);
    expect(idLine()).toBeUndefined();
    await user.type(nameBox(), "Travel Buddy");
    await waitFor(() => expect(idLine()).toBe("Hermes's own apps and its command line call it travel-buddy."));
    expect(within(dialog()).getByText(/^Travel Buddy's chat opens next, and it asks you five short questions\./)).toBeTruthy();
  });

  it("gives a taken or reserved id the first free -2", async () => {
    const { user } = open();
    await user.type(nameBox(), "Scribe");
    await waitFor(() => expect(idLine()).toBe("Hermes's own apps and its command line call it scribe-2."));
    await user.clear(nameBox());
    await user.type(nameBox(), "Hermes");
    expect(idLine()).toBe("Hermes's own apps and its command line call it hermes-2.");
  });

  it("takes any name, even one with nothing Hermes keeps in an id", async () => {
    const { user, made } = open();
    await user.type(nameBox(), "日本語");
    await waitFor(() => expect(idLine()).toBe("Hermes's own apps and its command line call it bot."));
    await user.click(create());
    expect(made).toHaveBeenCalledWith("日本語", "setup");
  });

  it("makes the bot on Create or Enter, once, then closes", async () => {
    let finish = () => {};
    const { user, made, closed } = open({ make: () => new Promise<void>((r) => (finish = r)) });
    await user.type(nameBox(), "Ada{Enter}");
    expect(made).toHaveBeenCalledWith("Ada", "setup");
    expect(create().textContent).toContain("Creating…");
    await user.click(create());
    await user.keyboard("{Enter}");
    expect(made).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });

  it("won't make a bot with no name, and says why on Create", async () => {
    const { user, made } = open();
    await user.type(nameBox(), "   ");
    expect(create().getAttribute("aria-disabled")).toBe("true");
    expect(create().title).toBe("Name the bot first.");
    await user.click(create());
    await user.keyboard("{Enter}");
    expect(made).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with Hermes's words when the create fails, and Create works again", async () => {
    const fail = vi.fn(async () => {
      throw new ProfileError({ kind: "refused", status: 400, detail: "Disk full" });
    });
    const { user, closed } = open({ make: fail });
    await user.type(nameBox(), "Ada");
    await user.click(create());
    expect((await within(dialog()).findByRole("alert")).textContent).toBe("The bot wasn't made. Hermes refused it: Disk full");
    expect(closed).not.toHaveBeenCalled();
    await user.click(create());
    expect(fail).toHaveBeenCalledTimes(2);
  });

  it("offers Start blank and Copy a bot under Skip, each saying what it does", async () => {
    const { user } = open();
    expect(skip().getAttribute("aria-haspopup")).toBe("menu");
    await user.click(skip());
    const menu = screen.getByRole("menu", { name: "Skip the questions" });
    expect(skip().getAttribute("aria-expanded")).toBe("true");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.querySelector(".menu-label")?.textContent)).toEqual(["Start blank", "Copy a bot…"]);
    expect(items.map((i) => document.getElementById(i.getAttribute("aria-describedby")!)?.textContent)).toEqual([
      "Hermes's defaults and the model in use. No questions.",
      "Clone one of your bots under this name.",
    ]);
    expect(document.activeElement).toBe(items[0]);
  });

  it("Start blank makes the bot without the interview", async () => {
    const { user, made } = open();
    await user.type(nameBox(), "Ada");
    await user.click(skip());
    await user.click(screen.getByRole("menuitem", { name: /Start blank/ }));
    expect(made).toHaveBeenCalledWith("Ada", "blank");
  });

  it("Copy a bot hands Clone the id the name gets, or nothing when no name is typed yet", async () => {
    const { user, copied, made } = open();
    await user.type(nameBox(), "Scribe");
    await waitFor(() => expect(idLine()).toContain("scribe-2"));
    await user.click(skip());
    await user.click(screen.getByRole("menuitem", { name: /Copy a bot/ }));
    expect(copied).toHaveBeenCalledWith("scribe-2");
    await user.clear(nameBox());
    await user.click(skip());
    await user.click(screen.getByRole("menuitem", { name: /Copy a bot/ }));
    expect(copied).toHaveBeenLastCalledWith("");
    expect(made).not.toHaveBeenCalled();
  });

  it("has no Copy a bot where Clone isn't wired", async () => {
    const { user } = open({ copy: false });
    await user.click(skip());
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem")).toHaveLength(1);
  });

  it("closes only the Skip menu on Escape, then the dialog, with focus back where it was", async () => {
    const { user, closed, back } = open();
    await user.click(skip());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(skip());
    await user.keyboard("{Escape}");
    expect(closed).toHaveBeenCalledTimes(1);
    cleanup();
    expect(document.activeElement).toBe(back);
  });

  it("Cancel closes it and makes nothing", async () => {
    const { user, closed, made } = open();
    await user.type(nameBox(), "Ada");
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(made).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog", async () => {
    const { user } = open();
    await user.type(nameBox(), "Ada");
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog().contains(document.activeElement)).toBe(true);
    }
  });

  it("says why there's no interview where Hermes runs no Bot setup", async () => {
    open({ off: "tooOld" });
    expect(within(dialog()).getByText("This Hermes is older than 0.23.2, so the bot starts with Hermes's defaults and the model in use, and asks no questions.")).toBeTruthy();
    expect(within(dialog()).queryByText(/five short questions/)).toBeNull();
  });

  it("shows only catalogue words", async () => {
    const p = pseudoLocale();
    const user = userEvent.setup();
    render(
      <LocaleContext value={p}>
        <NewBot heading={p.bots.newBot} list={async () => ROWS} returnTo={createRef()} make={async () => {}} onCopy={() => {}} onClose={() => {}} />
      </LocaleContext>,
    );
    await user.type(screen.getByLabelText(p.bots.make.name), "Ada");
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("ada"));
    await user.click(screen.getByRole("button", { name: new RegExp(p.bots.make.skip) }));
    expect(untranslated(screen.getByRole("dialog"))).toEqual([]);
  });
});
