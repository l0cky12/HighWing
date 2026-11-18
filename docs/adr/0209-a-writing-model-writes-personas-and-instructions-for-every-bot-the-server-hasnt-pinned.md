# A Writing model writes personas and instructions for every bot the server hasn't pinned

> **Accepted.** It supersedes ADR 0177's "Unset, it follows Text generation" and the "Which model" decisions of ADR 0197 and ADR 0206, and nothing else in them. The code is `src/hermes/writingModel.ts`, with `ModelSettingsApi.writingFacts` and `mirrorWriting` in `src/hermes/modelSettings.ts`, `Hermes.writingDesk` in `src/hermes/transport.ts`, and `src/ui/WritingModelSettings.tsx`. Tested in `src/hermes/writingModel.test.ts`, `src/ui/writingModelSettings.test.tsx`, `src/ui/botCreation.test.tsx`, `src/ui/bots.test.tsx` and `src/ui/instructionsAI.test.tsx`.

Write with AI on the profile form's Persona, in New bot and Edit bot (ADR 0197, 0206), and the project instructions writer (ADR 0152, 0177) ran on each bot's Text generation model (`auxiliary.title_generation`), or its main model when that was on `auto`. A bot whose main provider can't serve helper calls, such as a Claude subscription, failed until the owner pinned `auxiliary.title_generation` in that bot's `config.yaml` over SSH, and each new bot needed the same. The owner asked for one app setting, the Writing model, with this order for each writing call for bot P: a model pinned on the server for P, then the app's Writing model, then P's own main model. Chat titles must not change.

## What Hermes does

Read in the source at `ae2a81ccc0`, the deployed tree.

- **`llm.oneshot` takes no model.** It runs `auxiliary.<task>` of the profile's config, for any task key, slot or not, and `title_generation` when no task is sent. A key that is missing, or whose provider is empty or `auto`, runs on the profile's main provider and model, and fails rather than guess another provider when that one can't build. The call's error then reads `No LLM provider configured for task=<task> provider=auto`; the "main provider … is unavailable and no fallback_chain …" line before it goes only to `agent.log`.
- **`PUT /api/config?profile=P` deep-merges and keeps an unknown `auxiliary` key** (ADR 0177). It can't delete one. The relay already passes it.
- **A write is seen by the next call.** `load_config_readonly` caches on the file's signature (`hermes_cli/config.py`), so no wait is needed after the write.
- **Profile descriptions run in the dashboard's own profile.** `describe-auto` calls `profile_describer` in the default profile whatever bot it describes, and the relay sends only `{overwrite}`.

## Decisions

- **The route is the data.** `writingRoute(facts, kind, pick)` is pure and returns one of three routes: `pin` (`text` or `instructions`), `app`, or `main`, each with its provider and model. The task a call sends, the label, whether to write the copy, the failure words and the fix are each one switch on it. Callers get a `Writer` (`profile`, `kind`, `route()`, `ask(call)`) from `hermes.writingDesk(pick).writer(p, kind)` and never name a task.
- **A pin on the server is `auxiliary.title_generation` with a provider that isn't empty or `auto`.** That is what the owner hand-pinned and what Settings → Model's Text generation row writes. For project instructions only, `auxiliary.project_instructions` (by the same rule) is checked first. Both are read with every call and never written by writing.
- **The app's Writing model is copied into the bot as `auxiliary.highwing_writing`**, a key only this app writes and never reads as a setting. Before a call on the `app` route, the app reads the bot's config, and writes the whole block with `PUT /api/config?profile=P` only when it differs: provider, model, `reasoning_effort: ""`, `base_url` (the catalog's URL for a user-defined provider, else `""`), and `""` for each stale endpoint key, the block `applyInstructions` builds (one private `auxBlock`). A second call writes nothing, and a bot made after the pick gets its copy on its first call. A pinned bot, or no Writing model, writes nothing.
- **A failed write fails the call, and no call is sent.** Hermes would otherwise run the unset key on the main model while the label named the Writing model.
- **Tasks sent.** `pin`/`text`: `title_generation`. `pin`/`instructions`: `project_instructions`. `app`: `highwing_writing`. `main`: `title_generation`, which is unset there, so Hermes runs the main model.
- **The setting is kept on this computer**, in `uiPrefs.writingModels`, by connection, because provider and model slugs are a server's own. Removing a connection drops it. It has no reasoning effort.
- **Failures come from the route.** `WritingFailed {profile, route, cause, detail}`; a pin's failure says to change that pin, and any other says to pick a Writing model. On `main`, the words always end "Pick a Writing model in Settings → Model", saying the bot writes with its own model and Hermes couldn't use it for writing. Hermes's sign-in sentences and "No LLM provider configured for task=" only refine the words. A rate limit or timeout on a pin or the Writing model keeps Hermes's words. The profile form, the only place a persona is written (ADR 0206), covers the window, so a link would open Settings behind it: its failure names the setting in words only. Edit bot writes for the edited profile, so a pin's failure there says to change it in Settings → Model while Highwing uses that profile.
- **Settings → Model shows it.** A Writing model section between the model settings and Idle compaction has a provider and model picker from the server's catalog, **Use each bot's own model** to clear it, and one line per bot: pinned on the server (with the model, and that the Writing model doesn't apply), uses the Writing model, writes with its own model (with the model), or couldn't be read. The list is read again after any write from Settings → Model, so a pin set or cleared there shows at once. One line says profile descriptions use the server's Profile descriptions model on the default profile. The Project instructions row says what an unset one leaves writing to.
- **Profile descriptions stay on the server's model.** The app can't steer `describe-auto` per bot, and the default profile's Profile descriptions slot is one the owner pins. Its failure words now name that setting.
- **Chat titles don't move.** Nothing here writes or reads as a setting `title_generation`. Regenerate title, chat summaries, Artifact edits and the repo dialog's suggestion still send no task.

## Considered options

- **Keep the setting on the server**, in the default profile, mirrored to the others. Shared across devices, but one key would be both setting and copy, and another Hermes client could change it. Rejected.
- **Write every bot's copy on pick.** Simpler calls, but a bot made later misses it, a partial write needs a retry screen, and it writes bots that never write. Rejected.
- **A key per model** (`highwing_writing_<hash>`), never rewritten. No read before the write, but every model ever picked stays in every bot's config. Rejected.
- **Count only a new key as a pin.** The owner's existing `title_generation` pins would stop counting, and a pinned bot's persona writing would move. Rejected.
- **Lend a session's model** through a hidden chat on the chosen model. It creates server chats for stateless calls. Rejected.

## Consequences

- Each writing call reads the bot's config twice first (up to nine calls in an instructions question run), in exchange for no cached route that disagrees with the server or the setting.
- Each bot that has written with the Writing model keeps `auxiliary.highwing_writing` in its `config.yaml`. Clearing the setting leaves it there, unused: the `main` route never sends its task.
- A bot with Text generation pinned ignores the Writing model. Settings lists which bots that is.
- Two computers with different Writing models rewrite each other's copy, and a call racing the other's write may run on the other's model. The next call converges.
- No price check: `PUT /api/config` checks none, as ADR 0177 notes.
- `WritingPick.apiUrl` is copied from the catalog when picked; if a user-defined provider's URL changes, the owner picks again.
