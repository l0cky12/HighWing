# The canonical protocol's core is built behind a gate only tests open

> **Accepted.** Step 3 of the plan in issue #36, which is step 4 of [ADR 0174](0174-the-canonical-session-protocol-stays-refused-until-an-adapter-covers-every-method-on-a-real-gateway.md)'s order of work, split in two. It changes nothing the app does: a canonical gateway is still refused at sign-in with the same words ([ADR 0003](0003-sign-in-through-ssh-tunnel-to-the-dashboard.md), [ADR 0044](0044-capabilities-are-what-hermes-says-or-answers-checked-only-by-reading.md)), and a legacy server gets the frames it got before. It answers ADR 0174's open questions 1 and 2 as the owner did. The code is `src/hermes/canonicalProtocol.ts`.

ADR 0208 put every session frame behind one `SessionProtocol`, with only the legacy implementation. FakeHermes has a canonical mode, held to a real gateway by shared flows. This step adds the canonical implementation for what a chat needs to run a turn: sessions, messages, Approvals, Clarify and Stop. The session edits and the other methods ADR 0174 lists come in the next step, and the refusal comes off in the one after.

## Decisions

- **A gate only tests open.** `negotiate` picks `CanonicalProtocol` for a `gateway.ready` with `session_authority` only while `canonicalGate.open` is true. No app code sets it, and `sessionProtocol.test.ts` fails when a file outside the tests does. Setup's connection test calls the same `negotiate`, so the sign-in screen refuses the same servers. The step that lifts the refusal deletes the gate.
- **What the protocol keeps, per session it attached.** The subscription, the execution generation, the revision, the replay epoch and last sequence, whether a turn runs, the seeded context not sent yet, and each waiting prompt with the generation of the turn that asked. The create or resume snapshot fills it. Each event's envelope and each `session.info` keep it current. It is in one map in the protocol, per connection, and a reconnect builds it again from the resume snapshot. On this protocol a session's id on the socket is its stored id.
- **Three methods only the canonical protocol sends.** `clarify.respond`, `session.detach` and `session.info` are in `CANONICAL_METHODS` in `canonicalVerbs.ts`. The protocol's port takes them, and `Hermes.request` can't. They have no row in `APP_VERBS`, which maps the app's legacy frames.
- **An Approval or a Clarify question is an event, read as the request the transport already shows.** `approval.request` becomes an `approval` request whose id and request id are the prompt id, and whose offered choices are the grants it allows. Each `clarify.request` asks one question, so it becomes a Clarify card of one question whose id is the prompt id. A waiting prompt in a resume snapshot becomes the same card. `approval.settled` and `clarify.settled` become `request.cancel`, so a card another window answered, or one Stop withdrew, closes. Its note is "Hermes stopped waiting for an answer".
- **An answer names the prompt and its turn.** `approval.respond` and `clarify.respond` carry the session, the prompt id and the generation the prompt was asked in. `already_resolved` and `stale_generation` read as stale, as a legacy answer Hermes no longer waited for does. Sudo and Secret questions are still server→client requests on this protocol, and are answered as on a legacy server.
- **Stop names the turn.** `session.interrupt` carries the generation the protocol last heard for the session.
- **A message carries a submission id.** `prompt.submit` has a `submission_id` of its own, and an attached image's stored path in `attachments`. Hermes held a message when it answers `queued` while a turn runs.
- **Project instructions and Referenced chats go with the first message.** ADR 0174's open question 1. A canonical `session.create` refuses hidden messages, so the protocol keeps what a legacy server would have seeded and sends it as attached context with the chat's first message, as a Referenced chat's summary goes (ADR 0165). A message after it carries none.
- **One Source for this app's chats and Hermes Desktop's.** ADR 0174's open question 2. Hermes files a chat as this app's until its first turn, then as `local` with `created_source: desktop`, which the app shows as Hermes Desktop's. The app keeps that, and asks Hermes for no source of its own.
- **Nothing to ask for open requests.** A legacy server lists the requests it waits on, and the app closes a Clarify card no list names. A canonical gateway closes a prompt with `*.settled`, and a list wouldn't name a prompt, so `openRequests` answers that Hermes doesn't say.
- **The transport's core suite runs on both modes.** `sessionProtocol.transport.test.ts` drives the app's own transport through a new chat, a streamed reply, project instructions, Approvals, Clarify, Stop, a chat's Source and a reconnect in the middle of a turn, on FakeHermes as a legacy dashboard and as a canonical gateway, and checks that each mode ran on its own protocol.

## What the next step adds

These answer with an error naming the canonical protocol, or are left as on a legacy server, until then:

- The session edits: rename, folder, branch, undo, compact and a model pick (`session.mutate`, fenced on the revision and generation). A model, effort or fast mode picked for a new chat sends only the model and provider.
- `/steer`, and the model and effort writes `config.set` refuses.
- Diagnostics' Approval check.
- A message whose answer was lost, sent again with the same payload and `submission_id` (ADR 0174 "A message is sent once"). Until then a canonical connection has the legacy path's "may have been sent" state.
- A reply's text so far, when a running chat is resumed. The canonical snapshot has none. Whether `session.events.since` with the replay epoch gives it is unchecked.
- Skip on a Clarify question, which sends an empty answer. No real gateway has been asked what that does.
- Seeded context, which a reconnect before the first message drops.
- The live test of this implementation against a real gateway.

## Considered options

- **Open the gate with a parameter of `connect`.** Rejected: `connect` is how the app signs in, and a parameter there is one the app could pass. A module flag that a test sets, and a test that no app file sets, keeps the switch out of the app's reach.
- **Run all of `transport.test.ts` on both modes.** Rejected for this step: most of its tests check the legacy frames themselves, and many are edits the next step adds. The suite that runs on both is the flows of this step, and it grows with each step.
- **Add rows to `APP_VERBS` for the canonical-only methods.** Rejected: each row is a legacy frame the app sends and the live test sends to a canonical gateway to record its answer. A canonical method has no legacy frame.
- **Map a settled prompt to "answered in another Hermes client".** Rejected: Stop settles prompts too, so the protocol can't tell which it was.

## Consequences

- Nothing changes for the owner.
- A change to a session operation updates both protocols, and `sessionProtocol.test.ts` holds each one's frames as text.
- `frames-diff` against the base shows the legacy frames unchanged. The new tests are listed as only on the checkout.
