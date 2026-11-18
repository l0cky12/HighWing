# The Bots view folds into Bots mode, and a bot opened there is a visit

> **Amended by [ADR 0204](0204-a-persona-is-edited-only-in-the-profile-form-and-write-with-ai-rewrites-it-in-place.md).** A bot's menu also has Edit persona…, after Settings, which opens Edit bot with focus in Persona.
>
> **Accepted.** It decides what ADR 0195 left open, "Folding the Bots view into Bots mode": the Bots view and the rail's Bots button that ADR 0066 added are gone. It changes one line of ADR 0066, "A bot in another profile switches the profile first, as the switcher does": from Bots mode that switch is now a visit. ADR 0194's menu gains Clone, Pin and Hide from ADR 0189's, and New bot (ADR 0164) moves above the bots. New bot, Reload and the menu are `useBotActions` in `src/ui/Bots.tsx`. The visit is `visit`, `visitBot` and `goHome` in `src/App.tsx`, and `Hermes.setVisitHome` in `src/hermes/transport.ts` keeps the next launch on the owner's profile. Tested in `src/ui/bots.test.tsx`, `src/ui/botsTranslated.test.tsx`, `e2e/features/bot-menu.e2e.tsx` and `e2e/features/chat-list-modes.e2e.tsx`.

The owner had two lists of the same bots: Bots mode in the chat list panel, to talk to them, and the Bots view from the rail, to make, pin, hide and clone them (ADR 0195). They asked for one. The rail's Bots button was to go, and the Bots tab was to make a new bot and read the bots again.

They also found that a bot opened from the Bots tab took their chats with it. On `default`, in Chats mode, they picked the Bots tab and clicked Waza. Back on the Chats tab, the list held Waza's chats and the profile switcher said Waza. They wanted to come back to `default`.

The app keeps one socket, for the profile shown (`Hermes.switchProfile`), and `Hermes.openBotChat` opens a Bot Chat only in that profile. So a Bot Chat in another profile can't open without switching to it. A second socket per bot would change the transport's one-profile model. This decision keeps the switch and makes it a visit the owner comes back from.

## Decisions

- **The Bots view and the rail's Bots button are gone.** Bots mode is the one list of the bots. Nothing else opened the view.
- **Bots mode has New bot and Reload above the rows**, as two icon buttons on the right of a row of their own. New bot opens the New profile form titled New bot (ADR 0164). It is off, with the reason, while the app isn't connected or once the server turns out to lack `POST /api/profiles`. Once the bot is made, the roster is read again, the new bot's row takes focus, and the toast says it was created. Reload reads the roster now and asks for the check of what is live, and is busy while the read runs. A read that fails, from Reload or from the 15-second poll, says why under the buttons until a read succeeds, and the bots read last stay shown.
- **A bot's menu has Chat, Settings, Clone, Pin, Hide and Delete.** Clone, Pin and Hide do what they did in the Bots view's menu (ADR 0189). What they did, or why they couldn't, shows in the toast, as for Settings and Delete (ADR 0194).
- **The view's search, its Open in Settings → Profiles entry and its description line aren't carried over.** The panel never had a search. Settings → Profiles is in Settings, and Settings in the menu is Edit bot. A bot's description is its name's tip, and its row's spoken label still says it.
- **The Bots tab's count is the one sign that a bot needs the owner.** It counts the bots in other profiles that need the owner (ADR 0195). The rail button's dot also counted the shown profile's own Bot Chat, whose row says so.
- **A bot in another profile opened from Bots mode is a visit.** The app switches to the bot's profile, as before. It also keeps `home`, the profile the owner's chats are on, and `before`, the chat the active pane showed. A second bot keeps the first `home`. The owner's own bot, the one in `home`, ends the visit there.
- **Chats and New chat go back home.** Picking the Chats tab, or Ctrl+Shift+B, switches back to `home` and opens `before` once home's list has it. A chat deleted or archived meanwhile leaves the New chat pane. New chat, from its buttons, Ctrl+N or the tray, switches back to `home` and opens the New chat pane there. Both ask first about an unsaved edit, as every profile switch does.
- **Anything else makes the bot's profile the owner's.** The profile switcher, a chat opened in another profile from the Inbox, search, a link or a notification, the pen on a bot in another profile, and Settings → Profiles' switch, a delete's among them, all end the visit where they go. So does an ordinary chat of the bot's profile on screen, however it opened, and All N chats under the bot. A visit whose `home` is deleted ends too. One whose `home` is renamed follows the new name.
- **The next launch opens on `home` while a visit lasts.** `Hermes.setVisitHome` remembers `home` as the profile to launch on, and a switch's list doesn't replace it. Once the visit ends, the profile shown is remembered again. The visit itself isn't kept.
- **The Chats-mode needs-you line and the Inbox still switch plainly.** Opening a bot from them picks its profile, as before.

## Considered options

- **A second socket for the bot's profile.** It would leave the owner's profile alone. Rejected for now: the transport, the outbox and the checks of other profiles all assume one profile shown, and a visit brings the owner back without that change.
- **Keep the visit across a launch.** Rejected: a launch never reopens a Bot Chat (ADR 0066), so it would open on the bot's profile with nothing of the bot on screen.
- **Ask on Chats whether to go back.** Rejected: the owner asked to come back, and every other way out is already a choice.
- **Keep the Bots view for its search and description.** Rejected: two lists of the same bots was what the owner asked to end.

## Consequences

- With Bot Mode on, the rail has one button fewer.
- A reply the owner started in a bot's Bot Chat keeps running in Hermes after Chats goes back home, and the Bots tab says the bot is replying (ADR 0195).
- The same bot opened from the needs-you line or the Inbox changes the profile the chats are on, and opened from Bots mode it doesn't. Where the owner opened it decides.
