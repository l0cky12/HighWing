# The chat list has two modes, Chats and Bots, and the owner picks one with a switch

> **Accepted.** It replaces ADR 0066's "Bot mode" decision: the chat list panel no longer follows the chat in the active pane. The rest of ADR 0066 (the Bots view, how a Bot Chat is found) and ADR 0194's row menu stand. The switch is `ModeSwitch` in `src/ui/Sidebar.tsx`, and the mode is `chatListMode` in `src/hermes/uiPrefs.ts`. Tested in `src/ui/bots.test.tsx`, `src/ui/chatListModesTranslated.test.tsx` and `e2e/features/chat-list-modes.e2e.tsx`, with screenshots in `docs/screenshots/chat-list-modes/`.

Bot mode (ADR 0066) showed the bots in the chat list panel only while a Bot Chat was open in the active pane. The owner asked for a layout that makes the bots and a profile's chats easier to use, and easy to switch between. Three things stood in the way:

- Getting to the bots took the rail's Bots button and then a bot. Getting back took New chat, or opening an ordinary chat. Nothing on the panel named the mode it was in or offered the other one.
- In bot mode the profile's own chats couldn't be reached without leaving it.
- The panel's header said the profile's id (`writer`) while the bot's row said its name (Quill), and the pane said "Bot Chat" without saying whose.

Four designs were built in the real app and compared: this one, and the first three options below.

## Decisions

- **The panel has two modes, Chats and Bots, and a switch at its top names both.** The switch is two tabs. A click picks one, and so do Left and Right on the focused tab. Ctrl+Shift+B flips the mode from anywhere and shows the panel when it is hidden.
- **The mode is the owner's pick, and it is kept.** It is a preference on this computer, like the collapsed sections, and a restart keeps it. Opening a chat, New chat and a profile switch leave it as it is. A launch still never reopens a Bot Chat (ADR 0066), so a launch in Bots mode shows the bots beside the profile's last ordinary chat.
- **The tab that isn't shown says what waits there.** Chats carries the shown profile's Inbox count. Bots carries how many bots in other profiles need the owner, or a mark while one of them is replying. The shown profile's own bot isn't counted, since its Bot Chat row says what it is doing, and neither is a bot hidden in Hermes.
- **Chats mode has the profile's Bot Chat as one row above its chats.** The row shows the bot's face, and Needs you, Replying or how long ago the bot was active. The Bot Chat still stays out of the sections and Search (ADR 0066): the row is a way to it, as its bot's row is.
- **Bots mode has the shown profile's chats under its bot.** They are its Pinned, Inbox and Working chats, up to five, then its newest Settled chats until there are three, and the chat each pane shows. "All N chats" under them picks Chats. So each mode reaches every chat of the profile shown, and neither has to follow the pane.
- **Bots mode keeps New chat and Search above the bots, and has no profile switcher.** The bots' rows switch profile. The rows are the ones bot mode had: no ⋯ button, and Chat, Settings and Delete on a right-click (ADR 0194). A row shows the bot's name and last message; its description is in the Bots view.
- **Chats mode names a bot in another profile that needs the owner.** A line under the switch shows the bot's face, "Scout needs you" and its Bot Chat's last message. A click opens that Bot Chat, after the same question as the bot's row asks. With more than one bot waiting, the line counts them, lists their names and picks Bots.
- **A profile is named by its bot.** The profile switcher leads with the bot's face and name, then the profile's id. The id is left out when the name is only the id made readable ("Hermes Chat" for `hermes-chat`). A Bot Chat's header and tab show its bot's name, and the message box says "Message Quill".
- **Alt+B opens the shown profile's Bot Chat, and from it goes back to the chat before.** The chat before is the one the owner left for that Bot Chat, whichever way they went to it. It is kept for this run only, and a profile switch forgets it.
- **A Hermes without Bot Mode has no switch.** Its panel is the chats alone, as before, and a stored Bots mode is ignored.

## Considered options

- **The bots always listed above the chats, with no modes.** Rejected. Five one-line rows cut each bot's last message to a few words, and the bots are every profile's while the chats under them are one profile's.
- **The bots in the profile switcher's menu, with the panel's header as the bot.** Rejected. Another bot is two clicks away, and a bot that is replying can't be seen without opening the menu.
- **The bots as faces in the rail.** Rejected. The rail holds the app's own actions (ADR 0001), a face has room for one letter, and two bots can share it.
- **Folding the Bots view into Bots mode**, with New bot, a search and the view's whole menu in the panel. Not done here. ADR 0194, accepted the same day, keeps the panel's rows to three menu entries with no ⋯ button and leaves the rest to the Bots view. It can be decided on its own.
- **Keeping bot mode following the pane, with the tabs as a label.** Rejected. Opening any chat would still throw the owner out of the bots, which is what they asked to change.
- **Forgetting the mode at a restart**, as ADR 0066 did. Rejected. The mode is now a choice the owner made, and the app comes back as they left it.

## Consequences

- Opening a Bot Chat from the Bots view, the Inbox or a tab no longer changes what the panel shows. The Bot Chat row in Chats mode, or the bot's row in Bots mode, is marked instead.
- There are two lists of the bots: Bots mode, to talk to them, and the Bots view, to make, pin, hide and clone them.
- With Bot Mode on, the panel's top is one row taller.
- Deleting the bot whose Bot Chat is open switches to `default` (ADR 0194) and leaves the panel in the mode it was in.
