// @vitest-environment jsdom
// Write with AI (PersonaAI.tsx) is a converted part (ADR 0100): rendered under the pseudo-locale, which marks each
// catalogue string, every word it shows, Hermes's failures for a missing sign-in included, comes from the catalogue.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { TitleModelUnavailable } from "../hermes/transport";
import { LocaleContext } from "../i18n/locale";
import { pseudoLocale, untranslated } from "../i18n/pseudo";
import { PersonaAI, usePersonaAI, type PersonaWriter } from "./PersonaAI";

afterEach(cleanup);

const p = pseudoLocale();

function Panel({ writer }: { writer: PersonaWriter }) {
  const ai = usePersonaAI(writer, true);
  return <PersonaAI ai={ai} writer={writer} text="" locked={false} onApply={() => {}} />;
}

it("words a suggestion and a missing sign-in only from the catalogue", async () => {
  const failures: unknown[] = [
    new TitleModelUnavailable("openrouter", "no key", "Text generation runs on openrouter, and Hermes on the server has no API key"),
    new TitleModelUnavailable("nous", "no sign-in", "Text generation runs on Nous Portal"),
  ];
  const writer: PersonaWriter = {
    profile: "work",
    model: async () => ({ provider: "openrouter", model: "deepseek/deepseek-v4-flash", followsMain: false }),
    ask: async () => {
      const f = failures.shift();
      if (f) throw f;
      return "# Scout";
    },
  };
  const user = userEvent.setup();
  const { container } = render(
    <LocaleContext value={p}>
      <Panel writer={writer} />
    </LocaleContext>,
  );
  await user.click(screen.getByRole("button", { name: p.personaAI.open }));
  await user.type(screen.getByLabelText(p.personaAI.notes), "calm");
  const write = () => screen.getByRole("button", { name: p.personaAI.write });

  await user.click(write());
  expect((await screen.findByRole("alert")).textContent).toBe(p.personaAI.failed(p.personaAI.noKey("work", "openrouter")));
  const notesBox = (container: Element) => [...container.querySelectorAll("textarea")].map((t) => t.value);
  const words = () => untranslated(container).filter((w) => !notesBox(container).some((v) => w.startsWith(v)));
  expect(words()).toEqual([]);

  await user.click(write());
  expect((await screen.findByRole("alert")).textContent).toBe(p.personaAI.failed(p.personaAI.signInNous("work", "hermes -p work auth add nous")));
  expect(words()).toEqual([]);

  await user.click(write());
  await screen.findByRole("button", { name: p.personaAI.apply });
  expect(words()).toEqual([]);
});
