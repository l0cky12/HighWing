// @vitest-environment jsdom
// Settings → General → Chats → Ask before messaging another bot (ADR 0226): on by default, kept on this computer as it
// is changed, and every word from the catalogue.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_PREFS_KEY, getUIPrefs } from "../hermes/uiPrefs";
import { LocaleContext } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import { AskFirstSettings } from "./AskFirstSettings";
import { SettingsSearching } from "./SettingRows";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const toggle = () => screen.getByRole("switch", { name: "Ask before messaging another bot" });

describe("Ask before messaging another bot", () => {
  it("starts on, and turning it off is kept on this computer", async () => {
    const user = userEvent.setup();
    render(<AskFirstSettings />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Bots");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await user.click(toggle());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(getUIPrefs().askFirst).toBe(false);
    expect(JSON.parse(localStorage.getItem(UI_PREFS_KEY)!).askFirst).toBe(false);
    await user.click(toggle());
    expect(getUIPrefs().askFirst).toBe(true);
  });

  it("shows a stored off choice", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 5, askFirst: false }));
    render(<AskFirstSettings />);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("shows only catalogue words under the pseudo-locale", () => {
    const p = pseudoLocale();
    render(
      <LocaleContext value={p}>
        <SettingsSearching.Provider value>
          <AskFirstSettings />
        </SettingsSearching.Provider>
      </LocaleContext>,
    );
    expect(screen.getByRole("switch", { name: p.bots.askFirst.name })).toBeTruthy();
    expect(untranslated(document.body)).toEqual([]);
  });
});
