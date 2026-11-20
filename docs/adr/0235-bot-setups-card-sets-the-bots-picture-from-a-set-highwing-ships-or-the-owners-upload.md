# Bot setup's card sets the bot's picture, from a set Highwing ships or the owner's upload

> **Accepted.** Issue #86. The owner chose the design on 2026-11-19, from mockups of all three options below. It adds one row to the card of [ADR 0231](0231-new-bot-asks-only-for-a-name-the-bot-interviews-the-owner-in-its-bot-chat-and-one-card-sets-it-up.md) and changes nothing else there: the interview keeps its five questions. The picture is saved the way Edit bot saves one ([ADR 0189](0189-a-bot-save-writes-a-field-only-where-hermes-still-has-what-the-owner-saw.md)), and its failures follow [ADR 0197](0197-new-bot-rewrites-a-rough-persona-and-applies-chosen-skills-and-tools-read-back.md). The set's names are `BOT_PICTURES` in `src/hermes/botSetupBrief.ts`, its files are `src/assets/bot-pictures/`, and the row is `src/ui/BotSetupPicture.tsx`. On 2026-11-20 the owner chose, from a second set of mockups, one picture picker for the card and Edit bot, with a crop step for an upload. The picker is `src/ui/PicturePicker.tsx`, and the crop's arithmetic is `src/ui/pictureCrop.ts`.

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
- **The Picture row sits after Colour.** It shows the picture, its name and what it suits, with a tick. Under it is the whole set as a strip, the pick marked, and **Upload your own…**, which opens the picture picker on its Upload tab. The strip is one tab stop: arrow keys, Home and End move along it, and Enter or Space picks.
- **The owner's pick is a choice like any other on the card.** It is kept on a newer block unless the bot changes the picture to one the owner hasn't moved away from.
- **An upload is kept in the app's memory until Set it up sends it,** like a key Connect takes (ADR 0231, owner call 4). A reload drops it. The card then still names its key, has nothing to send, and says to upload it again.
- **Set up again shows a changed picture as before → after,** both drawn, with "before" read from Hermes when the card is drawn. A picture that stays is unticked and folds away with the rest.

### The picture picker

- **Edit bot and the card open the same picker.** It is a popover under the control that opened it, with two tabs. Edit bot opens it on **Pictures**, from the picture itself or **Choose a picture…**, so Edit bot now offers the set too. The card keeps its strip, which issue #86 asks for, and **Upload your own…** opens the picker on **Upload**. There is no Generate tab: making a picture stays deferred, as below.
- **Pictures is the set as a grid, five across.** The bot's picture is marked when it is one of the set. The grid is one tab stop: the arrow keys move through it, and Enter or Space chooses.
- **Upload takes a file four ways:** dragged onto the picker, pasted, copied in a file manager and pasted, or chosen with **Browse files**.
- **The picker gives a data URL and nothing else.** That is the set's own bytes, or the PNG the crop step makes. Edit bot and the card save it as they saved a picture before, so nothing about either save changes.
- **An upload goes through a crop step.** Every Hermes client cuts a bot's picture to a circle, so the image is shown under a circle: drag it or use the arrow keys to move it, and the slider zooms up to 4×. **Use picture** keeps the square around the circle as a 256 px PNG, the size of the set's pictures. **Cancel** goes back to Upload.
- **The image always covers the frame.** The crop is a pure function from the image's size, the zoom and the offset to the square that is drawn (`sourceRect`). It clamps the offset at every zoom, so the circle never shows an empty corner. Only `src/ui/pictureCanvas.ts` touches an image element or a canvas.
- **A file may be up to 25 MB, not 2 MB.** A 256 px PNG is at most about 260 KB, far under the 2 MB Hermes stores, so the file's own size no longer matters to Hermes. A phone photo of 5 to 12 MB is now taken. 25 MB is what Rust already reads of a dropped image for the composer's thumbnail (`PREVIEW_MAX_BYTES`), so a drop and Browse files refuse the same files. PNG, JPEG and WebP are still the only formats. A file the webview can't decode gets "Couldn't read that file."
- **A drop reaches the picker on both systems.** On Linux, Tauri's native drop event gives a path. Rust has already marked a dropped path as readable, and reads it through `hermes_read_preview`, the command behind the composer's thumbnails. Where the native event is off (Windows), the drop is an HTML5 one that carries the bytes.
- **A drop on the picker is the picker's alone.** Every native drop listener hears every drop, and a composer takes any drop over its pane. So the picker claims the points it covers (`src/ui/dropClaim.ts`), and the composer and the project's context card leave a claimed drop alone. The HTML5 drop is stopped at the picker, before the pane's own listener.
- **A paste is read as the composer reads one** (`src/ui/pasted.ts`): the files on the paste event, the clipboard's image where WebKitGTK hides it from the event, or the path of a file copied in a file manager, which Rust reads. Pasted text is left alone.
- **Esc or a press outside closes the picker,** and focus goes back to what opened it. The window losing focus doesn't close it, since Browse files' own dialog takes the focus.

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
- **Send an upload as the file is, with Hermes's 2 MB limit on it.** This was the first build of **Upload your own…**, and Edit bot's rule. Rejected: a phone photo is over 2 MB and was refused, and a wide photo was cut to a circle off-centre by each client.
- **Fit the upload to the circle without asking, from its middle.** Smaller. Rejected: the owner can't then choose which part of a photo is the face.
- **A crop library.** Not needed: the crop is one small function and one `drawImage` call.
- **Carry the picture's bytes on the card and in the accepted record.** Rejected: the record's row is sent to the model on every turn.
- **Let a not-found picture's row offer the set anyway.** Not done: a name Hermes or the set doesn't have is a row that can't be changed, as for a model. The owner tells the bot, or uses Edit bot.

