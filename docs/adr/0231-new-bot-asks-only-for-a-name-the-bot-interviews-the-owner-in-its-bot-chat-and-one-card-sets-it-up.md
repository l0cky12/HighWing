# New bot asks only for a name, the bot interviews the owner in its Bot Chat, and one card sets it up

> **Accepted.** Issue #85. The owner approved the design on 2026-11-19. It is built in steps after this record, and until New bot is switched over, New bot is still the form ADR 0164 and ADR 0197 describe. It supersedes [ADR 0164](0164-new-bot-in-the-bots-view-is-the-new-profile-form.md) except that New bot is still off while the app isn't connected and while the server lacks `POST /api/profiles`. Without Bot Mode, or below Hermes 0.23.2, a bot is made from the name and model only, with no interview. It supersedes [ADR 0197](0197-new-bot-rewrites-a-rough-persona-and-applies-chosen-skills-and-tools-read-back.md)'s New form and its "MCP servers stay out"; its stages, read-backs, Try again and Apply anyway carry over to the card. It changes one line each of [ADR 0066](0066-a-bot-is-a-profile-and-its-bot-chat-is-found-by-title-every-time.md) ("No intro is sent"), [ADR 0156](0156-profiles-are-managed-in-settings-renames-re-key-this-computers-data-and-deletes-forget-it.md) ("New profile is blank"), [ADR 0203](0203-the-bots-view-folds-into-bots-mode-and-a-bot-opened-there-is-a-visit.md) (New bot opens the form), [ADR 0206](0206-a-persona-is-edited-only-in-the-profile-form-and-write-with-ai-rewrites-it-in-place.md) and [ADR 0209](0209-a-writing-model-writes-personas-and-instructions-for-every-bot-the-server-hasnt-pinned.md) (Persona and Write with AI on New), and [ADR 0202](0202-settled-and-archived-are-one-archived-section-and-archive-settles-the-chat.md) ("No action hides a chat in every Hermes client"). It corrects [ADR 0074](0074-a-clone-is-a-fresh-profile-with-picked-parts-and-keys-only-by-opt-in.md)'s "The fresh profile gets Hermes's empty `.env`" for current Hermes. The Hermes facts it rests on are in `docs/research/hermes-gateway-api.md`, "Bot setup". **Extended by [ADR 0236](0236-bot-setups-card-sets-the-bots-picture-from-highwings-own-set-or-the-owners-upload.md):** the card also sets the bot's picture, from Highwing's own set or the owner's upload.

Making a bot meant one long form: name, description, model, persona, skills and tools (ADR 0164, ADR 0197). The owner wants one box. They type a name and press Create. The new bot's Bot Chat opens, and the bot asks five short questions there, one at a time. Then it posts one card with everything it proposes: a persona written from the answers, a description, the model, a colour, the owner's name to remember, and skills, toolsets and MCP servers, suggested or copied from other bots. The owner unticks or edits what they don't want and presses **Set it up**. This whole flow is **Bot setup**. GLOSSARY.md already uses Setup for connecting Highwing to a server.

## What Hermes does, read and probed at the deployed `ae2a81cc` (v0.23.2)

Every probe ran in a throwaway sandbox dashboard at that commit, with its own home under `/tmp`, its own address and a scripted stub model. Each throwaway profile was deleted through `DELETE /api/profiles`.

