# Hermes's commands run as its desktop runs them, and a typed name resolves as its command line does

> **Accepted.** Issue #94. Amends [ADR 0015](0015-slash-commands-are-a-small-verified-registry.md): "/" text naming one of Hermes's commands is no longer sent as a message, and a command name can be typed in part.

The owner wants every Hermes slash command in the composer, as in Hermes's own clients. Three gaps stood in the way. `/model` didn't exist. `/mod` found nothing, because only a whole name ran. And the menu closed at the first space, so nothing could be suggested after `/kanban `.

## What Hermes does, read at the deployed `bf0203a`

- **The catalog.** `commands.catalog` lists 97 built-in commands for a profile. For each, the answer gives its aliases (`canon`), its description with the argument hint in it ("(usage: /model [model] …)"), its subcommands (`sub`) and its place in Hermes's desktop (`commands[key].desktop`). That place is `null` (runs), `terminal`, `advanced`, `settings`, `composer-voice` or `hidden`. `tools/commands-catalog-golden.py` writes this answer to `src/hermes/commandsCatalogGolden.json` for the tests.
- **The desktop's routes.** Hermes's desktop (`apps/desktop/src/lib/desktop-slash-commands.ts`, `use-prompt-actions/slash.ts`) runs about 30 commands with screens and calls of its own, refuses its `terminal`, `settings` and `composer-voice` commands, and sends every other one to `slash.exec`. Those answer from the live session, or are handed to `command.dispatch`, or run in a slash worker, which is one CLI process per chat. The answer is text, a message to send (`send`), a skill message (`skill`), text for the composer (`prefill`) or an alias to run (`alias`). When `slash.exec` throws, the desktop tries `command.dispatch`.
- **Prefixes.** Neither the server nor the desktop expands a prefix. Only Hermes's command line does (`cli.py _expand_slash_prefix`). It takes a name or alias typed whole first. Otherwise it collects every name and alias starting with what was typed, skills included. One match, or one shortest match, runs; a tie prints "ambiguous" and the candidates. Hermes's docs say instead that "the first match in registry order wins" and that `/h` is `/help`. The code doesn't do that: `/h` is `/hb`, which is `/heartbeat`.
- **Side effects follow the name typed.** After the worker runs a command, `slash.exec` mirrors its effect onto the live agent (`_mirror_slash_side_effects`), keyed on the name as typed. `/mod gpt-5` sent as typed would switch the worker's model and not the chat's.

## Decisions

- **Every command in the catalog is offered.** `hermesCommands` (src/hermes/hermesCommands.ts) reads the catalog into the same `CommandDef` the app's commands use, with `scope: "hermes"`. Skills stay with the skills (ADR 0015, "Skills from the composer"). The menu, `/help` and the resolution all read one `CommandSet` (commands.ts), so nothing lists the commands twice.
- **A Hermes command runs the way Hermes's desktop runs it.** It goes to `slash.exec` under its own name, never the alias or prefix typed, so Hermes's mirrors apply. On a throw it is retried once as `command.dispatch`, and a quick command's alias runs its target once. The app handles each kind of answer:
  - Text shows under the composer, with Hermes's warning in front and colour codes removed.
  - `send` goes as the chat's next message.
  - `skill` goes through the outbox as a skill call, so its text isn't kept here (ADR 0015).
  - `prefill` fills an empty composer.
- **The app does with its own features what it already has.** `/model` and `/reasoning` use the model picker's switch (`switchModel`, `hermes.setModel`). That is the route with Hermes's expensive-model confirmation. Hermes's own `/model` mirror skips that confirmation, refuses mid-reply after its worker has already run, and is hidden in its desktop for the same reason. `/compress` and `/compact` use the context inspector's Compact, and refuse Hermes's `here N` and `--preview`. `/title` is Rename, and `/reset` and `/clear` are `/new`, as in Hermes's desktop.
- **Some commands never run from here, and say why.** These are the commands Hermes's desktop handles with screens of its own, and the ones `slash.exec` would run against the worker instead of the chat:
  - `/undo` and `/retry` would rewrite the history the chat shows; Edit and Regenerate keep a branch instead.
  - `/branch`, `/resume`, `/sessions`, `/queue` and `/agents` have their own places in the app.
  - `/yolo` has the YOLO switch.
  - `/browser`, `/rollback` and `/prompt` would act on the worker's browser, checkpoints or editor.
  - Display settings, pets, `/journey`, profile archives, `/config` (it prints secrets) and billing pages are left to Hermes's own clients.
  - Hermes's `terminal`, `settings` and `composer-voice` commands stay refused, as in its desktop.
  - `/skills` runs only its text subcommands (`pending`, `approve`, `reject`, `diff`, `approval`).
  - `/personality` waits for the reply to end, since Hermes's mirror refuses it mid-reply after the worker ran it.
  - `advanced` commands, such as `/kanban` and `/curator`, run: the worker runs them like any other.
