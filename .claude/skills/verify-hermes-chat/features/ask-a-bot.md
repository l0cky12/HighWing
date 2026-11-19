# Ask a bot

In a Bot Chat, typing `@` at the start of a word, or pressing the composer's `@` button, opens one menu with a **Bots** group above **Chats**. Bots lists every bot on the connection except the bot whose chat it is (each profile is a bot, so the stand-in's `work` shows as Work), each with its face, name, `@handle` and description; the default profile is `@hermes`. A bot matches when what is typed starts its handle or any word of its name, without folding accents. Enter or Tab picks the highlighted row. A bot becomes `@handle` and a space in the words, shown as a pill in its colour, and one Backspace takes the pill and that space out. A click on a bot's row does the same. A typed `@handle` is a pill too, in any case, when it ends at a space, the end of the words, or `.` `,` `?` `!` `:` `;` before one of those; `@bram.com` and `@ada's` are words, not pills. A chat picked from Chats is still a chip above the words (ADR 0165). In any other chat the menu lists chats only. The message still goes to the bot whose chat it is, as typed.

## Sub-features

- `at-bots-group`: `@` in a Bot Chat shows **Bots** above **Chats**, without this chat's bot.
- `at-button`: the `@` button ("Name a bot or reference a chat") opens the same menu.
- `at-match`: `@br` lists Bram only; `@zz` opens nothing.
- `at-pill`: Tab or Enter on a bot puts `@handle ` in the words as a pill and closes the menu.
- `at-pill-delete`: Backspace right after the pick takes out the pill and its space.
- `at-mouse-pick`: a click on a bot's row puts in the same pill, drawn at once.
- `at-pill-typed`: `@BRAM ` and `ask @bram.` are pills; `see @cleo.com` is not.
- `at-chat-chip`: a chat picked from Chats is a chip, and no pill shows.
- `at-ordinary`: in an ordinary chat `@` shows the Chats menu with no Bots group.
- `at-spanish`: with the interface in Spanish, the menu reads "Bots y chats" and the button "Nombrar un bot o citar un chat".

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
- **Match.** `$S/wd.mjs keys 'br'`. `$S/wd.mjs count '.cmd-option.bot'` is `1`, Bram. Clear the words (`$S/wd.mjs press Control+a`, `$S/wd.mjs press Backspace`), then `$S/wd.mjs keys '@zz'`: `$S/wd.mjs gone .cmd-menu`. Clear the words again.
- **Pill with Tab.** `$S/wd.mjs keys '@br'`, `$S/wd.mjs press Tab`. `$S/wd.mjs value 'textarea[data-composer]'` is `@bram ` and `$S/wd.mjs gone .cmd-menu`. `$S/wd.mjs wait '.inline-mark[data-mention=bram]'` shows the pill.
- **Backspace.** `$S/wd.mjs press Backspace`. The words are empty and `$S/wd.mjs gone '.inline-mark[data-mention]'`.
- **Pill with Enter.** `$S/wd.mjs keys '@cl'`, `$S/wd.mjs press Enter`. The words are `@cleo ` and nothing is sent: `$S/hv state` has no new message in `ada-bot`.
- **Chat chip.** `$S/wd.mjs keys 'and @rel'`, `$S/wd.mjs wait '[role=option]' "Release notes draft"`, `$S/wd.mjs press Enter`. The words are `@cleo and `, `$S/wd.mjs wait button "Referenced chat Release notes draft"` shows the chip, and `$S/wd.mjs count '.inline-mark[data-mention]'` is still `1`.
- **Pick with the mouse.** Clear the words, `$S/wd.mjs keys 'ask @br'`, `$S/wd.mjs click '.cmd-option.bot'`. The words are `ask @bram ` and `$S/wd.mjs wait '.inline-mark[data-mention=bram]'` shows the pill with no key pressed.
- **Typed pills.** Clear the words, `$S/wd.mjs keys '@BRAM see @cleo.com ask @bram.'`. `$S/wd.mjs eval 'return [...document.querySelectorAll(".inline-mark[data-mention]")].map(e => e.dataset.mention).join(",")'` is `bram,bram`: `@BRAM` and the last `@bram` are pills, and `@cleo.com` is not.
- **Hermes alone.** `$S/wd.mjs click '.bots-row[data-profile=bram] .bots-open'`, `$S/wd.mjs wait 'textarea[data-composer][placeholder="Message Bram"]'`, `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs keys '@hermes'`. `$S/wd.mjs count '.cmd-option.bot'` is `1`, Hermes `@hermes`. Clear the words, then go back with `$S/wd.mjs click '.bots-row[data-profile=ada] .bots-open'` and `$S/wd.mjs wait 'textarea[data-composer][placeholder="Message Ada"]'`.
- **The @ button.** `$S/wd.mjs click 'textarea[data-composer]'`, clear the words, then `$S/wd.mjs click button "Name a bot or reference a chat"`. The words are `@` and the same menu shows.
- **Ordinary chat.** `$S/wd.mjs click '[role=tab][data-mode=chats]'`, `$S/wd.mjs click button Archived4`, `$S/wd.mjs click '.row-open[data-chat=vpn]'`, type `@`. `$S/wd.mjs wait '[role=listbox][aria-label="Chats"]'` and `$S/wd.mjs count .cmd-group` is `0`. The button there is "Reference a chat".
- **Spanish.** `$S/wd.mjs press Control+,`, `$S/wd.mjs click button Appearance`, `$S/wd.mjs select select "Interface language" -- "Español"`, `$S/wd.mjs click button "Volver al chat"`, open Ada's Bot Chat, then `$S/wd.mjs click button "Nombrar un bot o citar un chat"` and `$S/wd.mjs wait '[role=listbox][aria-label="Bots y chats"]'`. The keys line reads "↑↓ para elegir · Intro o Tab para ponerlo · Esc para cerrar".

## Gotchas

- `wd.mjs fill` doesn't clear the composer. Clear it with `$S/wd.mjs press Control+a` and `$S/wd.mjs press Backspace`.
- Clicking a bot's row from another Bot Chat can fail once with "stale element reference" while the pane swaps. Wait for the composer (`wait 'textarea[data-composer][placeholder="Message Bram"]'`) and go on.
- Under `HV_BOTS=1` only Ada has an ordinary chat ("Release notes draft"), so only Ada's Bot Chat shows both groups. Bram's and Cleo's show Bots alone.
- The pill is drawn over the words, so `wd.mjs value` still reads `@bram `. Read the pill with `wd.mjs wait '.inline-mark[data-mention=bram]'`.
- While the menu is open on a word, the word shows as typed, not as a pill. Type a space or pick the row to see the pill.