- **A brief sent as the first turn gets Hermes's first-contact note.** Each profile has its own `state.db`, so a new bot's first turn counts as the install's first message ever. Hermes then appends a note telling the model to introduce itself, mention `/help`, and offer to build a profile of the owner and save it to memory (`agent/onboarding.py`, `tui_gateway/prompt_turn.py`, from v0.21.6). A non-empty history turns the note off. Probed with a control: the unseeded first turn got the note, and the seeded one didn't.
- **Seeded rows can be hidden.** `session.create {messages}` stores rows that carry `display_kind: "hidden"` hidden (from v0.21.2). `prompt.submit {display_kind: "hidden"}` stores its user row hidden (from v0.20.4). `session.resume` leaves hidden rows out, and the stored rows keep them.
- **A Bot Chat follows its profile's toolsets and persona at the next turn.** Hermes fingerprints the profile at each turn's start and rebuilds the Bot Chat's agent when it changed, with the notice "Capabilities updated" (from v0.20.3). Probed in all four cases (Bot Mode block or none, reconnect or none): after a toolset and SOUL.md change, the next turn had the new tools and persona, and a new tool ran.
- **An MCP server added mid-chat is not reachable without `reload.mcp`.** Not by `tool_search`, not by `tool_call`, not after Hermes's own server test, and not after 75 seconds. `reload.mcp {session_id, confirm: true}` on the Bot Chat made it run there. It reconnects every MCP server in the dashboard process and clears the prompt cache. `tools.show` never lists MCP tools.
- **A deliberate archive frees the title "Bot Chat"** (`aa432bc55b`, first in v0.23.1). The title is cleared and the row unhidden, the title lookup comes back empty, a retitle works, and the next open makes a new Bot Chat. Unarchiving doesn't take the title back.
- **A fresh `POST /api/profiles` copies the launch profile's `.env` keys and model** (`mirror_credentials`, default true, first in v0.23.2; probed at `ae2a81cc`). Up to v0.23.1 a fresh profile gets no keys at all, so a new bot there has no credentials and its first reply fails. A model Hermes can't set still makes the profile and answers 200 with `model_error`.
- **MCP servers.** `GET /api/mcp/servers` shows env values half-masked (`secr...ue-1`). `MCPServerCreate` has no `enabled` field, so a server can't be added turned off. No catalog entry at `ae2a81cc` installs from git (0 of 66), so no catalog command points into a profile's folder today.
- **Profile ids.** `_suggest_profile_name` lowercases a name, turns each run of other characters into `-`, trims `-` and `_` from the ends, and answers `my-work` when nothing valid is left.

## Decisions

### Making a bot

- **New bot and Settings → Profiles' New profile ask for a name and nothing else.** The dialog has the name box, Create, Skip and Cancel. A faint line under the box names the id Hermes's own clients will show. The New profile form, `src/ui/BotCapabilities.tsx` and Write with AI on New are deleted. Edit bot and Edit profile stay as they are.
- **Any name is accepted, and the id is derived from it.** `profileIdFor(name, taken)` follows `_suggest_profile_name` exactly, except that it answers `bot` where Hermes would answer `my-work`. It adds `-2`, `-3`… when the id is taken or in `RESERVED_PROFILE_NAMES`. A golden test generated from Hermes's own function holds the two together.
- **Create sends `{name, provider?, model?}`.** The model is the profile in use's, sent only when that profile has one of its own. The body has no `soul` and no `description`. Create reads `model_error`, not the status, to tell whether the model was set. Right after, the typed name is written as the bot's name in Bot Mode with `Hermes.editBot` (ADR 0189).
- **Skip sits beside the name box, before the bot exists.** **Start blank** makes the bot with the profile in use's model, opens its Bot Chat empty, and sends no brief. **Copy a bot** is Clone profile with the name filled in (ADR 0074).
- **After Create the app is in the new bot's profile as a Bot visit** (ADR 0203), with its Bot Chat open.

### Starting the interview

- **The brief is seeded as a hidden row when the Bot Chat is made. It is not sent as the first hidden turn.** `session.create {messages: [{role: "user", content: <brief>, display_kind: "hidden"}]}` puts it in the history before any turn, so Hermes's first-contact note doesn't fire. That note's offer to save a profile of the owner to memory clashes with the brief's rule that nothing is saved before Set it up. A short hidden `prompt.submit`, the **begin** turn, then starts the bot's first reply. The app already seeds hidden rows for other chats (`src/hermes/sessionProtocol.ts`).
- **The brief** starts with a marker line that carries the setup's id. It holds the five questions word for word, in order, one per message, and nothing else asked before the card. It forbids running tools, saving memory, creating skills and changing settings before Set it up. It gives the card's block format with a required colour, and the inventory, tagged as data and capped in size. The bot may open with one short sentence saying who it is.
- **Starting is a small state machine read from the stored rows.** The brief row is in place before the begin turn, so finding the brief can't say whether the first reply ever started. On every open, and after any lost answer, the app reads the Bot Chat's stored rows and decides:

  | Stored rows say | The app does |
  | --- | --- |
  | No Bot Chat, or no brief row | Creates the Bot Chat with the brief seeded. A lost answer to the create is settled by the title lookup and a read of the rows, never by a second create. |
  | Brief row, no begin row | Reads the rows again, then sends the begin turn with the same id. |
  | Begin row, the session is running | Waits. The line says **Setup started**. |
  | Begin row, no reply after it, not running | Shows Hermes's error, or "no reply came", with **Try again**. Only the owner sends it again. The bot is kept. |
  | A reply after the begin row | Started. The interview carries on in the chat. |

  So two Creates, a lost create, a lost begin and a relaunch each end with one brief and one begin.