- **A typed name resolves as Hermes's command line resolves it, not as its docs say.** `CommandSet.typed` follows `_expand_slash_prefix`. A name or alias typed whole wins. Otherwise every name and alias that starts with what was typed counts, offered skill and extension names included, and one match, or one shortest match, runs. A skill or extension found this way is left to its own route. A tie runs nothing and lists the candidates ("/b can't run: It could be /battery, /bg, …"). Two rules of the app's own apply on top:
  - A destructive command runs only by its whole name. `/del` doesn't reach `/delete`. Hermes has no `/delete`, and a one-letter slip shouldn't lead there.
  - "Runs /steer." shows under the composer, before Enter, when an alias or a prefix will run a command.
- **The menu's top row is what Enter would run.** `CommandSet.match` ranks with Hermes's menu tiers (`slash_fuzzy.py`): exact name or alias, prefix, substring, then a word of the description. When a prefix resolves, its command is first. A test checks this for every prefix of every name and alias in the catalog. Commands that never run here are listed only when their name starts with what is typed, so the menu isn't full of them, and they show why.
- **Suggestions after a command's name.** After `/name ` the menu suggests the command's subcommands, for any of Hermes's commands that has them (`/kanban `, `/curator `), or the profile's models for `/model `. The models come from the picker's own search, Favorites first. Only one word is suggested, on one line. Picking a suggestion fills the composer and never runs it, as ADR 0015 decided. Picking a command that leads to such a list keeps the menu open on it. On an empty argument no row is chosen, so Enter runs the command as typed: bare `/model` says which model the chat uses, and Tab or ↓ picks from the list.
- **`/model <name>` never guesses.** It takes `provider:model` (Hermes's form), `provider/model`, a model id or short name that one provider lists, or a search that leaves exactly one model. Several matches or none are refused with the candidates. So are Hermes's `--global`, `--provider`, `--reasoning`, `--once` and `reset`, which would change more than this chat: Settings → Model and the pills beside the model do those. The check runs before anything goes to Hermes, so the text stays and nothing is sent.

## Considered options

- **Follow Hermes's docs on prefixes: the first match in registry order.** Rejected: the deployed code does otherwise, and running a different command from the one Hermes's own CLI runs for the same text would be worse than either rule.
- **Forward every "/" line to `slash.exec` as typed, as the official clients do for unknown commands.** Rejected, as in ADR 0015. Typed aliases and prefixes miss Hermes's mirrors. Unknown text would stop being a message. And `/undo`, `/retry` and `/compress` would change the chat under the app.
- **Use `complete.slash` for suggestions.** Rejected: it costs a request per keystroke, it can't suggest models, and the catalog's `sub` already holds the subcommands it would complete.
- **Bare `/model` opens the picker's popover.** Rejected: its open state is private to four call sites. The list after `/model ` is the same selection, kept at the keyboard.

## Consequences

- Text that used to go as a message now runs a command when its first word starts one command. `/s hi` steers, `/r notes` renames, and `/mod x` switches the model. The hint shows which before Enter, and a leading space still sends any text as typed.
- The first Hermes command run in a chat through the slash worker starts one CLI process for it on the server, as Hermes's own desktop does.
- The commands, their aliases and their subcommands are whatever the connected Hermes lists. A Hermes without `commands.catalog` has the app's commands only.
- Adding a refused command, or a command the app runs itself, is one entry in `hermesCommands.ts` or `COMMANDS`, with a test.
