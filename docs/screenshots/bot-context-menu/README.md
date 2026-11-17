# Bot mode's row menu: evidence

Evidence for ADR 0194: a right-click on a bot in the chat list panel's bot mode opens Chat, Settings and Delete.

## Where the screenshots come from

Every PNG here was taken by `shot()` in `e2e/features/bot-menu.e2e.tsx`. The e2e harness (`docs/e2e.md`) starts the whole app from `src/main.tsx` in headless Chromium at 1440×900, against a `FakeHermes` at the made-up address `https://hermes.example.net`, with an in-memory keyring. No real Hermes server, real bot or user data is involved. Every bot is seeded test data: Hermes (the built-in profile), Scribe ("Fake bot: writes release notes") and Scratch ("Disposable test bot"). Only Scratch is ever edited or deleted.

| File | State |
| --- | --- |
| `before-bot-mode.png` | Before the change: Scribe's Bot Chat open, the panel in bot mode. |
| `before-right-click-no-menu.png` | Before the change: right after a right-click on Scratch. No menu opens. |
| `after-right-click-menu.png` | The menu at the pointer: Chat, Settings, Delete (red). |
| `after-settings-editor.png` | Settings: Edit bot on Scratch, its description being edited. |
| `after-settings-saved.png` | The row shows the description read back from Hermes. |
| `after-delete-confirm.png` | Delete: the question naming `scratch`, with the name to type. |
| `after-deleted.png` | Scratch gone; Scribe still open and current. |

The BEFORE shots are from the same e2e test, run before any change to `src/`: it right-clicked Scratch, saved the shot, and failed at "Cannot find element with locator: … getByRole('menu', { name: 'More for Scratch' })".

## Reproduce

```sh
npm run e2e -- --feature bot-menu        # writes e2e/out/screenshots/bot-menu/*.png and e2e/out/summary.json
npx vitest run src/ui/bots.test.tsx --maxWorkers=1 -t "menu in the chat list panel"
npx vitest run src/ui/bots.test.tsx --maxWorkers=1 -t "picked last|puts focus|Delete on the open bot"
```

To see the review fixes fail without them, take a copy of `src/ui/Bots.tsx`, delete each `if (n !== opens.current) return;` and `key={dialog.row.name}` line, change `if (now && now !== document.body) return;` to `return;`, run the third command (four tests fail), then put the copy back.

## Results

- Before the change: the 8 new panel unit tests failed ("Unable to find … role "menu" and name "More for Scratch""), and the e2e feature failed 3/3.
- After: the panel and Bots view menu tests pass, and the e2e feature passes 3/3.
- Review fixes: with the fixes taken out, 4 tests failed (a late answer swapped in the wrong bot's dialog; focus was left on the page body after a rename or delete); with them, those tests pass.
