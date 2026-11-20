# Mark up an image

The owner pastes or drops a screenshot into the composer, presses **Mark up** on its thumbnail, drags a box over part of it and types a note. **Add to message** puts a copy with the box drawn on it in the original's place, and `Box 1 on <name>: <note>` at the composer's cursor. Cancel or Esc leaves the image and the words as they were. Sending sends the marked image, and the sent message shows it with the box.

## Sub-features

- `markup-open`: a staged image's thumbnail has a Mark up button at its bottom-left, which opens a dialog over the chat pane.
- `markup-box`: dragging on the image draws one blue box; a second drag moves it.
- `markup-note`: the note field takes the keyboard once the box is drawn, and Enter in it adds.
- `markup-add`: the chip keeps its place, its thumbnail shows the box, and the words gain `Box 1 on <name>: <note>`.
- `markup-cancel`: Cancel, the X or Esc closes the dialog and changes nothing.
- `markup-sent`: the sent message shows the marked image, stored by Hermes.

## How to get to it (user POV)

- Paste an image (Ctrl+V) or drop one on the chat, then press the Mark up button on its thumbnail in the composer.

## Driving it with wd.mjs

Preconditions:

- Signed in to the stand-in (see [sign-in.md](sign-in.md)).
- An image on the run's X clipboard: `. $HV_RUN/state.env; DISPLAY=$DISPLAY_NUM xclip -selection clipboard -t image/png -i <some.png>`. xclip forks and owns the clipboard until another program takes it or the display stops, so `hv down` ends it.

- **Open a chat.** Run `$S/wd.mjs click button Archived`, `$S/wd.mjs click '.row-open[data-chat=backup]'`, then `$S/wd.mjs wait .msg.assistant "restic unlock"`.
- **Paste.** Run `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs press Control+v`, then `$S/wd.mjs wait button "Mark up" 15000` and `$S/wd.mjs shot 01-pasted`. The thumbnail shows with Remove at its top-right and Mark up at its bottom-left.
- **Open Mark up.** Run `$S/wd.mjs click button "Mark up"`, then `$S/wd.mjs wait .markup "Drag a box"`. The dialog covers the chat pane and the image fills it; the hint reads "Drag a box over what you mean. Esc cancels."
- **Draw the box.** Run `$S/wd.mjs drag .markup-stage -- 40 40 260 140` (offsets from the image's top-left), then `$S/wd.mjs wait 'input[aria-label="Note for box 1"]'`. A blue box with a `1` badge shows.
- **Type the note.** Run `$S/wd.mjs keys "This header sits too low"` (the note field has focus), then `$S/wd.mjs shot 02-box-and-note`.
- **Add.** Run `$S/wd.mjs press Enter`, then `$S/wd.mjs gone .markup` and `$S/wd.mjs shot 03-added`. The chip shows the box, and `$S/wd.mjs value 'textarea[data-composer]'` ends with `Box 1 on clipboard-….png: This header sits too low` and a newline.
- **Cancel.** Mark up again and draw: the box is numbered on from the first, so the field is `input[aria-label="Note for box 2"]`. Then `$S/wd.mjs press Escape`. The dialog closes, and the words and the chip are unchanged.
- **Send.** Run `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs press Enter`, then `$S/wd.mjs wait .msg.user "This header sits too low"` and `$S/wd.mjs wait ".msg.user img" "" 15000`, then `$S/wd.mjs shot 04-sent`. The sent message shows the image with the box.
- **Proof on the server.** Run `$S/hv state | python3 -c 'import json,sys; print(json.load(sys.stdin)["transcripts"]["backup"][-2])'`. The user row holds the words with `Box 1 on …` and an `@image:/hermes/images/upload_1.png` reference.

## Gotchas

- `wd.mjs wait <css> <ms>` reads the number as text to match. Pass an empty text first: `wait <css> "" 3000`.
- A chat's draft survives a relaunch, so clear it (`press Control+a`, `press Delete` in the composer) before typing words a check depends on.
- Mark up shows only once the thumbnail is drawn; an image the webview can't draw has no button.
- xclip must run on the run's display, not yours, or Ctrl+V pastes nothing. A paste that draws no thumbnail fails silently: `wait button "Mark up"` times out and the words typed next go into the composer.
