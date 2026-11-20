# A bot asks before it messages another bot unless the owner lets it, and the Messaged card opens that bot

> **Accepted.** Issue #92. Adds to [ADR 0207](0207-bots-message-each-other-through-hermess-message-agent-which-the-owner-turns-on-in-bots-mode.md). Code: `src/hermes/askFirst.ts`, `uiPrefs.askFirst`, `Hermes.deliver` in `src/hermes/transport.ts`, `typedPreview` in `src/hermes/branch.ts` (used by `botChatOf`), `AgentSend.handles` in `src/hermes/agentMessages.ts`, `teammateOf` in `src/hermes/bots.ts`, the chips in `SentCard` in `src/ui/ChatPane.tsx`, and `AskFirstSettings`. Tested in `src/hermes/askFirst.transport.test.ts`, `src/hermes/uiPrefs.test.ts`, `src/hermes/bots.test.ts`, `src/hermes/agentMessages.test.ts`, `src/ui/askFirstSettings.test.tsx` and `src/ui/botMessaging.test.tsx`.

In issue #92 a bot named Desk had no `computer_use`. Instead of saying so, it called `message_agent` to the `hermes-chat` bot, which then tried Desk's display and failed. The owner decided that when a bot can't do what was asked, it must not quietly send the job to another bot. By default it asks the owner first. A setting lets it send without asking. A message a bot sends to another bot is plain to see, with a way to open that bot.

Hermes can't enforce this. It offers `message_agent` in every session titled "Bot Chat" and has no approval gate for it, and its hooks can block a call but can't ask the owner. It already tells the model that "ask <name>" is a handoff (`tools/bot_mode_probe.py`, the "Messaging other agents" section), and never says to ask the owner first. So Ask first is an instruction, and a hard gate is a request to Hermes.

## Decisions

- **The setting is one boolean on this computer**, `uiPrefs.askFirst`, on by default, in Settings → General → Chats as **Ask before messaging another bot**. It isn't per connection or per bot: the wish is about how bots treat the owner, not about one server's profile names. It is the app's own instruction and nothing on the server holds it, so it doesn't conflict with ADR 0207 keeping server state out of Settings.
- **Every message the owner sends in a Bot Chat carries one of two rules**, after the Attached Context marker that both Hermes clients hide. On, the rule tells the bot to ask the owner before it uses `message_agent`, and says naming a bot, or asking for the handoff, is consent. Off, the rule says the owner lets the bot message another bot when that bot is better placed. Both end with "Messaging another bot never gives it your tools, your Bot Desktop or your screen", and both tell the bot to say what is missing when a tool it needs is off. The off rule is sent too, so turning the setting off overrides the on rule an earlier message left in the chat's history. Sending nothing when off would leave the old rule in force.
- **Every message, not only the first.** Compaction can drop an old rule, the owner can change the setting mid-chat and the newest rule must win, and a turn from another client carries nothing. Each turn costs about 110 tokens. A ledger like project context's would cost an entry per chat and a compaction rule to save a short block. The rule is a pure function of the chat's kind and the setting at send time (`askFirstBlocks`).
- **Bot Chat only.** `chatKind(chat) === "bot"` is the test Hermes's own gate applies. An ordinary chat gets nothing.
- **Not gated on Bot messaging being on.** The roster may be unread, and with messaging off Hermes injects no roster, so a rule that opens "If you have the message_agent tool" has nothing to offer.
- **The Bots-mode row preview drops the hidden block.** Hermes builds a bot's preview from its newest message, cut at 80 characters, without removing the marker. A short message would read "hi --- Attached Context --- [The owner's rule…" in the bot's row until the reply landed. `typedPreview` strips the marker and what follows, and the start of a marker the cut ended in, at the parse boundary in `botChatOf`. It also fixes the same leak project context had.
- **A Messaged card has an Open @x chip for each target that is a bot on this connection.** `AgentSend.handles` holds each target as the call named it. `teammateOf` matches `Bot.handle` exactly, because a peer or relay target is addressed as `peer/agent` and never equals a local handle (`remote_target_forms`, `tools/bot_mode_probe.py`). The chip starts the same Bot visit a row in Bots mode does. A peer or unknown target shows its handle as text. Replay and export views provide no `TeammatesContext`, so they have no chips.
- **Every new word is in the catalogue** (ADR 0100). The model-facing rules are English and stay in `askFirst.ts`, as `chatReferences.ts`'s preamble does.

## Considered options

- **Write the rule into each bot's persona or SOUL.md.** Every client would honor it. Rejected: it edits text the owner owns (ADR 0206), needs a copy per bot kept in step with the setting, and each edit changes the bot's capability fingerprint and rebuilds its Bot Chats.
- **Keep the policy in each bot's Bot Mode block.** Rejected: ADR 0207's Off deletes only empty blocks, so a policy key would make every block held and lock messaging on.
- **Catch the `message_agent` tool start and Stop the turn.** Rejected: by the time the event arrives, Hermes has queued the delivery, so Stop would kill the turn and still deliver. It would also work only while this app is attached.
- **Make Ask first a mode of the "Bots message each other" switch.** Rejected: Off there also stops bots from receiving messages.
- **A new "Handed to @x" card.** Rejected: it is a second way to show one Bot message.

## Consequences

- Ask first is advisory. A model can ignore it, and a message sent from Hermes's desktop app or command line doesn't carry it. The Messaged card shows any message that goes anyway, with its Open chip.
- About 110 tokens are added to every Bot Chat message sent from here.
- Hermes's desktop app shows the same row preview, so it shows the rule in its bot list. This app can't change that. An upstream request would ask Hermes to strip the marker from its preview and to put an approval gate on `message_agent`.
- Tests that check the exact `prompt.submit` text of a Bot Chat message changed on purpose, and `npm run frames-diff` reports them.
- The off rule's last sentence stays in both modes, so turning Ask first off lets a bot message another bot but never lends it a screen.
