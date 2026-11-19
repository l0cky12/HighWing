# Bots message each other through Hermes's message_agent, which the owner turns on in Bots mode

> **Amended by [ADR 0228](0228-handed-off-work-shows-on-the-card-of-the-call-that-sent-it-from-hermess-records-only.md)** (#93). The answer is joined to the message that asked for it, by delivery id, and the "Messaged" card keeps Hermes's ack after a reload: it is read back from the call's stored row. The card also says what the ack says, and that Hermes reports nothing more until the answer. The rest of this ADR stands.

> **Accepted.** It changes one line of ADR 0066, "Bots talking to each other … needs nothing from this app": on a Hermes with no desktop app it needs a switch, and its rows need reading. It adds a third control to the row ADR 0203 put above the bots. It widens ADR 0175's Returned result to two more rows, and ADR 0189's `configureParams` to a delete. The parsers are `src/hermes/agentMessages.ts`. `agentMessaging` and `messagingStep` in `src/hermes/bots.ts` read and plan the switch, and `Hermes.setAgentMessaging` in `src/hermes/transport.ts` writes it. `returnedItem` in `src/hermes/returned.ts` reads the rows, `SentCard` and `ReturnedCard` in `src/ui/ChatPane.tsx` draw them, and `MessagingSwitch` in `src/ui/Bots.tsx` is the switch. Tested in `src/hermes/agentMessages.test.ts`, `src/hermes/agentMessages.transport.test.ts`, `src/hermes/bots.test.ts`, `src/hermes/botsTransport.test.ts`, `src/hermes/returned.test.ts` and `src/ui/botMessaging.test.tsx`.

The owner runs two bots on a headless Hermes gateway, with no official Hermes desktop app. They wanted one bot to message the other, and both Bot Chats to show the message in Highwing.

Hermes 0.23.2 already delivers such a message by itself. A bot calls its `message_agent` tool, Hermes queues the message for the other bot's Bot Chat, runs that bot's turn, and wakes the sender with the answer. It finishes with no client attached. This was run against a real 0.23.2 with two profiles, and the stored rows are the tests' fixtures.

Two things stood in the way:

- **Hermes offers the tool only on a Bot-Mode-managed install.** `message_agent_authorized` (`tools/bot_mode_dm.py`) wants a session titled exactly "Bot Chat", and `is_bot_mode_managed` (`tools/bot_mode_probe.py`) wants any profile whose `profile.yaml` has a `ui_meta['hermes-bots']` mapping, empty or not. Hermes's desktop app writes that block. A headless install has none, so the tool is absent. A pin, a hide or a name set from this app writes a block too (ADR 0189), so those already turned the tool on for every bot, and nothing said so.
- **This app showed the rows badly.** The answer came back as a Returned result titled with the delivery runner's command line, over a JSON log. The recipient's row has `display_kind: "internal_notification"`, which nothing read, so a bot's message showed in a bubble as if the owner had typed it.

## Decisions

- **Bot messaging is a switch in Bots mode, "Bots message each other".** It sits at the start of the row that holds New bot and Reload (ADR 0203), because it holds for the whole install, as they do. Its tip says that turning it on adds Hermes's instructions for it to every Bot Chat's prompt.
- **Its state is read from the roster and kept nowhere.** `agentMessaging` applies Hermes's own rule to `profiles.list`: on when any profile has a Bot Mode block. Each bot carries what its block holds: `none`, `empty` or `held`. The switch shows what the roster says, so it changes only once a save's read-back has landed.
- **On writes one empty block to the default profile, by compare-and-swap.** The default profile can't be deleted, so a deleted bot never takes messaging with it. An empty block alone opens Hermes's gate (tested on 0.23.2).
- **Off deletes only empty blocks.** `profiles.configure` with `"hermes-bots": null` deletes the key under the same revision check, and the revision survives the delete (`_configure_ui_meta`, `tui_gateway/methods_profiles.py`). A block that holds anything is never deleted. While one exists, messaging stays on, the switch's tip names the bots that keep it on, and turning it off says so and sends nothing.
- **The write is a pure step and a loop.** `messagingStep` answers `done`, `write`, `kept` or `noCheck` from rows read just now. `Hermes.setAgentMessaging` reads, steps and sends, and steps again when Hermes reports a conflict, up to three times. Taken again on the state it produced, the step answers `done`. An Off that stops between two deletes leaves messaging on, and the next Off deletes the rest.
- **The switch is off, with the reason, when it can't work.** That is while the app isn't connected, once the server turns out to lack `profiles.configure`, and on a Hermes that says it is older than 0.21.6, the oldest release checked that has `message_agent` (every tag from v0.21.6 to v0.23.2 has it and the same gate). A Hermes that names no version, as a git checkout does, isn't treated as older.
- **A `message_agent` call is a "Messaged @x" card.** The tool's name decides. The card leaves the tool group and shows the message as Markdown. It carries the call's id, so Jump to call and the Run view still find it. A call that withdraws a request (`cancel`) stays a tool row. Hermes's answer to the call, "Queued" or why it wasn't sent, shows while the app holds it. History leaves most tool results out, so after a reload the card shows the message alone.
- **An `internal_notification` row is a Returned result from a teammate.** Hermes signs the message `Message from 🤖 <name> (@<handle>): <text>`, and the card is headed "Message from <name> (@<handle>)". A notice with no signature is headed "From Hermes". The display kind decides, so the row never shows as the owner's, and the same words typed by the owner stay the owner's. The signature is read only inside a row Hermes already marked.
- **A `process_complete` row whose output is a delivery's answer is a Returned result headed with Hermes's own sentence**, such as "@quill answered.", with the reply under it as Markdown. Only the JSON the delivery runners print counts: `outcome` with `delivery_id` and `status`, or with `replies`, `settled` and `of` for a message to several teammates. When no reply came back, Hermes's sentence is the card's body.
- **Both are a field on the Returned result, `agent`, and not new kinds of item.** A Returned result already begins a turn the owner didn't type, has no Regenerate, is read back by its row, and is shown live for a turn Hermes starts by itself. The two new rows need all of that and get it without a change to any of those rules.
- **The Saved copy keeps `agent`.** A JSON export writes the row back as Hermes stored it, the signature or the runner's output, so it imports as the same card. A Markdown export keeps the text, with the sender in the title's place.
- **Hermes's footer for the model is taken off every Returned result.** The gateway appends `[INTERNAL NOTIFICATION — …]` after a notice. It was showing at the end of process cards.
- **Every new word is in the catalogue** (ADR 0100), and `src/ui/botMessaging.test.tsx` runs the switch and the cards under the pseudo-locale.

## Considered options

- **New kinds of item for a bot's message and its answer.** Rejected: every rule about what begins a turn would need the new kinds added by hand, and the first one missed drops a card.
- **Match the text, as Hermes's desktop does.** It tests every user row against the signature. Rejected: an owner who pastes "Message from 🤖 …" would be shown as a bot, and ADR 0175 already chose the display kind over the text.
- **A stored "messaging on" setting that the app syncs to Hermes.** Rejected: it disagrees with Hermes the moment a pin or Hermes's desktop writes a block.
- **Off deletes every block.** Rejected: it would erase names, colours, pins and what Hermes's desktop keeps there, which ADR 0189 forbids.
- **Turn on by writing a block on the sender, or on every profile.** Rejected: Hermes's gate holds for the whole install, so a per-bot write buys nothing, and writing every profile leaves Off unable to tell its own blocks from the owner's.
- **The switch in each bot's menu, or in Settings → Profiles.** Rejected: a per-bot entry suggests a per-bot effect, and Settings is far from the bots.
- **This app relays the message.** Rejected by the owner: Hermes delivers durably with no client attached, and a relay would stop when the app closes.

## Consequences

- Pin, Hide, and a name or colour from Edit bot now visibly keep messaging on. Before, they turned it on without saying so.
- An empty block on the default profile makes Hermes's desktop treat the install as Bot-Mode-managed, which is what on means in Hermes.
- Off reaches a running Bot Chat at once. A Bot Chat already running still lists the tool, and Hermes refuses the call with "This install is not Bot-Mode…" (tested on 0.23.2).
- The answer card names the teammate only through Hermes's sentence. The app doesn't join it to the call that sent the message, because history drops the call's result.
- The card shows the name Hermes signed, which is the bot's Bot Mode title, then its profile's display name, then its handle. The default profile's handle is `hermes`.
- A notice that completes several processes at once is still shown as one log, a delivery's answer among them.
- No new request is sent to Hermes. Reads are `profiles.list` and writes are `profiles.configure`.