- **The hidden rows show as one Setup started line.** It is a `setup` field on a Returned result, as ADR 0207 did for Bot messages, not a new kind of item. No row is drawn as the owner's message, live or after a reload.
- **One version floor: 0.23.2.** That is the first Hermes whose fresh profile gets the launch profile's keys, so the new bot can answer at all, and the version every spike ran on. It is above every other fact the feature uses: hidden seeded rows (0.21.2), the first-contact note (0.21.6), and the archive that frees the title, which Start fresh needs (0.23.1). After the first brief, the app reads the stored rows back. When they aren't hidden, Bot setup turns off for that Hermes and Connection diagnostics says why. Below 0.23.2, and on a Hermes without Bot Mode, New bot (and New profile) makes the bot from the name and model only, with no interview (#85 owner decision 7). New bot stays off only while the app isn't connected or the server lacks `POST /api/profiles`.
- **Between Create and Set it up, nothing is written to the bot's profile** but its name in Bot Mode and the session's own calls.

### The card

- **The bot ends its card reply with a fenced block tagged `highwing-bot-setup` that holds JSON.** The app draws it as the card in a Bot Chat only. Anywhere else, and in other Hermes clients, it is a plain code block. The block carries names only. Every name is matched against what Hermes lists. A name Hermes doesn't list shows as not found and can't be ticked. Nothing in the block reaches Hermes as a command, a URL or a secret.
- **The newest valid block after the newest brief marker is the live card.** Older blocks fold away as earlier drafts. A block that doesn't parse shows "The bot's card couldn't be read" and a button that asks the bot to draw it again.
- **The card is the difference between the block and Hermes as read now** until Set it up. Each item has a tick and can be edited in place. An in-place edit is kept on a newer block that leaves the item alone or proposes the owner's value or one they chose it over. Any other value is the bot changing that item, and is a new offer.
- **The model row on a new bot's card shows greyed as "Already in use"** and is not counted in the ticked totals, unless the bot proposes a different model.
- **The owner's name goes to memory, not the persona.** The answer to "What should I call you?" is the card's **Remember** row. Hermes has no route that adds a memory entry, so the bot saves it with its own memory tool during the ready turn, only when the row is ticked. The row is applied once `MemoryApi.load` lists an entry with that name.

### Set it up

- **Set it up writes only ticked items, one at a time, each read back.** ADR 0197's rules carry over: each item ends applied, failed with the reason and Try again, waiting on a toolset caution with Apply anyway, or waiting on Connect. A call that got no answer fails its item, and every item after it fails as not tried, with no request sent.
- **Description and model are two items.** `ProfilesApi.edit` still sends the model after a failed description write, so Set it up writes them separately to keep the stop-after-a-lost-answer rule.
- **A setting changed elsewhere since the card was drawn isn't overwritten.** The persona is saved only if SOUL.md is still what the card read, and the colour is checked against the Bot Mode block's revision (ADR 0189).
- **Set it up ends with one hidden ready turn.** It tells the bot what was applied and that the interview is over. That turn is what refreshes the bot.
- **Toolsets and persona need no restart.** Hermes rebuilds the Bot Chat's agent at the ready turn by itself. The gateway is not restarted (ADR 0205), and no `session.close` and `session.resume` or compaction is used. The **Restart** row is applied once the Bot Chat's own `tools.show` matches the profile's toolsets, or once Hermes's "Capabilities updated" notice comes. `tools.show` is truthful only for the profile the dashboard runs as (ADR 0041). On any other bot the row says the bot restarted without claiming which tools are live.
- **MCP servers need `reload.mcp` on the Bot Chat.** It reconnects every MCP server in the dashboard process once, for every bot with an open chat, and clears the prompt cache. Set it up runs it only when no reply runs anywhere on this Hermes (`session.active_list`). Otherwise the MCP rows wait with a **Reload MCP servers** button. The row then says "Hermes reloaded it", not "confirmed", because `tools.show` doesn't list MCP tools and no call from the bot proves it.
- **What was accepted is recorded.** A card rebuilt from the block alone breaks once an item is edited in place. Say the persona is changed from A to B and B is applied. After a reload the block still says A, so the card would offer to write A over B. At Set it up the app records each item's tick and edited value under the card's id. The record rides in the hidden ready-turn row, so it is stored in Hermes. Until that row reads back, the record is kept on this computer, the way Queued messages are (ADR 0018). After Set it up, the card is diffed against the record, not the block.

### MCP servers on the card

- **A server's definition comes only from Hermes.** That is Hermes's catalog (`McpApi.install`, with the entry's commands shown first) or the source bot's list as Hermes reports it (`McpApi.list`).
- **A value read is never sent.** Hermes shows env values half-masked, so a copy that reused them would write the masked string as the secret. **Connect** asks for every env var and bearer token fresh, in write-only fields. The value is kept in the app's memory and sent only at Set it up. Leaving the card loses it.
- **A copy that points into the source bot's folder is refused, with the reason.** That is a copy whose command or arguments contain the source profile's path. A git install would clone under that profile's `mcp-installs`. No catalog entry does that today, and the guard is kept for when one does.
- **OAuth servers stay off the card in v1.** Hermes signs in to a server only after it exists, and a server can't be added turned off: `MCPServerCreate` has no `enabled` field, and the relay refuses one (`create_allowed` in `src-tauri/src/mcp.rs`). The card names such a server and points to Settings → MCP servers.
- **Not copied, and said on the item:** a server a plugin provides, a server whose name the app can't send, and a server's tool filter, which Hermes lists but v1 doesn't copy, and its timeout and extra headers, which Hermes doesn't list.

### Set up again

- **A bot's menu has Set up again.** It first asks **Keep history** or **Start fresh**. The brief then tells the bot to describe how it is set up now and ask what to change, not to repeat the five questions. The current setup comes from the app's own reads of Hermes. The card shows before → after, with "before" read from Hermes, and unchanged items fold under "N more that don't change".
- **Keep history** seeds nothing. It sends the brief into the existing Bot Chat as a hidden turn, and its messages and the bot's memory stay. The brief's last line is then the begin line, so the stored rows read that turn as the begin turn: no second one is sent, and a turn that got no reply shows Try again. A Bot Chat that was never used has an empty history, so the first-contact note would fire on that brief. The brief tells the bot to ignore any note about introductions or building a profile.
- **Start fresh** is offered only where Bot setup is (0.23.2 or later), and never on `default`. It is refused, with the reason, while a reply runs or an Approval waits in the Bot Chat. Its question counts the memory entries that will go and says they can't come back. It then leaves the live session, archives the Bot Chat in Hermes (`Hermes.archive`), and checks that the title lookup is empty. It retitles the old chat so it can be found in Archived, clears memory entry by entry under Hermes's lock (`MemoryApi.removeMany`, ADR 0118), and opens a new Bot Chat with the brief seeded. If the lookup still finds the old chat, the app unarchives it, clears no memory, and says this Hermes can't start a Bot Chat fresh. An archive Hermes doesn't confirm counts as done unless the lookup still finds the old chat, since the title may be gone. Hermes keeps nothing that says which archived chat was the Bot Chat, so a Start fresh run again after a stop names the one this app archived, while the app hasn't been closed since and Hermes still has it archived with no title.

## Owner calls

Each was decided on 2026-11-19 with the default below. The other choice is noted.

1. **Reloading MCP servers.** `reload.mcp` runs at Set it up only when no reply runs anywhere on this Hermes. Otherwise the rows wait with Reload MCP servers. The row says "Hermes reloaded it". (Or: always reload, or leave the reload to the owner.)
2. **OAuth MCP servers stay off the card in v1.** The card names them and points to Settings → MCP servers. (Or: add them at Set it up and sign in after. Until then they are on with no working connection.)
3. **The accepted record rides in the hidden ready-turn row** and is kept on this computer until that row reads back. (Or: a hidden "accepted" turn before any write. It is fully in Hermes but costs a model reply.)
4. **Connect keeps a pasted key in the app's memory and sends it only at Set it up.** Leaving the card loses it. (Or: send it at Connect, which adds the server early.)
5. **The bot may open with one short sentence saying who it is**, before question 1. (Or: the question alone.)
6. **The model row on a new bot's card is greyed "Already in use"** and not counted in the ticked totals. (Or: hide it unless the bot proposes another model.)
7. **Set up again on a never-used Bot Chat:** the brief tells the bot to ignore any first-contact or introduction note. (Or: archive the empty chat and seed a new one.)
8. **The name dialog shows the derived id** as one faint line, so a `-2` in Hermes's own clients isn't a surprise. (Or: no hint.)

Settled with the owner earlier, on 2026-11-18, and kept:

- The name and a colour write a Bot Mode block, which turns Bots message each other on (ADR 0207).
- Start fresh clears both memory files for good, with no restore, after a question that counts the entries. It keeps the bot's threads and isn't offered on `default`. The old Bot Chat is archived in Hermes, so it is hidden in every client, and the bot's own search tool can still find it.
- The bot's ready line after Set it up is fine. It is what refreshes the bot.

## Considered options

- **Send the brief as the first hidden `prompt.submit` into an empty Bot Chat,** as #85 first planned. Rejected: Hermes appends its first-contact note to that turn, and the note asks the model to save a profile of the owner to memory.
- **Use Hermes's own onboarding chat (`setup_beat`).** Rejected: it is a first-launch setup for the whole install, with fixed steps, run once per install. It can't host a per-bot interview.
- **Fall back to `session.close` and `session.resume`, or a compaction, to restart the bot.** Dropped: Hermes refreshed toolsets and persona at the next turn in all four probed cases.
- **Restart the gateway after Set it up.** Rejected: it cuts running replies in every profile (ADR 0205), and the Bot Chat's own refresh is enough.
- **Add an OAuth server turned off, sign in, then turn it on.** Impossible at `ae2a81cc`: `MCPServerCreate` has no `enabled` field.
- **Rebuild the card only as the difference between the block and Hermes.** Rejected: after an in-place edit and a reload, the card would offer to write the bot's value over the owner's.
- **Gate the interview on 0.20.4, where the hidden `prompt.submit` first ships, or on the app's bot floor 0.21.6.** Rejected: seeded rows stay hidden only from 0.21.2, and below 0.23.2 a new profile has no keys, so the bot can't answer the brief.
- **Reuse an env value read from the source bot.** Rejected: it is half-masked, and would be written as the secret.

## Consequences

- New bot and New profile lose the form. `ProfileForm` keeps Edit only. Write with AI stays on Edit's Persona, where ADR 0206 and ADR 0209 still apply.
- Writing the typed name creates a Bot Mode block, so making a bot turns Bots message each other on for the server if it was off.
- A new bot starts with the launch profile's `.env` keys and model, and Bot setup relies on them: without keys the bot can't answer the brief. New bot doesn't send `mirror_credentials`. Clone's fresh copy (ADR 0074) goes through the same route and sends `mirror_credentials: false`, the only value the relay passes, so it gets no keys (issue #117).
- A `reload.mcp` at Set it up reconnects MCP servers for every bot with an open chat on that Hermes, and the next message in each re-sends its full input.
- After Start fresh the bot's `session_search` can still find the archived Bot Chat. An external memory provider such as Honcho isn't cleared, since the app can't read or edit what it stores.
- `Hermes.archive`, which ADR 0202 left with no caller in the app, gets one: Start fresh.

## Not verified yet

- **A real model inside real Hermes following the brief.** The brief scored 14 of 14 under a strict validator with `gpt-6.1-sol`. That covered eight single turns and one whole interview chained on the model's own replies. Those runs went through Codex's agent prompt, not Hermes's system prompt. The sandbox runs used a stub model. So a real model following the brief inside real Hermes is inferred, not observed. The step that switches New bot over closes this with one run on the owner's Hermes, with a throwaway bot deleted after, once the owner allows it.
- **That `reload.mcp` reached the bot.** Nothing short of a call from the bot proves it, which is why the MCP row says "Hermes reloaded it".
- **The path guard against a real case.** No catalog entry at `ae2a81cc` installs from git.
