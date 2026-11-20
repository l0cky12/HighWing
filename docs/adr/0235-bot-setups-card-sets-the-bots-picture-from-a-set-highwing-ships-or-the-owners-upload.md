# Bot setup's card sets the bot's picture, from a set Highwing ships or the owner's upload

> **Accepted.** Issue #86. The owner chose the design on 2026-11-19, from mockups of all three options below. It adds one row to the card of [ADR 0231](0231-new-bot-asks-only-for-a-name-the-bot-interviews-the-owner-in-its-bot-chat-and-one-card-sets-it-up.md) and changes nothing else there: the interview keeps its five questions. The picture is saved the way Edit bot saves one ([ADR 0189](0189-a-bot-save-writes-a-field-only-where-hermes-still-has-what-the-owner-saw.md)), and its failures follow [ADR 0197](0197-new-bot-rewrites-a-rough-persona-and-applies-chosen-skills-and-tools-read-back.md). The set's names are `BOT_PICTURES` in `src/hermes/botSetupBrief.ts`, its files are `src/assets/bot-pictures/`, and the row is `src/ui/BotSetupPicture.tsx`.

Bot setup's card set a bot's persona, description, model, colour, skills, toolsets and MCP servers, but not its picture. A new bot kept its initial as its face until the owner opened Edit bot. The owner wants the card to set the picture too, so a new bot needs no trip to Edit bot.

## Decisions

### The set

- **Highwing ships ten pictures of its own:** plane, moon, sun, book, pen, wrench, chart, leaf, pot and compass. Each is a 256 px PNG under 10 KB, drawn by `scripts/bot-pictures.mjs` in the app icon's style, and far under Hermes's 2 MB limit. Each stands for something a bot helps with (plane for travel, pot for cooking), which the card says beside its name.
- **They are built into the app as data URLs** (`src/hermes/botPictures.ts`), about 90 KB in all. The card draws them with no request, and the bytes Set it up sends are the app's own.
- **They are not Hermes's desktop shape faces.** Highwing doesn't draw those, and writing the Bot Mode block's `shape` key would edit a key ADR 0189 leaves to Hermes's desktop.

### What the bot may say

- **The bot only names one.** The brief's INVENTORY lists the ten names, and the block gains a `picture` key that holds one of them. A new bot's brief asks for one that suits what the bot will help with, never null. Set up again's brief says null keeps the picture, and asks for a name only when the bot has no picture or the owner asks for a new one. Its CURRENT says which picture the bot has: the set's name when the bytes match one, `"uploaded"` for any other, or null.
- **Nothing in the block's `picture` reaches Hermes or the screen but a name matched to the set.** A name the set doesn't have shows as not found, with the bot's spelling as text, and can't be ticked: the rule for skills and models in ADR 0231. That covers a URL and image data. Neither is ever drawn or sent.
- **A block without the key still reads,** as one that keeps the picture. Blocks written before this change have none. Such a block keeps its card id, so what the owner accepted on it still applies: a null picture is left out of the id's hash.
- **An explicit null on a new bot's block reads the same way.** It can't be told from "keep" without refusing the older blocks too. The row then shows no picture and offers the set.

### On the card

- **A picture is a key, never its bytes.** The key is a fingerprint of the image's base64, without the data URL's label, which is how ADR 0189 already compares two pictures. The accepted record rides in the hidden ready-turn row, and Hermes sends that row to the model on every turn, so it must not carry an image. A record's picture value reads only as null or 16 hex digits. A key also lets the app recognise a picture Hermes holds as one of the set's.
- **The Picture row sits after Colour.** It shows the picture, its name and what it suits, with a tick. Under it is the whole set as a strip, the pick marked, and **Upload your own…**, which takes a PNG, JPEG or WebP of up to 2 MB through the same code as Edit bot's picker (`src/ui/pictureFile.ts`). The strip is one tab stop: arrow keys, Home and End move along it, and Enter or Space picks.
- **The owner's pick is a choice like any other on the card.** It is kept on a newer block unless the bot changes the picture to one the owner hasn't moved away from.
- **An upload is kept in the app's memory until Set it up sends it,** like a key Connect takes (ADR 0231, owner call 4). A reload drops it. The card then still names its key, has nothing to send, and says to upload it again.
- **Set up again shows a changed picture as before → after,** both drawn, with "before" read from Hermes when the card is drawn. A picture that stays is unticked and folds away with the rest.

### Set it up

- **A ticked picture is saved through `Hermes.editBot`.** That is `profiles.set_asset`, then `custom: true` and `imageKind: "photo"` in the Bot Mode block, then a read of `profiles.get_asset`. The row is applied only when that read returns the same bytes. Any other outcome fails the row with the reason and **Try again**. A picture changed elsewhere since the card was drawn is kept, and the row says so.
- **An unticked row, a not-found row and an unavailable row send nothing.**
- **A Hermes that can't save a picture shows the row as unavailable, with the reason.** That is a Hermes found to lack `profiles.set_asset` or `profiles.configure`, or one whose `profiles.list` rows report no `ui_meta_revisions`, the same three cases in which Edit bot turns its picture buttons off or refuses the save. It is a status of the plan's item, not a failure at Set it up, so the row can't be ticked and every other item applies as before. A missing method is known only after a write has failed on it once (`src/hermes/capabilities.ts`), so the first Set it up on such a Hermes fails the row with that reason, and the card shows it unavailable from then on.
- **The ready turn names the picture** (`your picture: moon`), or says the owner uploaded one.

## Considered options

Mockups of all three were shown to the owner on 2026-11-19.

- **Upload on the card only.** The least to build: Edit bot's picker on the card. Rejected because most new bots would end up with no picture, since the owner rarely has a file ready during setup. It survives as **Upload your own…**.
- **The bot makes one with Hermes's image tool (`image.generate`), after a sixth interview question.** The most personal. Rejected for now:
  - It needs an image service set up in Hermes, and costs money on each try.
  - It takes 40 to 60 s on a remote image service.
  - Its results differ every time, so tests need a stand-in.
  - Hermes may send up to 8 MB, against the picture's 2 MB limit.
  - It changes ADR 0231's fixed five questions.

  It could come back later as a **Make one** button that shows only when Hermes reports an image tool.
- **Carry the picture's bytes on the card and in the accepted record.** Rejected: the record's row is sent to the model on every turn.
- **Let a not-found picture's row offer the set anyway.** Not done: a name Hermes or the set doesn't have is a row that can't be changed, as for a model. The owner tells the bot, or uses Edit bot.

## Consequences

- A new bot's card has one more ticked item, and Set it up one more write, a few kilobytes.
- A picture saved from the card is the profile's avatar, so every Hermes client shows it.
- Saving a picture writes the Bot Mode block. New bot already writes one for the bot's name (ADR 0231).
- The card reads the bot's picture each time it is drawn: one more `profiles.list`, and a `profiles.get_asset` when the bot has a picture.
- The app is about 90 KB larger.
- A pick or an upload made while the bot is still answering the ready turn is dropped when that reply ends, as an edit to any other item is: the card is then read again from what Set it up recorded.

## Verified

- **A model following the brief's picture lines.** `tools/bot-setup-brief/run.py` with `gpt-6.1-sol` at high effort, on this wording, passed all 38 turns: new-mcp 14/14, new 14/14, note 6/6, keep 4/4. Every new bot's card named a picture from the set (`plane`, for the travel bot), and every Set up again card on a bot that has a picture kept it as null. The validator and its controls cover the picture, with mutants for a URL, image data and a name the set doesn't have.
