# Ask a bot

In a Bot Chat, typing `@` at the start of a word, or pressing the composer's `@` button, opens one menu with a **Bots** group above **Chats**. Bots lists every bot on the connection except the bot whose chat it is (each profile is a bot, so the stand-in's `work` shows as Work), each with its face, name, `@handle` and description; the default profile is `@hermes`. A bot matches when what is typed starts its handle or any word of its name, without folding accents. Enter or Tab picks the highlighted row. A bot becomes `@handle` and a space in the words, shown as a pill in its colour, and one Backspace takes the pill and that space out. A chat picked from Chats is still a chip above the words (ADR 0165). In any other chat the menu lists chats only.

A message that names a bot is an **Ask** (ADR 0225). It goes to the named bot's own Bot Chat, in that bot's profile, and the bot whose chat it was typed in takes no turn. While the words name a bot, the chat being written in shows as a chip, "Bot Chat with <bot>", which the owner can remove. The chat it was sent from shows an **Asked @handle** card with the message, and the named bot's reply streams in under that bot's face and name. A message that names two bots shows two cards. The card says when the message waits for the connection or for a busy bot, wasn't sent, or may have been. It works with **Bots message each other** on or off. A card lasts while its chat stays on screen: a profile switch or a relaunch drops it, and the message and the reply stay in the named bot's Bot Chat.

## Sub-features

- `at-bots-group`: `@` in a Bot Chat shows **Bots** above **Chats**, without this chat's bot.
- `at-button`: the `@` button ("Name a bot or reference a chat") opens the same menu.
- `at-match`: `@br` lists Bram only; `@zz` opens nothing.
- `at-pill`: Tab or Enter on a bot puts `@handle ` in the words as a pill and closes the menu.
- `at-pill-delete`: Backspace right after the pick takes out the pill and its space.
- `at-chat-chip`: a chat picked from Chats is a chip, and no pill shows.
- `at-ordinary`: in an ordinary chat `@` shows the Chats menu with no Bots group.
- `at-spanish`: with the interface in Spanish, the menu reads "Bots y chats" and the button "Nombrar un bot o citar un chat".
- `ask-chip`: naming a bot adds the "Bot Chat with Ada" chip, and removing the pill takes it away.
- `ask-send`: the message goes to the named bot with Ada's chat referenced, Ada takes no turn, and the card shows the reply.
- `ask-no-chip`: with the chip removed, the message goes with no reference.
- `ask-two`: a message that names two bots sends twice and shows two cards.
- `ask-switch`: the same with **Bots message each other** on.
- `ask-busy`: a bot in the middle of a reply holds the message, the card says so, and the reply comes after.
- `ask-offline`: sent while offline, the card says it waits, and it goes on reconnect.
- `ask-failed`: a send Hermes turns down shows why with Retry, and Retry sends it.
- `ask-own-chat`: the named bot's Bot Chat shows the message and the reply as an ordinary turn.

## How to get to it (user POV)

- Bots tab, a bot's row, then type `@` in its Bot Chat's composer.
- The `@` button in the composer's bar of a Bot Chat.
- Settings → Appearance → Interface language for the Spanish words.

## Driving it with wd.mjs

Preconditions:

- `HV_BOTS=1 $S/hv up`, `$S/wd.mjs open`, and signed in per [sign-in.md](sign-in.md).
- Quote every selector that holds `[`. zsh treats an unquoted `textarea[data-composer]` as a glob.

