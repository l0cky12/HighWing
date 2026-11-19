# A bot picked from the @ menu asks in an ordinary chat, and a typed @ stays words

> **Accepted.** It changes ADR 0232, which limited an ask to a Bot Chat, and ADR 0165, which said a chat never references the chat it is written in. The mark and the rule are `src/hermes/mentionPicker.ts` (`PICK_MARK`, `AskRule`, `mentionsFor`, `withoutPick`, `withPicks`) and `src/hermes/chatKind.ts` (`ChatPolicy.asks`, `askRule`). The ask keeps the chat it came from in `src/hermes/asks.ts`, and `src/App.tsx` (`askHost`) decides which chats can ask. Tested in `src/hermes/mentionPicker.test.ts`, `src/hermes/mentionPicker.property.test.ts`, `src/hermes/asks.test.ts`, `src/hermes/chatKind.test.ts`, `src/hermes/asks.transport.test.ts`, `src/ui/asks.test.tsx`, `src/ui/sideQuestions.test.tsx`, `src/ui/slashCommands.test.tsx`, `src/ui/queue.test.tsx` and `e2e/features/pick-a-bot.e2e.tsx`. Issue #58.

The owner wants to bring a bot into the chat they are in and have it answer, as they can from a Bot Chat (ADR 0232). Issue #58 chose to send the owner's own message to the named bot's Bot Chat through ADR 0232's path, with no change to Hermes. Hermes's title gate on `message_agent` is deliberate, so a chat's own bot can't be asked to do it.

One thing in ADR 0232 can't carry over. A Bot Chat reads every `@handle` in the words as a pill, because the owner is there to talk to bots. In an ordinary chat `@bram` is also a word in a sentence, and these would have left the chat with its own bot taking no turn:

| Words | Today in a Bot Chat |
| --- | --- |
| What did @bram say about the budget yesterday? | Ask to bram |
| Rewrite this tweet: thanks @hermes for the help! | Ask to hermes |
| @work is my job profile, explain it | Ask to work |

Compare adds a second problem. It calls `deliver` once for each pane, and an ask sends the message to the named bot instead. An ordinary chat that could ask in Compare would send the same ask twice, and neither compared chat would answer.

## Decisions

