# A password manager's questions show as cards, and their values are never kept

> **Accepted.** It reverses the part of ADR 0146 that left a password manager's questions (`vault.*`) unshown. The rows are `vault.unlock_prompt`, `vault.save_login` and `vault.code` in `QUESTIONS` (`src/hermes/transport.ts`), with their parsers beside `secretItem`. The card is `src/ui/QuestionCard.tsx` (`formOf`, `ValueFields`). Tested in `src/hermes/questions.test.ts`, `src/ui/questionCard.test.tsx` and `src/hermes/notifications.test.ts` against `FakeHermes` (`askVaultUnlock`, `askVaultSaveLogin`, `askVaultCode`). Issue #26.

When a bot signs in to a website with a password manager, Hermes can stop the reply and ask the owner one of three things: the manager's master password, a login to save for a sign-in page it has no login for, or a one-time code from the owner's phone or security device. ADR 0146 left these unshown. On a Hermes that shares chats (0.21.3 and later) the app left the question open so the official app could answer it. When Highwing was the only client on the chat, the reply waited with nothing on screen until Hermes gave up, after 120 s for the master password and 180 s for the other two (`tui_gateway/agent_callbacks.py` at `be787439`). Before 0.21.3 the app answered "method not found", and the sign-in failed at once.

The contract is `tui_gateway/contracts/server_requests.py` at `be787439`. The issue read the same contract at `ae2a81c`.

- `vault.unlock_prompt` sends `VaultUnlockRequestParams {backend, display_name}`.
- `vault.save_login` sends `VaultSaveLoginRequestParams {origin, site}`. The answer is the JSON `{identifier, password}`.
- `vault.code` sends `VaultCodeRequestParams {site?, hint?}`.

Each is answered with `ValueResult {value}`, the one-string answer sudo and secret use, and an empty value means skipped. Hermes reads a save-login answer as a login only when it parses as a JSON object with a `password` (`save_login_cb`). It strips spaces and dashes from a code before it types it into the page (`browser_vault_tool.py`).

## Decisions

- **Three more rows in the `QUESTIONS` table, and three more `QuestionItem` kinds.** Each kind is its request's method, as for the other four. Each card shares ADR 0146's lifecycle. It waits until the owner answers or skips it, Hermes withdraws it (`request.cancel`), or Hermes stops listing it after another app answered (`settleQuestions`). A reconnect brings it back as Hermes lists it.
- **A card shows only what parses.** A master-password card needs `display_name` or `backend`, and names the manager by `display_name` when it has one. A save-login card needs `site` or `origin`, and names the site by `site` when it has one. A code card always shows, because Hermes makes both its params optional. Hermes sends an empty `hint` today, and the card then shows no hint. A param that isn't a string counts as missing. A request with nothing to name keeps ADR 0146's unshown handling.
- **The transport writes Hermes's JSON, not the card.** The card gives `QuestionAnswer {kind: "login", identifier, password}`. The `vault.save_login` row turns it into `{value: JSON.stringify({identifier, password})}`, with the user name trimmed. A login with an empty user name or password sends nothing, as in the official app. A `value` answer to a save-login card sends nothing, and neither does a `login` answer to any other card.
- **The values follow ADR 0146's rule, and the user name and code do too.** The master password and the login's password are masked fields. The user name and the code are plain text fields, so the owner can check what they typed, but they are kept the same way. Every field is uncontrolled, with autocomplete and spell check off. React holds only whether every field is filled. Send clears the fields, and any other close removes them. So no value reaches the chat's items, or through them the Saved copy, the chat list kept here, exports, branches, backups or diagnostics. None is a Draft. No error names one. The Run view's step names only the password manager or the site.
- **A desktop notification says a password manager question waits, and nothing more.** `NOTICES.vault` reads "Hermes needs help to sign in" and "A password manager question is waiting for your answer in Highwing." Like every notification, it names no site, no password manager and no chat.
- **Skip sends an empty value on all three.** Hermes reads it as declined: the manager stays locked, the login isn't saved, or no code is typed. The bot then goes on without it, and the reply doesn't stall.

## Considered options

- **Unlock and code only, as the issue's approach 2.** Rejected. A save-login question would still stall the reply for 180 s, and the card work is the same.
- **Answering every `vault.*` request at once with an empty value, as the issue's approach 3.** Rejected. The bot could never use the password manager from Highwing. On a Hermes that shares chats, the first answer settles the question for every client, so the official app would lose its chance to answer.
- **Showing the cards only on a Hermes that shares chats.** Rejected, for the reason ADR 0146 gives: a card is the right answer whenever the request parses.
- **The card writing the JSON and sending it as a `value`.** Rejected. Hermes's wire format belongs to the transport, and a `value` answer would let any string reach Hermes as a login.
- **A masked code field.** Rejected. The owner copies the code from a phone or security device and checks it before sending, and the code stops working within minutes. It is kept nowhere either way.

## Consequences

- When Highwing is the only client on a chat, a bot's sign-in that needs the master password, a login or a code gets an answer from the owner instead of waiting out Hermes's deadline.
- On a Hermes that shares chats, Highwing and the official app both show the card, and the first answer settles it, as for a clarify, sudo or secret question.
- On a Hermes before 0.21.3, a `vault.*` request that parses gets a card instead of "method not found".
- `theme.pick`, `setup_beat` and the window-owned requests still don't show (`docs/compatibility.md`, "Questions the app doesn't show").
- See `docs/compatibility.md`, "Password manager questions".
