# Slash commands

The owner types `/` at the start of the composer and picks from a menu that lists the app's commands and every command Hermes lists for the profile. Typing part of a name runs the one command it starts (`/mod` is `/model`), a name several commands start runs nothing and lists them, and "Runs /steer." under the composer says which command an alias or prefix will run. After a command's name, the menu suggests its subcommands (`/kanban `) or the profile's models (`/model `). Picking a suggestion only fills the composer; Enter then runs it. A command Hermes keeps to its own clients says why it doesn't run here.

## Sub-features

- `menu-hermes`: the "/" menu lists Hermes's own commands (`/kanban`, `/usage`) after the app's, each marked Hermes.
- `prefix-model`: `/mod` puts `/model` first, and Tab fills in `/model ` with the Models list open and no row chosen.
- `model-bare`: Enter on `/model ` with nothing chosen says which model the chat uses.
- `model-pick`: a model picked from the list is filled in as `/model provider:model`; Enter switches the chat's model.
- `nested-kanban`: `/kanban ` lists its subcommands; `list` filled in and run goes to Hermes as `/kanban list`, and its answer shows under the composer.
- `prefix-unclear`: `/b why` with Enter runs nothing and lists `/battery`, `/bg`, `/blueprint`, `/bp`, ….
- `alias-hint`: `/s check the logs` shows "Runs /steer." before Enter.
- `refused`: `/undo` shows why in the menu, and Enter says it can't run.

## How to get to it (user POV)

- Type `/` at the very start of a chat's composer.
- Type a command's name, or its start, followed by a space and its argument, and press Enter (menu closed).
- `/help`, run from the menu, lists every command with its other names and why it can't run now.

## Driving it with wd.mjs

Preconditions:

- Signed in to the stand-in (see [sign-in.md](sign-in.md)), chat `backup` open (see [send-message.md](send-message.md)) and loaded.
- The stand-in lists Hermes's built-in commands as `bf0203a` does, and answers `/kanban` and `/usage` with canned text.

Clear the composer before each step with `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs press Control+a` and `$S/wd.mjs press Backspace`, then type with `$S/wd.mjs keys`.

- **Menu with Hermes's commands.** Clear, then run `$S/wd.mjs keys "/k"`, then `$S/wd.mjs wait '.cmd-option .cmd-name' "/kanban"`, then `$S/wd.mjs shot 10-menu-kanban`. The `/kanban` row is marked Hermes.
- **/mod resolves to /model.** Clear, then run `$S/wd.mjs keys "/mod"`, then `$S/wd.mjs text '.cmd-option.sel .cmd-name'` (prints `/model`), then `$S/wd.mjs shot 11-mod`. Run `$S/wd.mjs press Tab`, then `$S/wd.mjs wait '[role=listbox][aria-label=Models]'`, then `$S/wd.mjs shot 12-model-list`. `$S/wd.mjs value 'textarea[data-composer]'` prints `/model ` and no option has `aria-selected=true`.
- **Bare /model.** Run `$S/wd.mjs press Enter`, then `$S/wd.mjs wait .cmd-note "This chat uses"`, then `$S/wd.mjs shot 13-model-bare`.
- **Pick a model.** Clear, then run `$S/wd.mjs keys "/model opus"`, then `$S/wd.mjs wait '[role=listbox][aria-label=Models]'`, then `$S/wd.mjs press Enter`. The composer holds `/model anthropic:claude-opus-4-5` and nothing ran (`$S/wd.mjs shot 14-model-filled`). Run `$S/wd.mjs press Enter`, then `$S/wd.mjs wait .cmd-note "Now on claude-opus-4-5"`, then `$S/wd.mjs shot 15-model-switched`. The model button reads `claude-opus-4-5`.
- **/kanban subcommands.** Clear, then run `$S/wd.mjs keys "/kanban "`, then `$S/wd.mjs wait '[role=listbox][aria-label="/kanban"]'`, then `$S/wd.mjs shot 16-kanban-subcommands`. Run `$S/wd.mjs keys lis`, then `$S/wd.mjs press Enter` (fills `/kanban list`), then `$S/wd.mjs press Enter`, then `$S/wd.mjs wait .cmd-note "No tasks on the default board"`, then `$S/wd.mjs shot 17-kanban-ran`.
- **Unclear prefix.** Clear, then run `$S/wd.mjs keys "/b why is it slow"`, then `$S/wd.mjs press Enter`, then `$S/wd.mjs wait .cmd-note "It could be /battery, /bg"`, then `$S/wd.mjs shot 18-unclear`. The composer keeps the text.
- **Alias hint.** Clear, then run `$S/wd.mjs keys "/s check the logs"`, then `$S/wd.mjs wait .skill-note "Runs /steer."`, then `$S/wd.mjs shot 19-alias-hint`.
- **Refused.** Clear, then run `$S/wd.mjs keys "/und"`, then `$S/wd.mjs wait .cmd-why "Use Edit under your message"`, then `$S/wd.mjs shot 20-undo-menu`. Run `$S/wd.mjs press Enter` twice, then `$S/wd.mjs wait .cmd-note "can't run"`.
- **Proof on the server.** Run `grep -E 'WS (slash.exec|config.set|prompt.submit|prompt.btw|command.dispatch)' $EVIDENCE/bridge.log`. It shows exactly one `config.set` (the model switch) and one `slash.exec` (`/kanban list`); the log names the method, not its params. Nothing else was sent: the bare `/model`, the unclear `/b`, the hint and the refused `/undo` send nothing.
- **Against a real Hermes.** With `real-hermes up` and `hv up --dashboard <url>`, start a chat (Ctrl+N, any message; the stub replies), then run `/status` (answered from the live session: "Hermes TUI Status"), `/kanban list` (answered by Hermes's slash worker: "(no matching tasks)") and `/plan <task>` (Hermes builds the plan message, which goes to the chat as a turn).

## Gotchas

- `fill` doesn't clear the composer's text; clear it with Ctrl+A and Backspace as above. `keys` types key by key, so the menu opens and filters while it types; check the composer's value with `value` before pressing Enter.
- After a relaunch, the keyring toast can cover the composer and intercept a click on it; wait for `.toast` to go first.
- A `/plan` turn shows Hermes's whole plan prompt once read back from history: Hermes's own history shows it that way too.
- The Models list shows only once Hermes has listed the profile's models. Wait for the listbox before pressing keys.
- A real Hermes (`real-hermes up`) answers Hermes's commands from its slash worker, which starts one CLI process per chat on first use and can take several seconds. Raise the `wait` timeout there.