- **A bot picked from the @ menu is written as `@`, U+200D, then the handle.** `completeMention` writes it for every pick, in every chat. Typing and dictation never produce it. It is part of the words, so a saved draft, Undo and Redo keep it. U+200D right after the `@` joins the `@` into one grapheme, so the caret has no extra stop (`Intl.Segmenter` says so, and `e2e/features/pick-a-bot.e2e.tsx` counts the ArrowLeft presses in Chromium). `PICK_MARK` is named once, in `mentionPicker.ts`.
- **A mention knows whether it was picked, and its range covers the mark.** `Mention` has `picked`. One Backspace takes the pill out by its range (ADR 0165, #87), so the mark goes with it.
- **Which mentions ask is the chat kind's rule.** `ChatPolicy.asks` is `named` for a Bot Chat (picked or typed, as ADR 0232 had it), `picked` for an ordinary chat, and `none` for an Imported chat and a Job run. An Imported chat and a Job run have no composer, so `none` states what is already true. The pills, `askTargets` and the chip for this chat all read mentions through `mentionsFor(text, bots, rule)`, so they can't disagree. A typed `@bram` in an ordinary chat is plain words. It has no pill, makes no ask, and goes to this chat's bot.
- **Compare takes an ordinary chat's asks away.** `askRule(policy, comparing)` gives `none` while comparing, so the menu lists no bots and nothing the chat sends is an ask. A picked pill already in the draft goes to both compared chats as plain words. A Bot Chat keeps ADR 0232's behaviour.
- **The mark goes no further than the composer.** `withoutPick` removes `@` plus the mark where the words leave: the one place `Composer` builds the words to send, queue, steer or ask with, the plain copy the slash commands read for a command's, skill's or extension's arguments, a new chat's draft sent by itself (a project's Start box), and an edited queued message, where a pill pasted from the composer would carry its mark. The pills are read before the strip. Only a mark right after an `@` goes, so an emoji sequence the owner typed keeps its joiners. The card's words, the Ask's text and the message Hermes stores never hold it. The draft keeps it.
- **The menu lists the bots above the chats in an ordinary chat too.** It lists `otherBots`: every bot on the connection except the shown profile's own, and none without Bots mode or with no other bot, so a chat's menu on a single-bot Hermes is as it was. A chat that hasn't started has no ask: it has no transcript to hold a card and nothing to summarize.
- **An ask records the chat it came from.** `Ask.chat` is the ordinary chat's id and title. A Bot Chat's asks have none, as the profile has one Bot Chat, and neither do asks stored before this change. `askedIn` gives each chat its own cards, so an ordinary chat shows the asks made from it and no others, and the Bot Chat keeps showing the profile's.
- **The chat being written in goes along as a chip once a bot is picked and the chat has history.** It is titled with the chat's own title; a Bot Chat's stays "Bot Chat with <bot>". This is the change to ADR 0165. A summary of an ordinary chat goes into another profile's Bot Chat, and the owner can remove the chip before sending.
- **The stamp says where the ask came from.** For an ordinary chat it reads `[Asked from: chat "<title>" with <name> · <id>]` and the sentence below it says the owner wrote this in their chat. The title goes through the same one-line treatment as the bot's name, then `neutralize`, so a title with a line break, ` · ` or an `@file:` can't add a second stamp, change the id read back, or make Hermes expand a file. The stamp line still ends ` · <id>]`, which `STAMPS` reads.
- **Edit puts the picks back.** Edit on a failed ask returns the words, and in an ordinary chat the failed bots' `@handle` come back picked (`withPicks`), so sending them asks again. Otherwise the words would go to this chat's bot.

## Considered options

The owner's comment on #58 ran each way to tell a picked pill from a typed one over a prototype of `mentionsIn` and `completeMention`.

| Scenario | A. Kept ranges | B. Marker in the text | C. Leading `@` only |
| --- | --- | --- | --- |
| Picked at the start | Ask | Ask | Ask |
| Picked mid-sentence | Ask | Ask | Missed |
| Picked, draft restored after a restart | Missed | Ask | Ask |
| Picked, then Undo and Redo | Missed | Ask | Missed |
| Typed `@bram` mid-sentence | Chat | Chat | Chat |
| Typed at the start, not meant as an ask | Chat | Chat | Ask |

- **A, keep the picked ranges beside the draft.** The ranges drift or are lost through Undo, a saved draft, dictation and edits, which ADR 0165's #87 chose pills from the words to avoid.
- **C, an ask only when the message starts with `@handle`.** It misses a pick in the middle of a sentence, and it turns a message that happens to start with a handle into an ask.
- **B, a mark in the text.** It is the only one right in every row. The mark is part of the words, so every place that keeps words keeps it, and the strip at the end of the composer is the one place that has to know. It also keeps #87's rule that pills come from the words.
- **U+2060, the word joiner.** `Intl.Segmenter` counts it as a stop of its own, so the caret would stop between `@` and the handle. U+200D doesn't.
- **A Hermes change.** Hermes would let a chat's bot message another. Its title gate is a containment rule, a grant keyed on the client's `source` was refused upstream, and the tool needs the "Bots message each other" switch that the owner's `@` must work without (ADR 0207, 0232).

## Consequences

- Copying a picked pill out of the composer copies the mark with it. Pasted into another composer it is a picked pill again. Pasted into another app it is invisible.
- A hand-typed ZERO WIDTH JOINER right after an `@` counts as a pick. Nothing types one.
- The caret and Backspace were checked in Chromium, where U+2060 gives an extra stop and U+200D gives none, and in the Linux app's WebKitGTK webview with the verify skill's recipe, where five ArrowRight presses cross `@bram`. Windows' WebView2 wasn't checked.
- The asks of a chat that is later deleted stay in the record, never shown, until newer asks push them out at 100 per profile.
- Reopening an ordinary chat draws its cards from the record with no request, as a Bot Chat does. Nothing reads other bots' Bot Chats when a chat opens.
- In an ordinary chat the owner picks a bot from the menu. Typing its handle in full doesn't ask.