- **Open Ada's Bot Chat.** `$S/wd.mjs click '[role=tab][data-mode=bots]'`, `$S/wd.mjs click '.bots-row[data-profile=ada] .bots-open'`, `$S/wd.mjs wait .chat-title "Bot Chat"`. The composer reads "Message Ada".
- **Bots above Chats.** `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs keys '@'`, `$S/wd.mjs wait '[role=listbox][aria-label="Bots and chats"]'`. Read it with `$S/wd.mjs eval 'return [...document.querySelectorAll(".cmd-menu .cmd-group, .cmd-menu [role=option]")].map(e => e.innerText.replace(/\n/g, " ")).join(" | ")'`: "Bots | H Hermes @hermes | W Work @work | B Bram @bram Reviews pull requests | C Cleo @cleo Watches the nightly jobs | Chats | Release notes draft". No `@ada` row.
- **Match.** `$S/wd.mjs keys 'br'`. `$S/wd.mjs count '.cmd-option.bot'` is `1`, Bram. In Bram's Bot Chat, `@hermes` lists Hermes alone. After `@` alone, `$S/wd.mjs keys 'zz'` closes the menu: `$S/wd.mjs gone .cmd-menu`.
- **Pill with Tab.** From `@br`, `$S/wd.mjs press Tab`. `$S/wd.mjs value 'textarea[data-composer]'` is `@bram ` and `$S/wd.mjs gone .cmd-menu`. `$S/wd.mjs wait '.inline-mark[data-mention=bram]'` shows the pill.
- **Pill with Enter.** Type `@cl`, then `$S/wd.mjs press Enter`. The words are `@cleo ` and nothing is sent: `$S/hv state` has no new message in `ada-bot`.
- **Backspace.** Right after a pick, `$S/wd.mjs press Backspace`. The words are empty and `$S/wd.mjs gone '.inline-mark[data-mention]'`.
- **Chat chip.** After the pill, `$S/wd.mjs keys 'and @rel'`, `$S/wd.mjs wait '[role=option]' "Release notes draft"`, `$S/wd.mjs press Enter`. The words are `@cleo and `, `$S/wd.mjs wait button "Referenced chat Release notes draft"` shows the chip, and `$S/wd.mjs count '.inline-mark[data-mention]'` is still `1`.
- **The @ button.** Clear the words, then `$S/wd.mjs click button "Name a bot or reference a chat"`. The words are `@` and the same menu shows.
- **Ordinary chat.** `$S/wd.mjs click '[role=tab][data-mode=chats]'`, `$S/wd.mjs click button Archived4`, `$S/wd.mjs click '.row-open[data-chat=vpn]'`, type `@`. `$S/wd.mjs wait '[role=listbox][aria-label="Chats"]'` and `$S/wd.mjs count .cmd-group` is `0`. The button there is "Reference a chat".
- **The chip.** In Ada's Bot Chat, `$S/wd.mjs keys '@bram what do you think?'`. `$S/wd.mjs wait button "Referenced chat Bot Chat with Ada, summary ready. Show the summary"`. Clear the words and `$S/wd.mjs gone button "Referenced chat Bot Chat with Ada"`.
- **Ask.** Type `@bram what do you think?`, wait for the chip to be ready, `$S/wd.mjs press Enter`. `$S/wd.mjs wait '.msg.returned.asked[data-to=bram][data-state=answered]' "" 20000`. `$S/wd.mjs text '.msg.returned.asked .returned-title'` is `Asked @bram`, `.asked-from` reads `BBram`, and `.msg.returned.asked .returned-body` is `Stand-in reply to: @bram what do you think?`. `$S/wd.mjs count '.msg.user'` is still `1`, the seeded message. `$S/hv state` shows `transcripts.bram-bot` ending with the user row, whose text holds `[Asked from: ada-bot]` and `[Referenced chat: Bot Chat with Ada]`, then the reply, and `transcripts.ada-bot` still with two rows.
- **No chip.** Type `@bram no thread`, `$S/wd.mjs click button "Remove the reference to Bot Chat with Ada"`, `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs press Enter`. The new user row in `transcripts.bram-bot` holds `[Asked from: ada-bot]` and no `[Referenced chat:`.
- **Two bots.** `@bram @cleo hi`, Enter. `$S/wd.mjs count '.msg.returned.asked[data-state=answered]'` grows by `2`, one `[data-to=bram]` and one `[data-to=cleo]`, and both `transcripts.bram-bot` and `transcripts.cleo-bot` gain the message.
- **The switch.** `$S/wd.mjs click '.sb-bots [role=switch]'`, wait for `[aria-checked=true]`, and ask again. The card and the reply show as before. Turn it off the same way.
- **Busy.** Start with `HV_LONG_REPLY=30 HV_BOTS=1 $S/hv up`. Open Bram's Bot Chat, send `long reply please`, and click Ada's row while it streams. In Ada's Bot Chat send `@bram when you are free`. `$S/wd.mjs wait '.msg.returned.asked[data-state=held]'` and its `.asked-note` reads "Bram is busy with another reply. Hermes gives it your message when that reply ends." Once the long reply ends, `$S/wd.mjs wait '.msg.returned.asked[data-state=answered]' "" 120000`.
- **Offline.** `. $HV_RUN/state.env`. Type the Ask and wait for the chip. `curl -s -X POST "$DASHBOARD_URL/__offline?on=1"`, `$S/wd.mjs wait button "Reconnecting"` or the status dot's "Offline", then `$S/wd.mjs click 'textarea[data-composer]'` and `$S/wd.mjs press Enter`. `$S/wd.mjs wait '.msg.returned.asked[data-state=waiting]'`: "You're offline. This goes to Bram when the connection is back." `curl -s -X POST "$DASHBOARD_URL/__offline?on=0"`. The app reconnects by itself within 16 s, or click the status dot. Wait for `[data-state=answered]`.
- **Failed and Retry.** `curl -s -X POST "$DASHBOARD_URL/__reject?message=Bram%27s+model+has+no+credentials"`, send the Ask, and `$S/wd.mjs wait '.msg.returned.asked[data-state=failed]'`: "Not sent to Bram. Bram's model has no credentials." `curl -s -X POST "$DASHBOARD_URL/__reject"` clears it. `$S/wd.mjs click '.msg.returned.asked[data-state=failed] button' Retry` and wait for `[data-state=answered]`.
- **Bram's own chat.** `$S/wd.mjs click '.bots-row[data-profile=bram] .bots-open'`, `$S/wd.mjs wait 'textarea[data-composer][placeholder="Message Bram"]'`. The last `.msg.user` reads `@bram what do you think?` with a "Referenced: Bot Chat with Ada" chip, and the reply follows it. No card shows there.
- **Spanish.** `$S/wd.mjs press Control+,`, `$S/wd.mjs click button Appearance`, `$S/wd.mjs select select "Interface language" -- "Español"`, `$S/wd.mjs click button "Volver al chat"`, open Ada's Bot Chat, then `$S/wd.mjs click button "Nombrar un bot o citar un chat"` and `$S/wd.mjs wait '[role=listbox][aria-label="Bots y chats"]'`. The keys line reads "↑↓ para elegir · Intro o Tab para ponerlo · Esc para cerrar".

