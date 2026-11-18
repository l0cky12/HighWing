# A computer-use run reads as one card, and the transcript keeps a trimmed result

> **Accepted.** Phase 2 of computer use (issue #43). Amends [ADR 0061](0061-a-tool-results-inline-images-stay-out-of-the-chat.md): a `computer_use` result is trimmed before ADR 0061's data-URL swap runs. Built on the recordings of [ADR 0213](0213-computer-use-shapes-are-recorded-from-a-real-hermes-and-kept-as-fixtures.md).

When Hermes drives its Bot Desktop, each `computer_use` call came into the chat as a generic tool row. A 20-step task was 20 rows named `computer_use`, each with a JSON blob behind it. The rows didn't say what the action was, whether it landed, or who held the screen. Reopened from Hermes, the chat showed rows named `tool_call`, because Hermes stores each call inside that wrapper. A capture's result kept its whole element list, up to about 40 KB a step, so a long run's Saved copy grew fast even with ADR 0061's screenshot swap.

## Decisions

- **A run is derived, never stored.** A `computer_use` call stays an ordinary tool item. `foldRuns` in `src/hermes/computerUse.ts` folds consecutive calls into one run on every render, with the reasoning, other tools and computer-use Approvals between them. Assistant text, a message, an error or another Question ends a run. Step numbers go on across a turn, so commentary that splits a run into two cards still reads "steps 8 to 12". No new item kind exists, so export, import, the Run view and the Saved copy are unchanged.
- **The wire is fixed at the boundary.** `historyItems` unwraps a stored `tool_call` row into one tool item per call in its `args.calls`, so live and reopened chats give `computerUse.ts` the same item. `toolResultText` passes a `computer_use` result through `keptResult` first. `keptResult` drops image parts and `text_summary`, cuts a capture's text at 2,000 characters, and keeps the size fields of `meta`. It keeps Hermes's shape, so one reader serves live results and older Saved copies. Tool items gain `at`, and the Saved copy keeps it.
- **A step says what Hermes did, in Hermes's words.** Each line is the action as Hermes's own Approval words it (`click at (619, 777)`, `type 'echo hi'`, `key 'return'`, `scroll down x3`, `wait 2s`), the window it aimed at, the delivery when it is foreground, and the outcome. A multimodal result whose text is the action's JSON reads as that action's answer. A stored call has no result, so it reads `unrecorded`, never as done.
- **The card says who holds the screen, and Watch live opens it.** The holder comes from the connection's ScreenControl ([ADR 0217](0217-one-screencontrol-per-connection-owns-the-viewer-id-and-the-lease.md)). The first `computer_use` call on a connection asks Hermes once, so the card knows without the Screen tab.
- **Follow mode is the owner's choice.** Settings → General → Chats → Follow computer use (`followScreen`, off by default) opens the side panel's Screen once for each run that starts in the chat on screen. Closing the Screen keeps it closed until the next run.
- **A refusal is said above the composer.** When the last turn's last `computer_use` call was refused `human_has_control` and a person still holds the screen, a note says who. When the owner holds it from this connection, the note offers Hand back. When the owner's hold is from a dropped connection, or someone else holds it, the note opens the Screen instead. The note goes once the lease is back with Hermes.

## Considered options

- **A `computer` item kind, parsed at the boundary.** It would make a raw result impossible in a step. Rejected: 25 places in 10 files of the app's own source branch on a tool item's kind (measured at 2a1b031), and each would need a twin. One missed would drop steps from export or the Run view without an error.
- **A stored run that `applyEvent` appends steps to.** Rejected: Approvals would move inside it, which forks the Question lifecycle (`isWaiting`, `endWaiting`, the Inbox, `answerApproval`). History would also need grouping a second time.
- **Parse everything at render time, with no boundary changes.** Rejected: the `tool_call` wrapper would leak into the card's parser, and untrimmed element lists would still fill the Saved copy.
- **Show the screenshots in the card.** Rejected: the Screen tab is the live view, and ADR 0061's reasons for keeping images out of the chat still hold.

## Consequences

- A 20-step `computer_use` turn reads as one card with 20 lines. Every recorded turn in `src/hermes/fixtures/computer-use/` is replayed through the real transport and Saved copy in tests, and none leaves a base64 run of 1,024 or more characters, an `image_url` part or a `text_summary` in the Saved copy.
- A capture's element list past 2,000 characters is not in the transcript. The Screen tab and Hermes's own cache keep the screen.
- Saved copies written before this change keep their `tool_call` rows as plain tool rows until the chat is opened again and its history is read.
- Until Approvals carry their computer-use details, a computer-use Approval is told apart by its command starting with `computer_use: `. [ADR 0215](0215-a-cua-approval-names-its-action-target-and-delivery-scope.md) replaces that with the parsed pattern key.
