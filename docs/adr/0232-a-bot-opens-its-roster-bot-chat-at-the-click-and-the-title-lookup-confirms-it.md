# A bot opens its roster Bot Chat at the click, and the title lookup confirms it

> **Accepted.** Issue #91. Amends [ADR 0066](0066-a-bot-is-a-profile-and-its-bot-chat-is-found-by-title-every-time.md): a click no longer waits for `session.list` before the Bot Chat shows, and the panel no longer stays in bot mode with nothing open until the lookup answers.

Clicking a bot in another profile in Bots mode showed nothing tied to that bot for about a second. The owner switches between bots often, and each switch felt slow.

## Premise, measured

An instrumented build of the real app switched between bots on the owner's real Hermes, 8 times. Medians, from the click:

| Step | ms |
| --- | --- |
| New connection open (`switchProfile`, detach, reconnect, dial) | 451 |
| `GET /api/sessions` read, switch over | 629 (1,250 to 1,700 for the default profile, which has many chats) |
| Bot Chat lookup: `session.list` sent, answered | 634, 723 |
| Bot row current and header named | 750 |
| `session.resume` sent, answered | 766, 1,112 |
| Messages on screen | 1,167 |

The steps ran one after another for two reasons:

- The app started the title lookup only once the switch was over and the chat list was read. The lookup is a request on the socket, and the list is a REST read, so nothing made the lookup wait for the list.
- No pane opened on the Bot Chat until the lookup answered. But the bot's row already names that chat. `profiles.list` reports it as `canonical_session` (its `resolved_id` is the lineage's tip), and the roster is read again on each connection and every 15 seconds while the bots show. A Saved copy of the chat is on this computer from the last visit.

## Decisions

- **The roster's Bot Chat shows at the click** (`Hermes.showBotChat`). For a bot whose row names a Bot Chat, that chat goes beside the list, marked `bot`, and opens in the pane as soon as the shown profile is the bot's. That is at once, or after the Bot Desktop's screen is handed back when this app holds it. The header names the bot and its row is current in the first frame, over "Loading chat". The chat's Saved copy goes in a frame later, so a long one doesn't hold up the bot. A bot whose row names no Bot Chat shows nothing early, and opens after the lookup as before.
- **Nothing goes to that chat until the lookup confirms it.** Until the title lookup has found the chat shown early, it isn't resumed, marked read or sent to. A message sent meanwhile shows as sending and goes once the lookup confirms the chat. If the lookup finds another chat or fails, the chat shown early stays closed: nothing resumes there, and a message sent to it fails with why.
- **The title lookup still runs on every open, and decides.** It keeps every rule of ADR 0066: found by title, created only when there is none, fail closed, and 4022 opens the other client's chat. It now starts as soon as the connection is open for the bot's profile (`Hermes.connectedTo`), not after the chat list is read. When it finds the chat already shown, the chat resumes and nothing else changes on screen. When it finds another one, because the chat was compressed or replaced after the roster was read, the pane moves to the chat it found. The chat shown early is then taken back, unless a reply runs in it or it holds a message not yet sent.
- **A chat opens only on its own profile's connection.** A switch shows the new profile before the old profile's connection is let go, and a dial already under way can open the old profile's connection after the switch. `Hermes.open` treats a connection open for another profile as not connected, so it shows the Saved copy and resumes nothing there.
- **Everything else still waits for the list.** The pen's New chat and the way back from a bot visit wait for the switch and the list, as before.

## Measured after

`bench/bot-switch/run.sh` clicks each of the owner's four bots on the real Hermes, in the real app, and times the click to the bot shown (its row current and the header naming it), to its chat's messages shown, and to ready (connected, nothing loading). Each launch relaunches the app, clicks every bot once (first visit) and again (visited). The two builds took turns, a launch each, three launches each, so 12 switches per row. The app ran on the Hermes host itself, so no network sat between them, with a load average of 8 to 11:

| Build | Visit | Bot shown | Chat shown | Ready |
| --- | --- | --- | --- | --- |
| before | first | 985 ms (628 to 3,251) | 1,260 ms (753 to 3,251) | 1,734 ms |
| this | first | 83 ms (56 to 126) | 381 ms (194 to 847) | 1,483 ms |
| before | visited | 928 ms (658 to 3,120) | 1,263 ms (732 to 3,546) | 1,469 ms |
| this | visited | 62 ms (42 to 132) | 326 ms (118 to 663) | 1,381 ms |
| before | never opened here | 1,010 ms (828 to 2,597) | 2,161 ms (1,164 to 3,560) | 2,165 ms |
| this | never opened here | 92 ms (51 to 151) | 1,724 ms (1,244 to 2,408) | 1,988 ms |

Medians, with the range. "Never opened here" deletes every Saved copy before the launch, so the messages wait for the connection, the lookup and the history. Ready moved by less than its spread: it still waits for the connection, the lookup and the history, one after another.

## Considered options

- **Keep waiting for the lookup.** Rejected: the bot's chat is known at the click, and the measured second was spent waiting on steps that don't need each other.
- **Resume the chat shown early as soon as the connection opens, beside the lookup.** Rejected in review: with a stale roster, a message sent in that moment went to the older chat, and its reply ran there after the pane had moved on. Hermes answers one socket's calls in order, so waiting for the lookup costs one round trip.
- **Keep the Bot Chat id between opens.** Rejected for ADR 0066's reason: a kept id can dangle or point at another session. The id shown early is the one Hermes reported in its latest roster, it isn't kept anywhere, and the lookup still confirms it on every open.
- **Reuse the signed-in connection on a switch** (the existing `hermes_reopen`). Not done here. The new connection takes 451 ms of the measured time, and reusing it is a change of its own to the connection's lifecycle. It is left for later.

## Consequences

- A click on a bot that has been visited shows its name and its row as current at once, and its Saved copy a frame later. The lookup starts once the connection is open (451 ms in the measurements above), not after the list read, and the resume follows it.
- How long the Saved copy takes to draw depends on the chat. A Bot Chat of 186 messages took 0.5 to 0.7 s to draw, with no switch at all (ADR 0138 draws a chat of four chunks or fewer whole). That is the cost of opening any chat that long, and is left for later.
- A draft typed in the chat shown early is the same draft after the lookup, since drafts are kept by chat id.
- A reply running in the bot's Bot Chat is picked up when the chat resumes on the new connection, as before. Leaving a profile still leaves its replies running (ADR 0224).
- When the lookup fails, the pane keeps the chat the roster named, as its Saved copy only, and says why in a toast. Before, the pane stayed on New chat. Nothing is created either way.
- When the roster is stale, the pane shows the older chat's Saved copy until the lookup answers, then moves. A draft typed in it in that moment stays with that chat's id, and a message sent in it fails there, unsent.
