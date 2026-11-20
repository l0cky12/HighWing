# Edit bot and Bot setup's card share one picture picker, which crops an upload to a 256 px PNG

> **Accepted.** On 2026-11-20 the owner chose, from mockups, one picture picker for Edit bot and Bot setup's card, with a crop step for an upload. It changes how a picture is chosen in [ADR 0189](0189-a-bot-save-writes-a-field-only-where-hermes-still-has-what-the-owner-saw.md)'s Edit bot and on [ADR 0236](0236-bot-setups-card-sets-the-bots-picture-from-highwings-own-set-or-the-owners-upload.md)'s card. Neither save changes, and the set, its keys and the card's strip stay as ADR 0236 fixes them. The picker is `src/ui/PicturePicker.tsx`. The crop's arithmetic is `src/ui/pictureCrop.ts`, and `src/ui/pictureCanvas.ts` decodes and draws. `src/ui/pictureFile.ts` holds the rules for a file. `src/ui/dropClaim.ts` and `src/ui/pasted.ts` are shared with the composer. Tested in `src/ui/pictureCrop.test.ts`, `src/ui/picturePicker.test.tsx`, `src/ui/bots.test.tsx`, `src/ui/botSetupCard.test.tsx`, `src/ui/split.test.tsx`, `src/ui/projectContext.test.tsx`, and `e2e/features/bot-setup-card.e2e.tsx` and `bot-menu.e2e.tsx`.

Edit bot took a picture only from a file, and sent the file as it was. Hermes stores at most 2 MB, so a phone photo of 5 to 12 MB was refused. Every Hermes client cuts a bot's picture to a circle, so a wide photo was cut off-centre, and differently by each client. Edit bot also didn't offer the twelve pictures that Bot setup's card does. The card's **Upload your own…** followed the same file rules.

## Decisions

- **Edit bot and the card open the same picker.** It is a popover under the control that opened it, with two tabs. Edit bot opens it on **Pictures**, from the picture itself ("Change the picture") or **Choose a picture…**, so Edit bot now offers the set too. **Remove picture** stays. The card keeps its strip, which issue #86 asks for, and **Upload your own…** opens the picker on **Upload**.
- **No Generate tab.** Making a picture with Hermes's image tool stays deferred, for the reasons in ADR 0236.
- **Pictures is the set as a grid, six across.** The bot's picture is marked when it is one of the set. The grid is one tab stop, and the tab stop follows focus. The arrow keys, Home and End move through it, and Enter or Space chooses.
- **Upload takes a file four ways:** dragged onto the picker, pasted, copied in a file manager and pasted, or chosen with **Browse files**.
- **The picker gives a data URL and nothing else.** That is the set's own bytes, or the PNG the crop step makes. Edit bot saves it as it saved a picture before. On the card a set picture is chosen by its `set:<name>` key, as a press on the strip does. Any other picture is kept as the owner's upload under its `photo:<hash>` key, as an uploaded file was before.
- **An upload goes through a crop step.** The image is shown under a circle, the shape every client cuts a picture to. Drag it or use the arrow keys to move it, and the slider zooms up to 4×. **Use picture** keeps the square around the circle as a 256 px PNG, the size of the set's pictures. **Cancel** goes back to Upload.
- **The image always covers the frame.** The crop is a pure function from the image's size, the zoom and the offset to the square that is drawn (`sourceRect`). It clamps the offset at every zoom, so the circle never shows an empty corner. Only `pictureCanvas.ts` touches an image element or a canvas, and tests in jsdom swap it for `fakePictureCanvas.ts`.
- **A file may be up to 25 MB, not 2 MB.** A 256 px PNG is at most about 260 KB, far under the 2 MB Hermes stores, so the file's own size no longer matters to Hermes. 25 MB is what Rust already reads of a dropped image for the composer's thumbnail (`PREVIEW_MAX_BYTES`), so a drop and Browse files refuse the same files. PNG, JPEG and WebP are still the only formats. A file the webview can't decode gets "Couldn't read that file."
- **A drop reaches the picker on both systems.** On Linux, Tauri's native drop event gives a path. Rust has already marked a dropped path as readable, and reads it through `hermes_read_preview`, the command behind the composer's thumbnails. Where the native event is off (Windows), the drop is an HTML5 one that carries the bytes.
- **A drop on the picker is the picker's alone.** Every native drop listener hears every drop, and a composer takes any drop over its pane. So the picker claims the points it covers (`dropClaim.ts`), and the composer and the project's Context card leave a claimed drop alone. The HTML5 drop is stopped at the picker, before the pane's own listener.
- **A paste anywhere goes to the picker while it is open.** It is read as the composer reads one (`pasted.ts`): the files on the paste event, the clipboard's image where WebKitGTK hides it from the event, or the path of a file copied in a file manager, which Rust reads (`attach_copied_files`). Pasted text is left alone.
- **Esc or a press outside closes the picker,** and focus goes back to what opened it. Tab stays inside it. The window losing focus doesn't close it, since Browse files' own dialog takes the focus.

## Considered options

- **Send an upload as the file is, with Hermes's 2 MB limit on it.** This was Edit bot's rule and the card's. Rejected: a phone photo is over 2 MB and was refused, and each client cut a wide photo to a circle off-centre.
- **Fit the upload to the circle without asking, from its middle.** Smaller. Rejected: the owner can't then choose which part of a photo is the face.
- **A crop library.** Not needed: the crop is one small function and one `drawImage` call.
- **Replace the card's strip with the picker.** Rejected: issue #86 asks for the set on the card itself, and one press on the strip is quicker than opening a popover.

## Consequences

- Edit bot no longer sends an upload's own bytes. An upload is always saved as a 256 px PNG. A JPEG or WebP becomes a PNG, and an animated WebP becomes its first frame.
- The webview draws the picture, so the same photo can give slightly different PNG bytes in WebKitGTK and WebView2. The card's key for an upload is made from the PNG, so this changes nothing there.
- The card's strip and the picker's grid both show the set, with two implementations: the strip is native radio inputs that also list the bot's current picture and the upload, and the grid is buttons that list only the set.
- `readPictureFile` is gone from `pictureFile.ts`. Nothing reads a picture file straight to a data URL any more.
- A native drop from a file manager and a paste from the system clipboard can't be driven by a headless test. `picturePicker.test.tsx` fires Tauri's drop event and a paste event at the picker and checks that a path is read through Rust's commands. `split.test.tsx` and `projectContext.test.tsx` check that what is under the picker leaves a claimed drop alone.
