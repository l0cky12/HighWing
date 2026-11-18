# A persona is drafted with one-off calls, and only Apply fills the editor

> **Superseded by [ADR 0203](0203-a-persona-is-edited-only-in-the-profile-form-and-write-with-ai-rewrites-it-in-place.md).** Settings → Persona and its Write with AI panel are gone. Write with AI is now one button on the profile form's Persona, which rewrites the field in place with Undo. The code this ADR described was removed with it: `src/hermes/personaAI.ts`, `PersonaAI` and `usePersonaAI` in `src/ui/PersonaAI.tsx`, `PersonaSettings`, and their tests.

The owner wants Hermes to write a profile's `SOUL.md` from a rough description, or to improve the one they have, on Settings → Persona, for any profile picked there. Writing a persona must not save it, start a chat, or give the profile any tool or permission. Only Save on Persona (ADR 0014) writes to the server. The New bot form has its own Generate with AI, which rewrites the persona typed in the form (ADR 0197); this decision leaves it as it is.

## Decisions

- **A panel under the editor.** Under the persona editor, **Write with AI…** opens a panel with a notes box. With the editor empty, **Write with AI** writes from the notes. With text in the editor, **Improve with AI** rewrites it, keeping what it says, and the notes say what to change. Opening the panel and typing send nothing.
- **Every call is legacy `llm.oneshot` with no `session_id`**, as in ADR 0152: `{profile, instructions, input, max_tokens, temperature}`, with no tools and no chat. No `task` is sent, so the call runs on that profile's Text generation model (`auxiliary.title_generation`, or the main model when that task is on `auto`). The model is read with `GET /api/model/auxiliary?profile=<profile>` just before the call and named under the suggestion. The project instructions model (ADR 0177) is not used.
- **Which profile writes.** On Persona, the picked profile writes its own persona (ADR 0117). The call and the model read both name it, even when the app uses another profile.
- **What Hermes is given.** The owner's notes in `<notes>` and the editor's text in `<soul>`, which the call is told are data, not instructions. Every `&`, `<` and `>` in the owner's material is sent as an entity, and the call is told to write them plainly, so no spelling of a tag in the text can close its own tag. The rules are short: keep the owner's facts, purpose, language and limits, invent no tools, integrations, permissions or secrets, and pad nothing. Notes are capped at 4,000 characters, the text to improve and the answer at 20,000 (what Hermes includes of a `SOUL.md`), and the answer at 2,048 tokens. An answer in a code fence or `<soul>` tags is unwrapped. An empty answer is a failure.
- **A suggestion is only a suggestion.** It shows in its own box, which the owner can edit. **Apply** puts it in the editor as an ordinary unsaved edit; **Discard** drops it. Persona's Save then decides, unchanged. The text is only ever a textarea's value, never rendered.
- **A suggestion goes only into the text it was written from.** If the editor changed while Hermes wrote, Apply asks before it replaces that text.
- **Calls are bound to where they were made.** One call at a time. Stop, a lost connection, a change of the writing profile, a newer call, or closing the editor drops the answer when it comes. On Persona each picked profile has its own editor (ADR 0117), so an answer can't reach another profile's editor. Hermes can't cancel an `llm.oneshot`, so Stop says the call may still finish on the server.
- **Failures keep everything.** A failed call shows Hermes's reason with key-shaped text masked (`redactSecrets`). A missing sign-in for the model's provider (`TitleModelUnavailable`) is worded by the panel itself, naming the profile, the provider and the setting, and for Nous Portal the `hermes auth add nous` command, as Regenerate title does. The notes, the editor and any suggestion stay, and manual editing still works. Asking again keeps the suggestion shown, with the owner's edits, and puts it back if the new call fails or is stopped. The app's own words, an empty or oversized answer and the whole missing sign-in message included, come from the interface catalogue (ADR 0100); only Hermes's own reason for any other failure is shown as Hermes sent it.
- **Leaving.** The panel doesn't count as an unsaved edit: it holds no edit to the file. Its notes, call and suggestion belong to the picked profile's editor and go when that editor closes.

## Considered options

- **Reuse the project instructions dialog (ADR 0152).** Rejected: it starts improving as soon as it opens, asks questions, and runs on the Project instructions model, which is for one project's instructions.
- **Put this panel in the New bot form too.** Built first, then dropped when ADR 0197 landed: that form already has Generate with AI, decided for it on the owner's behalf, and two AI controls on one persona box would compete. Making the two one mechanism is left for a later change.
- **Write with the profile in use on Persona too.** Rejected: the owner picked the profile being edited, and its own model and sign-in are the ones its chats use.

## Consequences

- A profile whose Text generation provider isn't signed in on the server can't write a persona with AI until it is, or until its Text generation model changes. That setting is in Settings → Model while the app uses that profile.
- Hermes's answer is the model's text. The rules ask for no invented tools or secrets, but nothing checks the answer beyond its size. The owner reads it before Apply and Save.
- `SOUL.md` shapes behaviour only. It grants no tool, skill, MCP server or permission. Picking those for a bot is outside this decision.
