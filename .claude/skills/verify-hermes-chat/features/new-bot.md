# New bot

The Bots view's New bot (the New profile form) makes a profile from a name, a description, a model and a persona. Generate with AI beside Persona rewrites the rough persona the owner typed into an editable suggestion, which reaches the box only on Replace persona. Skills and Tools keep Hermes's defaults unless the owner picks Choose and ticks what the new bot starts with; after the create each choice is read back from the new profile, and the dialog stays open on anything not applied, with Delete or Keep it as is. MCP servers show a note that they can't be added while creating.

## Sub-features

- `new-bot-empty-persona`: Generate with AI is off on an empty persona, with the reason under the field.
- `new-bot-rewrite`: a rough persona, Generate with AI, the suggestion edited, Replace persona, and focus back in the box.
- `new-bot-rewrite-error`: a rewrite that fails says why and leaves the persona as typed.
- `new-bot-skills`: Choose, filter, untick built-in skills; the create body is plain, and only the unticked skills are off in the new profile.
- `new-bot-tools`: Choose, untick and tick toolsets; the new profile has them set, and the profile in use doesn't change.
- `new-bot-mcp-note`: the MCP servers note.
- `new-bot-partial`: a toolset with a caution leaves the dialog open on what isn't applied, with Apply anyway, Delete and Keep it as is.
- `new-bot-progress`: while the choices are applied, the line under the form counts them, "n of m done".
- `new-bot-settling`: Delete from the outcome, when Hermes is still settling the profile, says so with its command.
- `new-bot-set-model`: a create with Choose whose model Hermes didn't set offers Set model… (Settings → Profiles' New profile only).
- `new-bot-narrow`: the form at 760 px wide scrolls, with no horizontal scroll.

## How to get to it (user POV)

- Rail **Bots** → **New bot** (+).
- Settings → Profiles → **New profile** shows the same form.

## Driving it with wd.mjs

Preconditions:

- `hv up` with `HV_BUNDLED=1` (built-in skills on `default`) and `HV_PERSONA_REPLY=<file>` (the rewrite's answer), then signed in per [sign-in.md](sign-in.md).
- `F1='fieldset.bot-setup:nth-of-type(1)'` is Skills and `F2='fieldset.bot-setup:nth-of-type(2)'` is Tools.

- **Open it.** `$S/wd.mjs click .bots-btn`, `$S/wd.mjs click button "New bot"`, `$S/wd.mjs wait '[role=dialog]' "Create bot"`. The Persona hint reads "Type a rough persona first…" and Generate with AI looks off.
- **Rewrite.** `$S/wd.mjs fill input "Name" -- bc-synth-1`, `$S/wd.mjs fill textarea "Persona (optional)" -- "<rough text>"`, `$S/wd.mjs wait .set-hint "Rewritten by"`, `$S/wd.mjs click button "Generate with AI"`, `$S/wd.mjs wait textarea "Suggested persona"`. The suggestion holds the file's text.
- **Edit and replace.** `$S/wd.mjs click textarea "Suggested persona"`, `$S/wd.mjs press Control+End`, `$S/wd.mjs keys '\n- <more>'`, `$S/wd.mjs click button "Replace persona"`, `$S/wd.mjs gone textarea "Suggested persona"`. `$S/wd.mjs value textarea "Persona (optional)"` prints the edited suggestion.
- **Skills.** `$S/wd.mjs click "$F1 input[type=radio]" "Choose"`, `$S/wd.mjs wait "$F1 .bot-setup-item" "recipes"`, `$S/wd.mjs fill "$F1 input[type=search]" -- re`, `$S/wd.mjs click "$F1 .bot-setup-item input" "recipes"`. Clear the filter with a click on it, `press Control+a`, `press Backspace`. `$S/wd.mjs text "$F1 [aria-live]"` prints the count.
- **Tools.** `$S/wd.mjs click "$F2 input[type=radio]" "Choose"`, `$S/wd.mjs wait "$F2 .bot-setup-item" "Terminal"`, then click the toolsets to change.
- **Create.** `$S/wd.mjs click button "Create bot"`, `$S/wd.mjs gone .profile-dialog`, `$S/wd.mjs wait '[role=status]' "with the skills and tools you chose"`. `$S/hv state` shows the create body under `profileCreates`, the SOUL.md under `souls`, `skillsOff` and `toolsetsOn` for the new profile, and `oneshots` with `profile: default`, `task: title_generation`.
- **Persistence.** The row's More → **Edit bot…** → **Edit in Settings → Persona** shows the SOUL.md; Settings → Skills with `select "Profile whose skills are shown" -- <name>` shows the skills off.
- **Error.** Empty the `HV_PERSONA_REPLY` file, then Generate with AI: `wait '[role=alert]' "couldn't rewrite"`, and the persona keeps what was typed.
- **Double Create.** Click Create bot twice quickly: `hv state` `profileCreates` holds one body.
- **Partial.** Tools → Choose → tick **Computer Use**, Create: `wait .bot-setup-outcome`. **Apply anyway** sets it and lists "Hermes started installing…" under Hermes also; **Done** repeats it in the notice. **Delete <name>** removes it (`hv state` `profiles`), **Keep it as is** closes with a notice naming what isn't applied.
- **Progress.** With `HV_DELAY_MS=1500`, Tools → Choose → untick two toolsets, Create: `wait '[role=status]' " of "` reads "Created. Applying … n of m done…".
- **Settling.** With `HV_SETTLING='hermes profile delete <name>'`, reach the outcome as in Partial, then **Delete <name>**: the Bots view's note reads "Hermes hasn't finished cleaning up after it; run this on the server:" with the command and Copy.
- **Set model.** With `HV_MODEL_ERROR=<text>`, open Settings → Profiles → **New profile**, pick a provider and model name, Tools → Choose → untick one, Create: the outcome shows "Profile created, but Hermes didn't set the model: <text>" and **Set model…**, which opens Edit. The Bots view's New bot has no Set model.
- **Narrow.** `$S/hv x search --name Highwing`, then `$S/hv x windowsize <id> 760 820`; `wd.mjs wheel .profile-dialog -- 600` scrolls the form.

## Gotchas

- `fill … -- ""` fails with "Missing text parameter"; clear a field with Control+a and Backspace.
- Both areas have a radio named Choose; scope it with `$F1` or `$F2`.
- The rewrite runs on the profile in use's Text generation model, so switching profile changes what the hint names.
- A deterministic stand-in answer proves the app's path, not a provider's rewrite.