## Gotchas

- `wd.mjs fill` doesn't clear the composer. Clear it with `$S/wd.mjs press Control+a` and `$S/wd.mjs press Backspace`.
- Clicking a bot's row from another Bot Chat can fail once with "stale element reference" while the pane swaps. Wait for the composer (`wait 'textarea[data-composer][placeholder="Message Bram"]'`) and go on.
- Under `HV_BOTS=1` only Ada has an ordinary chat ("Release notes draft"), so only Ada's Bot Chat shows both groups. Bram's and Cleo's show Bots alone.
- The pill is drawn over the words, so `wd.mjs value` still reads `@bram `. Read the pill with `wd.mjs wait '.inline-mark[data-mention=bram]'`.
- While the menu is open on a word, the word shows as typed, not as a pill. Type a space or pick the row to see the pill.
- A thread under a bot is not a Bot Chat, so its `@` menu has no Bots group.
- Press Enter only once the chip says "summary ready". Before that the message waits, with "Wait for the summary of Bot Chat with Ada, or remove it."
- The stand-in answers the summary with "A new title". On a real Hermes the Text generation model writes it.
- A card is gone after a profile switch or a relaunch. Check the result in the named bot's Bot Chat or with `hv state`.
- On a real Hermes (`real-hermes up`), Ada's Bot Chat starts empty, so the first Ask from it shows no chip. Send Ada a message first to get one.
