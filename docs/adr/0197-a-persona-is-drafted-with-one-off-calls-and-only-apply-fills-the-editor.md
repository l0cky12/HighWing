# A persona is drafted with one-off calls, and only Apply fills the editor

> **Accepted.** The prompt and answer handling are in `src/hermes/personaAI.ts`. The panel and its state are `PersonaAI` and `usePersonaAI` in `src/ui/PersonaAI.tsx`, used by `PersonaSettings` (Settings → Persona) and by `ProfileForm`'s New form (New profile and New bot). Tested in `src/hermes/personaAI.test.ts`, `src/ui/persona.test.tsx`, `src/ui/bots.test.tsx` and `e2e/features/persona-ai.e2e.tsx`.

The owner wants Hermes to write a profile's `SOUL.md` from a rough description, or to improve the one they have. They want this both on Settings → Persona and when they make a new bot. Writing a persona must not save it, start a chat, or give the bot any tool or permission. Only Save on Persona (ADR 0014) and Create in the New bot form write to the server.

## Decisions

- **One panel, two places.** Under the persona editor, **Write with AI…** opens a panel with a notes box. With the editor empty, **Write with AI** writes from the notes. With text in the editor, **Improve with AI** rewrites it, keeping what it says, and the notes say what to change. Opening the panel and typing send nothing.
- **Every call is legacy `llm.oneshot` with no `session_id`**, as in ADR 0152: `{profile, instructions, input, max_tokens, temperature}`, with no tools and no chat. No `task` is sent, so the call runs on that profile's Text generation model (`auxiliary.title_generation`, or the main model when that task is on `auto`). The model is read with `GET /api/model/auxiliary?profile=<profile>` just before the call and named under the suggestion. The project instructions model (ADR 0177) is not used.
- **Which profile writes.** On Persona, the picked profile writes its own persona (ADR 0117). The call and the model read both name it, even when the app uses another profile. In the New bot form, the profile doesn't exist yet, so the profile in use writes, and the panel says so by name. The form's own Model field isn't used.
- **What Hermes is given.** The owner's notes in `<notes>` and the editor's text in `<soul>`, which the call is told are data, not instructions. The rules are short: keep the owner's facts, purpose, language and limits, invent no tools, integrations, permissions or secrets, and pad nothing. Notes are capped at 4,000 characters, the text to improve and the answer at 20,000 (what Hermes includes of a `SOUL.md`), and the answer at 2,048 tokens. An answer in a code fence or `<soul>` tags is unwrapped. An empty answer is a failure.
- **A suggestion is only a suggestion.** It shows in its own box, which the owner can edit. **Apply** puts it in the editor as an ordinary unsaved edit; **Discard** drops it. Persona's Save and the form's Create then decide, unchanged. The text is only ever a textarea's value, never rendered.
- **A suggestion goes only into the text it was written from.** If the editor changed while Hermes wrote, Apply asks before it replaces that text.
- **Calls are bound to where they were made.** One call at a time. Stop, a lost connection, a change of the writing profile, a newer call, or closing the editor drops the answer when it comes. On Persona each picked profile has its own editor (ADR 0117), so an answer can't reach another profile's editor. Hermes can't cancel an `llm.oneshot`, so Stop says the call may still finish on the server.
- **Failures keep everything.** A failed call shows Hermes's reason with key-shaped text masked (`redactSecrets`). A missing sign-in for the model's provider names the profile and the setting, as Regenerate title does. The notes, the editor and any suggestion stay, and manual editing still works.
- **Leaving.** In the New bot form, notes, a call or a suggestion count as changes, so closing asks first. The panel's state lives in the form, so the leave question doesn't lose it. On Persona, the panel doesn't count as an unsaved edit: it holds no edit to the file.

## Considered options

- **Reuse the project instructions dialog (ADR 0152).** Rejected: it starts improving as soon as it opens, asks questions, and runs on the Project instructions model, which is for one project's instructions.
- **Write a new bot's persona with the model picked in its form.** Rejected: that model isn't set until the profile exists, and `llm.oneshot` can't be given a model (ADR 0152).
- **Write with the profile in use on Persona too.** Rejected: the owner picked the profile being edited, and its own model and sign-in are the ones its chats use.

## Consequences

- A profile whose Text generation provider isn't signed in on the server can't write a persona with AI until it is, or until its Text generation model changes. That setting is in Settings → Model while the app uses that profile.
- Hermes's answer is the model's text. The rules ask for no invented tools or secrets, but nothing checks the answer beyond its size. The owner reads it before Apply, and Save or Create.
- `SOUL.md` shapes behaviour only. It grants no tool, skill, MCP server or permission. Picking those for a bot is outside this decision.
