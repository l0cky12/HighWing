import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { row, type FakeHermes } from "../../src/hermes/fakeHermes";
import { UI_PREFS_KEY } from "../../src/hermes/uiPrefs";
import { boot, shot } from "../harness";

// A long Inbox, and Settled and Archived both full enough to want all of the foot (ADR 0199).
const seed = (s: FakeHermes) => {
  const read = Date.now() / 1000;
  s.sessions = [
    ...Array.from({ length: 24 }, (_, i) => row(`in${i}`, (i + 1) / 48, { pinned: true, title: `Inbox chat ${i + 1}`, last_read_at: read })),
    ...Array.from({ length: 12 }, (_, i) => row(`st${i}`, 2 + i, { title: `Settled chat ${i + 1}`, last_read_at: read })),
    ...Array.from({ length: 12 }, (_, i) => row(`ar${i}`, 3 + i, { archived: true, title: `Archived chat ${i + 1}`, last_read_at: read })),
  ];
};

const appDoc = () => document.querySelector<HTMLIFrameElement>("iframe[title=Highwing]")!.contentDocument!;
const selected = () => appDoc().querySelector(".row.sel .row-title")?.textContent;

// CSS sizes: the 1280×820 window at 200%, the smallest window (760×500), and the smallest window at 200%.
// The last is too short for the list's controls, rows and drawer headers together, so the list scrolls whole there.
for (const [width, height, name, scrollsWhole] of [
  [640, 410, "the default window at 200%", false],
  [760, 500, "the smallest window", false],
  [380, 250, "the smallest window at 200%", true],
] as const) {
  it(`keeps the Inbox's rows and both open drawers reachable in ${name}`, async () => {
    await page.viewport(width, height);
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 5, chatSectionsCollapsed: [] }));
    const { app } = await boot({ seed });
    await expect.element(app.getByRole("button", { name: /^Archived\s*12$/ })).toBeInTheDocument();
    await expect.element(app.getByRole("button", { name: /^Settled\s*12$/ })).toBeInTheDocument();

    expect(appDoc().querySelector(".sb-scroll")!.clientHeight, "two rows of the Inbox stay in view").toBeGreaterThanOrEqual(88);
    const list = appDoc().querySelector(".sidebar")!.getBoundingClientRect();
    for (const drawer of [".settled-drawer", ".archived-drawer"]) {
      const head = appDoc().querySelector(`${drawer} > .section-toggle`)!.getBoundingClientRect();
      const box = appDoc().querySelector(drawer)!.getBoundingClientRect();
      expect(box.height, `${drawer} keeps its whole header`).toBeGreaterThanOrEqual(head.height);
      if (!scrollsWhole) expect(head.bottom, `${drawer}'s header is in view`).toBeLessThanOrEqual(list.bottom);
    }
    await shot(`${width}x${height}`);

    for (const title of ["Inbox chat 1", "Settled chat 1", "Archived chat 1"]) {
      await app.getByRole("button", { name: new RegExp(`^${title}(?!\\d)`) }).click();
      await expect.poll(selected).toBe(title);
    }
  });
}
