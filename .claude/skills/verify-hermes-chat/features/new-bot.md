# New bot

Bots mode's New bot, and Settings → Profiles' New profile, open the name dialog (ADR 0231): one name box, Create, Skip and Cancel. A faint line under the box names the id Hermes's own clients will show. Create makes the profile with the profile in use's model (only when that profile has its own), writes the typed name as the bot's name in Bot Mode, and opens the new bot's Bot Chat as a Bot visit, where Bot setup's brief is seeded hidden and a hidden begin turn starts the bot's first reply. Below Hermes 0.23.2, or without Bot Mode, Create makes the bot from the name and model only and sends no brief. Skip has Start blank (the bot, its Bot Chat empty, no brief) and Copy a bot… (Clone profile with the name filled in). Edit bot and Edit profile keep their Persona field and its Write with AI; Edit persona… in a bot's right-click menu opens Edit bot there.

## Sub-features

- `new-bot-dialog`: the dialog empty, then with a name and the id line, then with Skip's menu open.
- `new-bot-id`: a taken or reserved id gets `-2` in the id line and in the create.
- `new-bot-create`: Create sends one `POST /api/profiles` with the name's id alone (or with the model in use), writes the name in Bot Mode, and opens the Bot Chat with the brief seeded hidden and one hidden begin turn.
- `new-bot-old-hermes`: below 0.23.2 the dialog says why there's no interview, and Create sends no brief.
- `new-bot-blank`: Start blank opens the Bot Chat empty, with no brief.
- `new-bot-copy`: Copy a bot… opens Clone profile with the id filled in.
- `new-bot-mcp`: the card's MCP servers: the command shown first, Connect's write-only field, an OAuth server named but not tickable, and after Set it up `reload.mcp` on the Bot Chat, or Reload MCP servers while a reply runs.
- `edit-persona-rewrite`: Edit bot's Persona, Write with AI, the field holding the rewrite, Undo, and a failed rewrite that leaves the persona as typed.

## How to get to it (user POV)

- The chat list's **Bots** tab → **New bot** (+) above the bots.
- Settings → Profiles → **New profile** shows the same dialog.
- A right-click on a bot's row in the **Bots** tab → **Settings** opens Edit bot, and → **Edit persona…** opens it with focus in Persona.

## Driving it with wd.mjs

Preconditions: `hv up`, signed in per [sign-in.md](sign-in.md). A stand-in that reports a version older than 0.23.2 takes the no-interview path; the real-Hermes sandbox (`RH_VENV=~/.cache/hermes-v0232/venv real-hermes up`) reports 0.23.2.

- **Open it.** `$S/wd.mjs click '[role=tab][data-mode=bots]'`, `$S/wd.mjs click button "New bot"`, `$S/wd.mjs wait '[role=dialog]' "New bot"`. The name box has focus.
- **Name.** `$S/wd.mjs fill input "Name" -- "Travel Buddy"`, `$S/wd.mjs wait .set-hint "travel-buddy"`.
- **Skip.** `$S/wd.mjs click button "Skip"`, `$S/wd.mjs wait '[role=menu]' "Start blank"`. Escape closes the menu only; a second Escape closes the dialog.
- **Create.** `$S/wd.mjs click button "Create"`, `$S/wd.mjs gone .profile-dialog`. The app is on the new bot's profile with its Bot Chat open. `$S/hv state` shows the create body under `profileCreates`; the real sandbox's stored rows (`GET /api/sessions/<id>/messages`) hold the brief and the begin turn, both `display_kind: hidden`.
- **Start blank.** Open it, name it, **Skip** → **Start blank**: the Bot Chat opens empty and no `prompt.submit` is sent.
- **Copy a bot.** Open it, name it, **Skip** → **Copy a bot…**: Clone profile opens with the id in "New profile's name".
- **MCP servers on the card.** Once the bot's card names an MCP server (`mcp: [{"catalog": …}]` or a `copy` with `mcp`), its row is under `'.msg.returned.bot-setup[data-card] [aria-label="MCP servers"]'`. `$S/wd.mjs click button "Connect"`, then type into the `input[type=password]` under the row and `$S/wd.mjs click '.bot-setup-connect button' "Connect"`: nothing reaches Hermes until **Set it up**, and Connect opened again shows an empty field. After Set it up, `$S/hv state` (or the real sandbox's request log) shows the add or install with the typed value, then one `reload.mcp {session_id, confirm: true}` before the hidden ready turn. With a reply running in any chat the row waits with **Reload MCP servers** instead. The real proof that the bot reaches the server is the "MCP copy" test in `src/hermes/botSetupSpikes.live.test.ts`, which calls its tool from the Bot Chat.
- **Edit persona.** `$S/wd.mjs rightclick '.sb-bots .bots-row[data-profile=<name>] .bots-open'`, `$S/wd.mjs click '[role=menuitem]' "Edit persona…"`: Edit bot opens with the SOUL.md in `textarea "Persona"`, focused. Type a rough persona, `$S/wd.mjs wait .set-hint "writes"`, `$S/wd.mjs click button "Write with AI"`, `$S/wd.mjs wait button "Undo"`. With an empty `HV_PERSONA_REPLY` file, Write with AI shows `[role=alert]` "couldn't rewrite" and keeps the text.

## Gotchas

- Throwaway bots made on a real Hermes are deleted through `DELETE /api/profiles/<id>` after the run.
- The app reads Hermes's version a few seconds after connecting. A Create before then is treated as a Hermes that runs Bot setup.
- Edit's rewrite runs on the model that writes for the edited bot (ADR 0209): its Text generation model when pinned on the server, else the Writing model from Settings → Model, else its own main model.
- A deterministic stand-in answer proves the app's path, not a provider's rewrite.
