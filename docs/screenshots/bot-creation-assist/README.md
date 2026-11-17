# New bot's persona rewrite, skills and tools: evidence

Evidence for ADR 0197: New bot rewrites a rough persona with AI into a suggestion the owner applies, and applies the skills and tools the owner chose to the new bot, each read back.

## Where the screenshots come from

Every PNG here is the real Tauri app (WebKitGTK), driven by `.claude/skills/verify-hermes-chat` against its stand-in Hermes at `127.0.0.1`. The stand-in serves synthetic data: the profiles `default` and `work`, five made-up built-in skills, and seeded toolsets. The persona suggestion is a fixed answer read from a file (`HV_PERSONA_REPLY`), not a model. No real provider, real Hermes profile or user data is involved. The recipe is `.claude/skills/verify-hermes-chat/features/new-bot.md`.

The shots were taken across the review rounds, so some show an earlier build of this branch. Each row names the build.

| File | Build | State |
| --- | --- | --- |
| `new-bot-form.png` | `a34e94a` | The empty form: Generate with AI off with its reason, Skills and Tools on Hermes's defaults, and the MCP servers note. |
| `persona-suggestion.png` | `a34e94a` | A rough persona typed, and the editable suggestion with Discard and Replace persona. The persona box is unchanged. |
| `skills-choose.png` | `aa20c35` | Skills on Choose with three unticked, and the hint for the after-create switch. `hermes-agent` is locked on. |
| `tools-choose-and-mcp-note.png` | `a34e94a` | Tools on Choose with Terminal off and Image Generation on, and the MCP servers note above Create bot. |
| `outcome-caution.png` | `fa033b5` | A create where Computer Use waits on Hermes's install caution: Apply anyway, Delete and Keep it as is. |
| `applied-with-note.png` | `aa20c35` | After Apply anyway: 7 of 7 applied and read back, with the install Hermes started. |
| `settling-delete-notice.png` | `06b6aed` | Delete after a partial create, where Hermes hasn't finished cleaning up: the command to run, with Copy command. |

There is no before shot of the old form. It had the same fields without Generate with AI, Skills, Tools and the MCP servers note.

## Real Hermes

On a throwaway Hermes `f0d94882` with a fresh `HERMES_HOME` and no provider key, a bot created with three skills unticked had exactly those three in `skills.disabled`. The five built-in skills Hermes hides on Linux (`apple-notes`, `apple-reminders`, `findmy`, `imessage`, `sdlc-review`) were installed and untouched, and the profile in use was never written. Generate with AI was off there, with "No Text generation model is set". No rewrite ran against a real provider.

## Reproduce

```sh
npx vitest run src/ui/botCreation.test.tsx src/hermes/botSetup.test.ts src/hermes/personaRephrase.test.ts --maxWorkers=1
```

For the real app, follow `.claude/skills/verify-hermes-chat/features/new-bot.md`.
