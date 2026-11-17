# Bot mode's rows open Chat, Settings and Delete on a right-click

> **Accepted.** It changes one line of ADR 0189: "The bots in the chat list panel have no menu." The rest of ADR 0189, and ADR 0066's bot mode, stand. The menu is `usePanelBotMenu` in `src/ui/Bots.tsx`, wired in `src/App.tsx`. Tested in `src/ui/bots.test.tsx` and `e2e/features/bot-menu.e2e.tsx`.

In bot mode (ADR 0066) the chat list panel shows the bots in place of the chats. A right-click on a bot there did nothing, while a right-click on a chat in the same panel opens that chat's menu. To edit or delete a bot the owner had to open the Bots view from the rail and use the row's menu there.

## Decisions

- **A right-click on any bot in the panel opens a menu with Chat, Settings and Delete**, in that order, through the app's own `Menu` (`src/ui/ChatMenu.tsx`): at the pointer, kept inside the window, and closed by Escape, a click outside, a scroll or the window losing focus. Shift+F10 and the Menu key open it on the focused row, as on a chat row, and focus goes back to the row when it closes. The bot the menu is for isn't opened or switched to until an entry is picked.
- **No ⋯ button on the panel's rows.** The panel's chat rows have none, and the panel is narrow. The Bots view keeps its ⋯ button.
- **Chat opens the bot as its row does**: the same question first when switching profiles would leave something behind, then `openBot` in `App.tsx`.
- **Settings is the Bots view's Edit bot** on that bot: the same `ProfileForm`, read from `GET /api/profiles` and `Hermes.botLook` when it opens, and saved through `Hermes.editBot` (ADR 0189). It isn't Settings → Profiles, and it is off only while the app isn't connected.
- **Delete is the Bots view's Delete bot**: Settings → Profiles' `DeleteProfile` question, which names the profile and asks for it typed. The bot stays in the list until Hermes says it is gone. `default` can't be deleted, and Delete is off with the reason while the app isn't connected or the server turned out to lack `DELETE /api/profiles/{name}`. Deleting the bot whose Bot Chat is open switches to `default` first, as the Bots view does.
- **The menu and its dialogs are drawn outside the panel.** Deleting the open bot switches profiles, which ends bot mode and removes the panel's rows. The question stays open and the delete finishes.
- **Only the entry picked last opens.** Settings and Delete read the profile from Hermes before their dialog opens, and two picks can be answered out of order. An earlier pick's answer, or its failure, arriving after a later pick is dropped, and each dialog is keyed by its profile, so a draft never moves to another bot. The Bots view's own menu had the same race and drops a stale answer the same way.
- **Focus follows the bot.** A dialog closed puts focus back on the row it was opened from. When that row is gone, once the roster is read again focus goes to the bot just saved (under its new name after a rename), else the open bot's row, the first bot's, or the profile switcher. Focus something else already took, such as the message box of the chat a delete switched to, stays there.
- **What an action did shows in the app's toast**, since the panel has no notes area: "Saved scratch.", "Deleted scratch.", or why the dialog couldn't open.

## Considered options

- **The Bots view's whole menu** (Edit bot, Clone, Pin, Hide, Open in Settings → Profiles, Delete bot). Rejected: the owner asked for the three actions, and the full menu is a click away in the Bots view.
- **Settings opens Settings → Profiles on the bot.** Rejected: it leaves the chat for a page about every profile. Edit bot changes the bot itself, in place.
- **Draw the dialogs inside the panel's list.** Rejected: deleting the open bot ended bot mode and took the question with it, so the profile was never deleted.

## Consequences

- Clone, Pin and Hide stay only in the Bots view's menu.
- The panel's rows and the Bots view's rows are the same `BotList`. `moreButton={false}` leaves out the ⋯ button, and `onMenu` passes the row's own open for Chat.
