# Mark up draws one box on a copy of a staged image, in the webview

> **Accepted.** Issue #32. Builds on [ADR 0145](0145-each-chat-keeps-its-staged-attachments-until-sent-removed-or-gone.md) (each chat's staged attachments) and [ADR 0200](0200-a-later-image-goes-where-it-was-added-as-a-numbered-mark-in-the-words.md) (image numbers and marks). Reuses the look of [ADR 0094](0094-an-annotation-is-picked-on-a-still-of-the-preview-and-sent-as-a-screenshot-and-words.md)'s annotations but none of its staging.

A staged image (pasted, dropped, picked or copied) has a **Mark up** button on its thumbnail. It opens a dialog over the chat pane with the image as large as the pane allows. The owner drags one box over what they mean and types a note. **Add to message**, or Enter in the note, puts a copy of the image with the box drawn on it in the original's place, and adds `Box 1 on shot.png: the note` at the composer's cursor. Cancel or Esc changes nothing. The issue was written when the app could take its own screenshots. [ADR 0212](0212-screenshot-capture-is-removed-and-its-staging-folder-stays-for-pasted-files-and-annotations.md) removed that, so a screenshot now arrives by paste or drop like any other image.

## Decisions

- **The webview draws the box.** The dialog shows the chip's own thumbnail, which the webview has already decoded. On confirm a canvas draws that image at its natural size, strokes a blue band inside the box's edge (the annotation blue, `rgb(37, 99, 235)`) and puts the box's number in a badge at its corner. It works for every format the thumbnail shows (PNG, JPEG, GIF, WebP, BMP) and needs no Rust change. A JPEG stays a JPEG at quality 0.92; anything else becomes a PNG. An image over 100 megapixels isn't marked, since the webview may not give a canvas that big, and a marked copy over Hermes's 25 MB image limit is refused in the dialog.
- **The copy is staged as a paste is.** Its bytes go through `stage_clipboard_file` into the app's own captures folder, then `desk.own` and the usual check. The original is only read. It may be the owner's own file, picked or dropped on Linux by path, and that file is never changed or deleted.
- **A new desk event, `replaced`, swaps the copy in.** The copy takes the original's place in the strip, its image number (so a `[image 2: name]` mark in the words still names it) and its annotation label if it had one. The original is let go, so it is deleted only if the app made it. A repeated swap does nothing. A swap whose original went while the dialog was open (removed, sent, or its chat deleted) stages nothing and deletes the copy.
- **One box a Mark up.** A second drag moves the box rather than adding one. To point at two things, mark the image again: the desk counts the boxes drawn on each staged image, so the next is box 2, drawn on the already marked copy, with its own line in the words.
- **The words name the box and the image, nothing more.** `Box N on name: note`, one line, the note cut to 300 characters with its direction overrides defused. They are typed into the draft where the cursor was, and the owner can edit them before sending. They carry none of an annotation's page fields: a staged image has no address, still time or view.
- **The dialog covers the chat pane only.** It is portaled into the pane's root, so a pane split beside it, and the Preview, stay usable.

## Considered options

Three layouts were built and shown in the real app before choosing:

- **A dialog over the chat pane, the note beside the image.** Chosen. It gives the largest image to draw on, keeps the owner in the chat they are writing in, and leaves the Preview alone.
- **A popover above the composer.** Rejected: the chat stays in view, but the image is small, and a precise box on a full screenshot is hard to draw.
- **The Preview pane, with an annotation-style review card.** Rejected: it would replace whatever the Preview shows, and the card's page fields don't apply to an attached image.

And for the staging:

- **Reuse `annotate::stage` in Rust.** Rejected: it accepts only a PNG the app owns and deletes its input. Pointed at a picked image it refuses; pointed at a pasted one it would delete the original before the owner confirms.
- **Several numbered boxes in one dialog.** Built in the first prototype, up to nine with a note each. Rejected for one box: less to build and read, and marking again covers "this, and also this".
- **Stage the copy as a new image at the end of the strip.** Rejected: it would leave the original staged, or need the owner to remove it, and the copy would get a new number, breaking a mark already in the words.

## Consequences

- Re-encoding drops the original's metadata (EXIF and the like). The photo's orientation is applied, as the thumbnail shows it.
- Each Mark up replaces the image with a new file, so a pasted image marked three times writes and deletes three copies in the captures folder.
- The note goes in the words, not on the image, so Hermes reads it as text. The badge on the image ties the words to the box.
- Marking a Preview annotation keeps its "page changed" label, since the copy is still that annotation.
