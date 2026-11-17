# New bot rewrites a rough persona and applies chosen skills and tools, read back

> **Accepted.** It adds to ADR 0164 (New bot is the New profile form) and follows ADR 0074's clone stages and ADR 0152's one-off calls. The form is `ProfileForm` in `src/ui/ProfileSettings.tsx`, with `src/ui/PersonaRephrase.tsx` and `src/ui/BotCapabilities.tsx`. The calls are `src/hermes/personaRephrase.ts` and `src/hermes/botSetup.ts`. The relay rule is `profile_create_allowed` in `src-tauri/src/transport.rs`. Tested in `src/hermes/personaRephrase.test.ts`, `src/hermes/botSetup.test.ts`, `src/ui/botCreation.test.tsx`, `src/ui/bots.test.tsx` and the relay's `a_new_profile_carries_no_secrets_unless_the_full_copy_is_asked_for`.

The New profile form, which is also the Bots view's New bot (ADR 0164), made a profile from a name, a description, a model and an optional persona. The owner wanted to type a rough persona and have the configured AI tidy it up, and to pick the bot's skills, tools and MCP integrations before creating it.

## Owner decisions

The owner delegated these calls on 2026-11-17 ("do what you think is best"). They are recorded here as decided on the owner's behalf.

1. **Hermes has no create that sets everything at once.** The create carries what Hermes takes in it; the rest is applied after, as tracked stages read back from the new profile. When anything isn't as chosen, the dialog lists what is and isn't applied and offers **Delete <name>** (only when Hermes answered the create) or **Keep it as is**. A partial result never shows a success notice. This is ADR 0074's clone precedent.
2. **MCP servers are left out of creation.** A note says why and points to Settings → MCP servers after creating. It is an open gap; see below.
3. **Skills are the built-in set a new profile starts with, kept or turned off**, through the create's `keep_skills` or `no_skills`, then read back.

## Decisions

### Generate with AI only rewrites what the owner typed

- **A button beside Persona, on New only.** Edit keeps its link to Settings → Persona.
- **It never writes from nothing.** With an empty or blank box the button is off and says to type a rough persona first. It is also off, with its reason under the field, while the app isn't connected, without the call wired, while the model is read, when that read failed, and when the profile in use has no Text generation provider. The button stays focusable while off, so its reason is read with it (`aria-disabled` and `aria-describedby`).
- **One click, one call.** Hermes's stateless `llm.oneshot` (`Hermes.askForEdit`) with no tools and no chat. Its instructions tell the model to rewrite the owner's notes into the persona in the second person, keep every intent, constraint, name and the language, add no authority, permissions, tools, integrations, facts or rules, and treat the tagged text as data. At most 8000 characters are sent. A second click before the screen catches up sends nothing.
- **Which model.** The call runs as the profile in use (`wiring.inUse`) on its Text generation model (`TEXT_TASK`), which is what `ModelSettingsApi.textModel` reads. It is not the model picked for the new bot: that profile doesn't exist yet. The hint names it: "Rewritten by <model>, the Text generation model of <profile>".
- **The answer is a suggestion.** It shows in an editable box under the field, with **Replace persona** and **Discard**. Only Replace puts it in the persona box. If the box changed since the call was sent, the suggestion says so and the button reads **Replace anyway**. A failure, Stop and Discard leave the box as it was; a failure shows Hermes's words, and a missing sign-in says which model and setting, never a key.
- **Hermes has no cancel.** Stop, a newer click and closing the dialog drop the answer when it comes; the call may still finish on the server, and the hint while it runs says so. A call that runs past `ASK_DEADLINE_MS` fails.
- **Create waits.** It is off, with the reason, while a call runs or a suggestion is open, so a suggestion never reaches Hermes unless the owner applied it. An open suggestion counts as an unsaved change when leaving.

### Skills and Tools are Hermes's defaults unless chosen

