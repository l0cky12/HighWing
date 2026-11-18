# Group rooms

A Group room is 2 to 6 bots that Hermes drives in turns. The owner makes one in Bots mode, watches each whole reply arrive under its bot's name, and can speak at any time, which stops the queued turn so the bots answer the owner first. A strip above the message box says whose move it is: who is writing and who is next, a pause at 3 rounds with Continue (or Carry on, on a Hermes without Continue), or a command waiting for approval.

## Sub-features

- `rooms-create`: New room, pick bots in the order they answer, the prefilled name, Create, and the room open in place of the chat.
- `rooms-turns`: a message, each bot's whole reply in turn, the strip naming who is writing and who is next, and the Round rule.
- `rooms-step-in`: a message sent while bots talk cancels the queued turn, and the bots answer it first.
- `rooms-pause-continue`: the pause after 3 rounds, Continue, and the next 3 rounds.
- `rooms-pause-carry-on`: on `HV_ROOMS_BUILD=bf0203a`, no Continue; Carry on fills the message box and sends nothing.
- `rooms-approval`: a bot's command waits in the strip with Approve once and Deny, and the bot goes on once approved.
- `rooms-clarify`: a bot inside `clarify` shows as stuck, with Stop, until Hermes moves on.
- `rooms-needs-you`: a room that needs the owner shows on its row, on the Bots tab while Chats shows, and in the Rail inbox.
- `rooms-mentions`: typing `@` lists the room's bots (face, name, `@handle`, description; Everyone last), Enter or Tab picks one, and a Goes to line under the composer says who Hermes will hand the message to, with a note for a trailing mark, a mention glued to a word, one in code, and a handle nobody has (ADR 0212).

## How to get to it (user POV)

- The chat list's **Bots** tab → **New room** (the two-people button beside New bot) makes one.
- The chat list's **Bots** tab → a row under **Group rooms** opens it.
- In Chats mode, the line "<room> needs you" under the tabs opens it.
- The Rail inbox's entry for a room opens it.

## Driving it with wd.mjs

Preconditions:

- `hv up` with `HV_ROOMS=1` (the bots Ada, Bram and Cleo), then signed in per [sign-in.md](sign-in.md).
- The stand-in's bots take their turns by themselves, 1.5 s apart (`HV_ROOM_DELAY_MS`). What they do follows the owner's words: `pingpong`, `approve`, `clarify`, or one round of short replies.
- `P='[data-room-pane]'` is the room's pane and `F='[data-room-pane] [data-floor]'` its strip.

