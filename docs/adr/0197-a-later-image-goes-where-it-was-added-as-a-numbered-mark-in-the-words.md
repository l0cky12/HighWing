# A later image goes where it was added, as a numbered mark in the words

> **Accepted.** It builds on ADR 0145 (each chat keeps its staged attachments) and changes where a sent message shows its images. The grammar is `src/hermes/inlineImages.ts`. The desk numbers staged images in `src/hermes/screenshots.ts` (`numbersIn`). The composer marks and draws them in `src/ui/ChatPane.tsx` and `src/ui/inlineMarks.tsx`. A sent message places them with `InlineSentImage` in `src/ui/previews.tsx`. Tested in `src/hermes/inlineImages.test.ts`, `src/hermes/screenshots.test.ts`, `src/ui/screenshot.test.tsx`, `src/ui/paste.test.tsx` and `e2e/features/send-image.e2e.tsx`.

Every image the owner added went above the words, in the composer and in the sent message. The owner asked for the first image to stay there, and for each image after it to go on the line where it was added, shown as a small thumbnail with its name and size. That place has to survive sending, Retry, the queue, a restart and reading the chat back from Hermes.

Hermes has no field for where an image goes. `prompt.submit` takes text. `image.attach_bytes` queues an image for the session's next turn. Hermes stores the user's text as it was sent, then one `@image:<path>` line per image, in the order the images were attached (`_build_persist_message_with_image_refs` in `tui_gateway/session_history.py`). The model gets the same text, and the images in the same order, as native image parts or as one hint per image before the text.

## Decisions

- **The place is a mark in the words: `[image 2: shot.png]`.** The number is the image's place among the message's images, counted from 1 in the order they were attached. The name is the file's name here, with `[`, `]` and line breaks turned into `_`. Hermes stores the mark with the words, so the history read back places the image where it was sent. The model reads the same mark beside the second image it is given.
- **An image no mark names goes above the words.** That is the first image the owner added, any file that isn't an image, and an image whose mark the owner deleted. A message sent before this change has no marks, so it shows as it always did.
- **The first image in a composer with no images stays above the words. Each later one is marked at the cursor.** The cursor is read when the owner adds the image, before the file is read and checked. Words typed before that point while it is checked move the mark along with them. In repeated words, where the owner's edit began decides which side of it the mark goes. A batch puts its marks side by side, in the order the files came. If the batch goes into an empty composer, its first image goes above the words.
- **A mark is words.** Undo and Redo take it out and put it back. Backspace after a mark, or Delete before one, takes out the whole mark at once. Taking out a mark never drops its image. The image waits above the words until the owner removes it there or sends it. An annotation stays above the words even while it is marked, since its chip says which page it came from and whether that page has moved on (ADR 0094).
- **The composer numbers staged images in the desk, not by place.** The desk gives each staged image a number per Draft, counting up in the order the images were added. It never gives a number twice while the app runs, and never one a mark in the chat's Draft has given, even after that mark is deleted. Removing an image never renumbers the others. So a mark that Undo, a restart or a message put back brings back never names a different image. On send, `sentText` renumbers each mark by its image's place among the images sent. It drops a mark whose image is no longer staged, and a second mark for one image.
- **The composer draws a mark as a chip over the text.** The words stay in one plain textarea, so IME, selection, spell check, the slash menu, Dictation and undo work as before. A mirror with the textarea's layout, in one box with it, finds where each mark is, and a chip with the thumbnail, name and size covers it. The chip doesn't cover a mark that has the cursor or a selection in it, or a mark that wraps onto a second line, so the owner can see and edit the mark's words.
- **A sent message shows each image once.** Its first mark for an image puts the image there, as the picture above the words would be, and opens it in the Preview the same way. Each picture is kept by its path, so asking to see one image never shows another that a changed mark puts in its place. A placed image shows its name, not its size: Hermes keeps no size for it. A mark whose number the message has no image for, or a second mark for one image, is shown as words.
- **A mark gives an image no new way to be read.** It can only place one of the message's own `@image:` lines. Whether that image is read by itself is still decided by the record of images this app sent. Any other image still waits for Show image. The name is drawn as text.
- **An image finished after the composer moved to another chat gets no mark there.** A file the owner picked, pasted or dropped stays in the chat it was added to, above its words. A screenshot still goes to the composer on screen when it lands (ADR 0145). If that composer is on another chat by then, the screenshot is marked there, at that composer's cursor, never in the chat it left. A late mark never moves the focus.

## Considered options

- **A field for the place, sent with `prompt.submit`.** Hermes has none, and it stores only the text and the `@image:` lines. The place would be lost on the history read back.
- **A per-message record of places kept on this computer.** It would hold for this computer only, and the model would never see which words go with which image.
- **A rich-text editor in place of the textarea.** It would put an image inside the words. It would also mean reimplementing IME, undo, the slash menu, Dictation and annotations on a new editor.
- **The file's name in the mark as the image's identity.** Two files can share a name (`image.png`), so a mark would place the wrong one.
- **Number the composer's marks by the images' places.** Removing an image would renumber the rest, and Undo would bring back a mark naming a different image.

## Consequences

- The model sees the marks in the words. They are short and name only the file, never a path on this computer.
- Text the owner types in the exact form of a mark is read as one, in the composer and in a sent message. It can only move an image of that message.
- A Draft keeps its marks after a restart, but ADR 0145 drops the staged images. The marks show as words then, and are dropped when the message is sent.
- When a new chat can't start, its words and screenshots come back (ADR 0145), but the screenshots get new numbers, so their marks show as words and the images wait above the words. The owner marks them again, or sends them above the words.
- While a message is going out, Hermes hasn't stored its images yet, so its marks show as words until each image is stored.
- A queued message, and a message put back in the composer by Edit, show their marks as words.
