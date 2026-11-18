# A cua Approval names its action, target and delivery scope

> **Accepted.** Phase 3 of computer use (issue #43). Builds on [ADR 0216](0216-a-computer-use-run-reads-as-one-card-and-the-transcript-keeps-a-trimmed-result.md), whose card places an Approval under the step it gates, and on the recordings of [ADR 0213](0213-computer-use-shapes-are-recorded-from-a-real-hermes-and-kept-as-fixtures.md).

Hermes asks the owner before each `computer_use` input action, and the answers are the ones every Approval has: once, for the chat, always, deny. The card read like a terminal command: `computer_use: click at (619, 777)`, with the delivery mode buried in a trailing `[FOREGROUND — …]` note. Hermes grants by a pattern key, `cua:<action>:<background|foreground>`, so "Allow for this chat" covers one action in one delivery mode, and the other mode asks again. The card said none of that. An owner who allowed background clicks could not tell that a foreground click, which raises the window and moves the focus, would still ask. Until this phase a computer-use Approval was told apart by its command starting with `computer_use: `.

## Decisions

- **The Approval carries `cua?: CuAsk`.** `approvalItem` parses the request's `pattern_key` once, through `askOf` in `src/hermes/computerUse.ts`, into `{verb, scope, target, patternKey}`. `scope` is `background` or `foreground`. `target` is the command with its `computer_use: ` prefix and its foreground note taken off. A request whose key isn't a `cua:` one gets no `cua`, whatever its command says, so the command-prefix stopgap is gone. `foldRuns` places an Approval under its step by `cua`.
- **`bring_to_front` is a verb of its own.** Hermes asks for it as a second scope on a call that keeps the window raised (`cua:bring_to_front:foreground`). It reads and grants as its own verb, with its own words.
- **The card names the action and the scope.** The heading is Hermes's action in the owner's language ("Hermes wants to click at (619, 777)"). A chip says Background input or Foreground input, with a sentence on what that does to the window. When the gated step named a window, the card says it. The Inbox shows the same card, without a window, because it has no step.
- **The buttons name what they grant.** Approve once and Deny stay as they are. The two broader answers read "Allow background clicks for this chat…" and "Always allow background clicks…". `grantWords` builds that phrase from the verb and scope, in the owner's language, so "foreground key presses" is one string in English and "pulsaciones de tecla en primer plano" is another. A verb without its own noun reads "background <verb> actions".
- **The second step still guards both grants, and it says what they cover.** `ConfirmGrant` asks for the same confirmation as before and, for a cua Approval, says exactly what the grant covers and that the other delivery mode still asks: "Allow foreground typing for the rest of this chat? … The background version still asks." Nothing else about answering changes: `answerApproval` still sends `approval.respond {session_id, choice, request_id}` and still refuses a session or always answer the owner hasn't confirmed.
- **FakeHermes grants by pattern key.** A session grant is kept per session and an always grant for the server, both by `cua:<action>:<mode>`, as Hermes keeps them. A granted key doesn't ask again and the other mode does. A Deny answers with Hermes's recorded `BLOCKED: Action denied by user.` result, which the step reads as denied.

## Considered options

- **Read the verb and scope out of the command text.** Rejected: the command is display text, and the foreground note is a sentence Hermes may reword. The pattern key is what Hermes grants by, so reading it keeps the card's words and the grant in agreement.
- **A generic "Allow for this chat…" with a scope chip beside it.** Rejected: the owner clicks the button, not the chip, and the grant is what matters. Putting the scope in the button's own words makes the choice legible where it is made.
- **A separate card component for computer use.** Rejected: the lifecycle, the arming delay, the focus rules and the confirmation step all live in `ApprovalCard`. A second card would copy them, and the Inbox would need both.

## Consequences

- An owner can tell, before answering, whether a grant covers background or foreground input, and is told in the confirmation that the other mode still asks.
- Saved copies written before this change hold computer-use Approvals with no `cua`. They read as plain Approvals, outside the run card.
- A pattern key that isn't `cua:<verb>:<scope>` is shown as an ordinary Approval, with its command. A new delivery mode from Hermes needs a case in `askOf` before the card names it.