- **Open Bots mode.** `$S/wd.mjs click '[role=tab][data-mode=bots]'`, `$S/wd.mjs wait button "New room"`. New room shows about 2 s after signing in, once the app has checked that this Hermes has rooms.
- **Create.** `$S/wd.mjs click button "New room"`, `$S/wd.mjs wait '[role=dialog]' "New group room"`, then `$S/wd.mjs click '[data-room-dialog] input[type=checkbox]' "Ada"`, the same for `"Bram"` and `"Cleo"`. `$S/wd.mjs text '[data-room-count]'` prints "3 of 6", `$S/wd.mjs value '[data-room-dialog] .room-name input'` prints "Ada, Bram and Cleo", and each picked row shows its number (`[data-seat-order]`). `$S/wd.mjs click button "Create room"`, `$S/wd.mjs gone '[role=dialog]'`, `$S/wd.mjs wait "$P" "Ada, Bram and Cleo"`. `$S/hv state` lists the room under `rooms` with `members: ["ada", "bram", "cleo"]`.
- **Turns.** `$S/wd.mjs fill "$P textarea" -- "pingpong please"`, `$S/wd.mjs press Enter`. `$S/wd.mjs wait "$F" "Ada is writing"`, then `$S/wd.mjs wait "$P .room-reply[data-seat=ada]" "Ada here, pingpong"`, `$S/wd.mjs wait "$P .room-reply[data-seat=bram]"`, `$S/wd.mjs wait "$P .room-round" "Round 2"`. Each reply appears whole. `$S/hv state` shows the same `message.member` events in the room's log.
- **Step in.** While the strip says a bot is writing: `$S/wd.mjs fill "$P textarea" -- "Owner here, stepping in"`, `$S/wd.mjs press Enter`, `$S/wd.mjs wait "$P .room-note" "you stepped in"`. The next reply answers the owner. `$S/hv state` shows a `turn.cancelled` with `reason: superseded_by_newer_user_event` after the owner's `message.user`.
- **Pause and Continue.** After a `pingpong` message, `$S/wd.mjs wait "$F" "Paused after 3 rounds" 30000`, then `$S/wd.mjs click "$F button" "Continue (5 left)"` and `$S/wd.mjs wait "$P .room-round" "Round 4" 15000`. `$S/hv state` lists `groups.continue` once in `roomCalls` and a `room.continued` event.
- **Pause and Carry on.** With `HV_ROOMS_BUILD=bf0203a`: after `pingpong`, `$S/wd.mjs wait "$F" "Say something to carry on" 30000`. `$S/wd.mjs click "$F button" "Carry on"`, then `$S/wd.mjs value "$P textarea"` prints "@bram @ada ". `$S/hv state` `roomCalls` holds no `groups.continue` and no new `groups.send`.
- **Approval.** `$S/wd.mjs fill "$P textarea" -- "approve the cleanup"`, `$S/wd.mjs press Enter`, `$S/wd.mjs wait "$F .approval" "rm -rf /srv/tmp/build-cache" 15000`. The strip is `[data-floor=approval]`. Wait half a second, `$S/wd.mjs click "$F .approval button" "Approve once"`, then `$S/wd.mjs wait "$P .room-reply[data-seat=cleo]" "ran it"`. `$S/hv state` lists `groups.approve` in `roomCalls`.
- **Clarify.** `$S/wd.mjs fill "$P textarea" -- "clarify what we drink"`, `$S/wd.mjs press Enter`, `$S/wd.mjs wait "$F" "asking through a tool a room can't show" 15000`. After 12 s the strip moves on and Bram's reply says it got no answer.
- **Needs you.** With an approval waiting, `$S/wd.mjs click '[role=tab][data-mode=chats]'`: `$S/wd.mjs wait '.sb-needs-you' "needs you"`, and the Bots tab's label reads "Bots, 1 needs you". `$S/wd.mjs click '.sb-needs-you'` opens the room. In Bots mode the room's row is `[data-room][data-floor=approval]`.
- **Mentions.** `$S/wd.mjs click "$P textarea"`, `$S/wd.mjs keys "@br"`, `$S/wd.mjs wait "$P [role=option]" "Bram"`. The textarea's `aria-activedescendant` names that row's `id`. `$S/wd.mjs press Enter`, and `$S/wd.mjs value "$P textarea"` prints "@bram ". `$S/wd.mjs keys "only you"`, then `$S/wd.mjs wait "$P .room-goes-to" "Goes to"` shows Bram. `$S/wd.mjs fill "$P textarea" -- "Thanks @bram. ok"` shows "everyone (no bot named)" and "won't reach Bram". Send, and `$S/hv state` shows the text unchanged in the room's `message.user`.
- **Mentions against a real Hermes.** `$S/mention-run <label>` does all of it from a fresh real Hermes (`$S/real-hermes up`) and a fresh app: sign in, a room of Ada, Bram and Cleo, then three cases, each checked on the Goes to line before Enter and in Hermes's own records after it (`$S/real-hermes turns <text> --expect <bots>`, which reads `hosted_room_driver_tasks` and `hosted_room_events` in `shared-state.db`). It exits non-zero on the first failed check. `RECORD=1` saves `flow.mp4` in the evidence. Evidence and logs go under `~/.cache/hermes-verify/mention-runs/<label>`.
- **No write probe.** `$S/hv state` `roomCalls` never holds `groups.capabilities`.

## Gotchas

- The Approval card ignores clicks for 400 ms after it appears. Wait before clicking, or the click does nothing.
- Without `HV_ROOMS=1` the stand-in has two bots (`default` and `work`), which is enough for a room of two but not for the recipes above.
- The stand-in pushes `groups.changed`, so the pane follows within a moment. With `HV_ROOMS_BUILD=bf0203a` nothing is pushed and the pane follows by polling every 2 s; raise `wait` timeouts by a few seconds.
- A room has no profile. Opening one leaves the profile switcher and the Chats list as they were.
- The first two bots of a `pingpong` room name each other, so a room made in another pick order pauses with different names in Carry on.
- `wd.mjs wait|gone` take `<css> [text] [ms]`: a timed wait with no text needs `""` in the text's place (`gone '[role=dialog]' "" 30000`), or the timeout is matched as text and `gone` returns at once (#60).
- The keyring toast after sign-in covers the room composer for 5 s. Wait for it to come and go (`wait .toast "system keyring"`, then `gone .toast "" 60000`) before clicking the composer.
- Against a real dashboard, bots answer with real model calls. A reply can take a minute, and what brings a teammate in depends on what the bots write.