- **Two choices per area: Hermes's defaults, or Choose.** Defaults is selected, and with it the create's body is byte for byte what it was before this change.
- **Choose reads what there is, then.** Skills lists the profile in use's built-in skills (`GET /api/skills`, `provenance: bundled`), labelled as the ones Hermes gives a new profile; nothing else is offered. Every one starts on. `hermes-agent` is shown on and can't be turned off, since Hermes keeps it on. Tools lists the profile in use's toolsets and starts from what it has on, labelled so. A toolset whose name the app doesn't send (`changeableName`) is shown off-limits with why. Each list has a filter, a live count, All on and All off for what's shown, and checkboxes reached by Tab. A list that can't be read shows why with Try again, and the area stays on Hermes's defaults; a server without the route says it can't list them.
- **What the create carries.** Chosen skills go as `keep_skills`, sorted, or as `no_skills: true` when none is kept. Toolsets aren't in Hermes's `ProfileCreate`, so the create carries nothing for them.
- **Stages, only after Hermes answered.** (a) Skills: the new profile's skills are read back; a chosen skill must be listed and on, and one left out missing or off. Hermes's `keep_skills` step is best-effort (it logs a failure and answers `skills_disabled: 0`) and compares folder names, so only this read tells. (b) Tools: the new profile's toolsets are read, and each that differs from the choice is set with Settings → Toolsets' own `ToolsetsApi.set`, which checks it against a fresh read, re-checks its cautions, writes, and reads it back. A caution (an install, MCP coming back, a toolset turned off everywhere) is never accepted here: the item waits for **Apply anyway**, which sends it with those cautions accepted.
- **The outcome is per item.** Each skill and toolset ends applied, failed with why, or waiting on a caution. A success notice ("Created <name> with the skills and tools you chose.") comes only when every item read back as chosen and the model, if one was picked, was set. Otherwise the dialog stays open on what isn't applied, each with **Try again** (a skill through Settings → Skills' switch, read back) or **Apply anyway**, and the profile's fate: **Delete <name>**, through the same delete as Delete profile and this computer's data for it, or **Keep it as is**, which closes with a notice in the bad tone naming what isn't as chosen. Escape and a click outside don't close it. Once every item is applied, **Done** closes with the success notice.
- **A lost create answer.** When Hermes's answer was lost but it lists the profile, nothing more is written: the notice says the skills and tools weren't checked or changed, and where to see them. There is no Delete: the app can't tell what it made.

### MCP servers stay out, as an open gap

The New form says: "Highwing can't add MCP servers while creating a profile: Hermes would have to copy them without their secrets, and it has no way to yet. After creating, add them in Settings → MCP servers." There are no controls for them.

Evidence at Hermes `f0d94882`: `ProfileCreate` (`hermes_cli/web_models.py:454-472`) takes `mcp_servers` as `MCPServerCreate` entries (`web_models.py:359-368`), each carrying its `env` and `bearer_token` values. The catalog install (`hermes_cli/web_routers/mcp.py:471-540`, `mcp_catalog.py:772-817`) clones a repository, writes credentials and probes the server. Neither copies a server from another profile by reference. Offering MCP servers here would mean the app reading and sending their secrets, or starting installs, which the relay refuses (ADR 0074). What Hermes would need: a create field, or a route, that copies named MCP servers from a source profile on the server, secrets included, without them passing through the client.

### The relay takes keep_skills and no_skills on the fresh form only

`profile_create_allowed` now also allows, on a body without `clone_from`: `keep_skills`, a non-empty list of at most 1000 strings of 1 to 128 bytes with no `/`, `\` or control character and not starting with `.`; or `no_skills` exactly `true`; never both. `mcp_servers`, `hub_skills`, `clone_all`, `clone_channels` and `clone_from_default` stay refused, as does either new field beside `clone_from`. `ProfilesApi.create` takes `keepSkills` and `noSkills` and reports `skillsDisabled` when it sent `keep_skills`.

## Considered options

- **Generate a persona from nothing (the name or description).** Rejected: the owner asked for a rewrite of their own text, and a persona the owner didn't write is one they haven't thought through.
- **Run the rewrite on the model picked for the new bot.** Rejected: the profile doesn't exist until Create, and `llm.oneshot` runs as an existing profile. Its Text generation model is what the profile in use already trusts for one-off calls.
- **Put the suggestion straight in the box, with Undo.** Rejected: an edit the owner didn't apply would be one Create away from Hermes.
- **Offer hub skills (`hub_skills`) and every skill the profile in use has.** Rejected: hub installs start subprocesses on the server, and a non-built-in skill isn't something a fresh profile has to keep. Copying own skills is Clone's job (ADR 0074).
- **Trust `skills_disabled` and the toggle answers.** Rejected: both are best-effort or can be lost (ADR 0005, 0014); only a read of the new profile says what it has.
- **Accept toolset cautions on the owner's behalf, since the profile is new.** Rejected: an install and MCP coming back are effects on the server the owner must see first.
- **Roll back a partial result by itself.** Rejected: the owner may want to keep a profile that is mostly right; Delete is one click away.

## Consequences

- A new bot can now differ from Hermes's defaults in skills and tools without a trip to Settings, and each difference is read back before any success is said.
- The New form reads `GET /api/model/auxiliary` for the profile in use as it opens, and reads skills or toolsets only on Choose.
- Settings → Toolsets' caution words are in the catalogue (`toolsets.caution`) and shared with this form.
- `keep_skills` matches folder names and `GET /api/skills` lists front matter names. For Hermes's built-in skills the two are the same; where they differ, the read-back reports the skill as not applied, and Try again turns it off by its listed name.
- Hermes seeds a new profile with its own bundled set, which can differ from what the profile in use lists. A seeded skill the profile in use doesn't list is turned off by `keep_skills` too, and isn't in the outcome. Against a real Hermes `f0d94882` on Linux, keeping 36 of the 39 listed built-in skills also turned off `apple-notes`, `apple-reminders`, `findmy`, `imessage` and `sdlc-review`, which `GET /api/skills` doesn't list there. Hermes would need `keep_skills` to leave unlisted skills alone, or a list of what it seeds, to close this.