## Consequences

- A new bot's card has one more ticked item, and Set it up one more write, a few kilobytes.
- A picture saved from the card is the profile's avatar, so every Hermes client shows it.
- Saving a picture writes the Bot Mode block. New bot already writes one for the bot's name (ADR 0231).
- The card reads the bot's picture each time it is drawn: one more `profiles.list`, and a `profiles.get_asset` when the bot has a picture.
- The app is about 90 KB larger.
- Edit bot offers the set, and no longer sends an upload's own bytes: an upload is always saved as a 256 px PNG. A JPEG or WebP becomes a PNG, and an animated WebP becomes its first frame.
- A picture is drawn by the webview, so the same photo can give slightly different PNG bytes in WebKitGTK and WebView2. The card's key for an upload is of the PNG, so this changes nothing there.
- A pick or an upload made while the bot is still answering the ready turn is dropped when that reply ends, as an edit to any other item is: the card is then read again from what Set it up recorded.

## Verified

- **A model following the brief's picture lines.** `tools/bot-setup-brief/run.py` with `gpt-6.1-sol` at high effort, on this wording, passed all 38 turns: new-mcp 14/14, new 14/14, note 6/6, keep 4/4. Every new bot's card named a picture from the set (`plane`, for the travel bot), and every Set up again card on a bot that has a picture kept it as null. The validator and its controls cover the picture, with mutants for a URL, image data and a name the set doesn't have.
- **The picker in a real browser.** `npm run e2e -- --feature bot-setup-card,bot-menu` runs in headless Chromium, in the dark and the light theme. On the card it uploads an 800 × 600 JPEG, half red and half blue, zooms to 4×, drags the image, and presses Use picture: `profiles.set_asset` then carries a 256 × 256 PNG that is red at both edges, and Hermes reads it back. In Edit bot it picks a set picture, and `profiles.set_asset` carries that picture's own bytes.
- **The picker in the desktop app.** With the `verify-hermes-chat` skill, in WebKitGTK against the stand-in Hermes: Edit bot opened the picker on Pictures with ten pictures, and the arrow keys moved through the grid. A 700 × 280 PNG given to Browse files' input opened the crop step, a drag moved it, and Use picture put a 256 × 256 PNG in the form with focus back on the picture. Save sent one `profiles.set_asset`, and the bot's row showed the picture Hermes read back.
- **Not run:** a native drop from a file manager, and a paste, in the desktop app. No headless driver here can make that drop. `src/ui/picturePicker.test.tsx` fires Tauri's drop event and a paste event at the picker and checks that a path is read through Rust's commands, and `src/ui/split.test.tsx` checks that the composer leaves a claimed drop alone.
