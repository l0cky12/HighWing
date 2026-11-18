# A persona is edited only in the profile form, and Write with AI rewrites it in place

> **Accepted.** It supersedes [ADR 0199](0199-a-persona-is-drafted-with-one-off-calls-and-only-apply-fills-the-editor.md), amends [ADR 0197](0197-new-bot-rewrites-a-rough-persona-and-applies-chosen-skills-and-tools-read-back.md)'s suggestion box and its "Edit keeps its link to Settings → Persona", and retires the Settings → Persona page of [ADR 0014](0014-persona-saves-check-hermes-first-and-read-back.md), [ADR 0117](0117-persona-edits-any-profile-picked-on-the-screen.md) and [ADR 0118](0118-skills-memory-and-persona-show-any-profile-and-skills-move-between-profiles.md). The form is `ProfileForm` in `src/ui/ProfileSettings.tsx`, which is also the Bots view's New bot and Edit bot. Write with AI is `src/ui/PersonaRephrase.tsx` and `src/hermes/personaRephrase.ts`; SOUL.md is read and written through `PersonaApi` in `src/hermes/persona.ts`. Tested in `src/ui/botCreation.test.tsx`, `src/ui/bots.test.tsx`, `src/ui/profileSettings.test.tsx` and `src/hermes/personaRephrase.test.ts`.

A bot's persona, its `SOUL.md`, could be written in three places: the New profile form's Persona with its Generate with AI (ADR 0197), Settings → Persona's editor (ADR 0014, 0117), and that editor's Write with AI panel (ADR 0199). Edit bot only linked to Settings → Persona. The owner wants one place: the Edit bot form. They type in its Persona field, and a button on the Persona label's line rewrites what they typed into a finished persona in that same field, with no notes box and no separate suggestion box. Settings → Persona goes away.

## Decisions

### The profile form is where a persona is written

- **New and Edit both have Persona.** New sends it in the create, as before (ADR 0164). Edit, in Settings → Profiles and as the Bots view's Edit bot, reads the profile's `SOUL.md` with `GET /api/profiles/{name}/soul` as the form opens. The field is disabled, with a line saying so, until the read answers. A failed read says why, keeps the field disabled, and offers **Try again**; the rest of the form still saves.
- **Save writes it with the other fields.** The field counts as changed when its text, compared as Hermes reads it back (no byte order mark, LF line ends), differs from what was read. Unchanged, `SOUL.md` isn't written. Changed, it is saved after the description, model and look, and before the name, so a failed or conflicting persona keeps the rename from running (ADR 0189). The save is ADR 0014's: read again, write only if Hermes still has what the form read, then read back.
- **Each outcome is a field note**, as the form's other fields have (ADR 0189). Saved reads back. Changed elsewhere (Hermes's file was not what the form read, or reading it back after the write found other text) keeps the owner's text, says so, and offers **Use Hermes's**, which puts Hermes's text in the field; a second Save replaces Hermes's knowingly. A save Hermes confirmed but that couldn't be read back says so, and the field is taken as saved, so Save doesn't send it again unasked. Any other failure says Hermes's reason, and the field keeps the owner's text.
- **Edit persona opens Edit at Persona.** Settings → Profiles' row menu has **Edit persona**, and the Bots view's bot menu has **Edit persona…**. Each opens that profile's Edit form with focus in Persona once it is read.

### Write with AI rewrites the field in place

- **One button, on the Persona label's line, on New and Edit.** It is labelled **Write with AI**. It sends what the field holds, through one stateless `llm.oneshot` with no tools and no chat, with ADR 0197's rules unchanged: it never writes from nothing, so it is off with its reason on a blank field; at most 8000 characters are sent, and the line after the rewrite says when the persona was longer; a closing persona tag in the text can't end the data early; an answer with no text is a failure. The prompt now asks for "the persona of an AI assistant", not "a new" one, since it rewrites existing bots' personas too.
- **Which model writes.** New: the profile in use's Text generation model, since the new profile doesn't exist yet (ADR 0197). Edit: the edited profile's own Text generation model; the call names that profile and the hint under the field names its model and the profile.
- **The answer replaces the field's text.** While the call runs, the field is read-only, **Stop** is offered, and Create or Save waits with its reason. When it answers, the field holds the answer and an **Undo** puts back what the owner wrote. Undo is offered only while the field still holds the answer: once the owner edits it, the text is theirs. Stop and a failure leave the field as it was.
- **Nothing reaches `SOUL.md` until Create or Save.** The rewrite is an ordinary unsaved edit: leaving the form asks first, as it does for any other.
- **Hermes has no cancel.** Stop, a newer click, closing the dialog, a lost connection, and on New a switch of the profile in use drop the answer when it comes. The call may still finish on the server, and the hint while it runs says so. A call past `ASK_DEADLINE_MS` fails.

### Settings → Persona is gone

The Persona page, its profile picker, its editor's kept drafts and replaced versions, its question before leaving an unsaved persona, its copy of `SOUL.md` to another profile (ADR 0118), and its Write with AI panel (ADR 0199) are removed. A persona is copied to another profile with Clone profile (ADR 0074). Unsaved persona drafts and replaced versions an earlier Highwing kept in this computer's storage are no longer shown; they still go when their profile is deleted or renamed, or their connection is forgotten.

## Considered options

- **Keep the suggestion box (ADR 0197).** Rejected: the owner asked for no second box. ADR 0197 chose a suggestion because an answer put straight in the box would be "one Create away from Hermes". That still holds, but the form's Create or Save is the only write, the rewrite counts as an unsaved edit, and Undo puts back a bad one.
- **Keep Settings → Persona beside the form.** Rejected: two editors for one file, each with its own drafts and AI, is what the owner asked to end.
- **Keep ADR 0199's notes box, so Hermes can write from a description.** Rejected: the field is where the owner writes, and Write with AI rewrites what is there. A description typed in the field is rewritten into a persona the same way.
- **Run Edit's rewrite on the profile in use's model, as New's does.** Rejected: the edited profile exists, and its own model and sign-in are the ones its chats use.

## Consequences

- Edit reads `GET /api/profiles/{name}/soul` each time it opens, and `GET /api/model/auxiliary` for that profile for Write with AI. A Hermes without the persona routes says so under Persona; the capability (`persona`) names the profile form.
- An edit to the persona lives only in the open form. Closing the form asks first; closing the app doesn't keep it, as Settings → Persona did.
- A profile's last five replaced `SOUL.md` versions are no longer kept on this computer, so a replaced persona can't be put back from the app.
