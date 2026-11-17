# The Preview lays a web page out at a size the owner picks

> **Accepted.** The row is `ViewportBar` in `src/ui/PageViewport.tsx`, with the device list, the side check (`parseSide`) and the fit (`fitScale`). On Linux the size travels in the page view's placement (`Placement.page`), and Rust zooms the view to it (`Placement::view_at` in `src-tauri/src/page_view.rs`). Tested in `src/ui/pageViewport.test.ts`, `src/ui/previewPane.test.tsx`, `src/ui/pagePlacement.test.ts`, and `page_view.rs`'s unit and display tests.

The owner wanted to see a page in the Preview the way a phone or a tablet lays it out, from a menu like the one in Chrome's device toolbar. The menu has Responsive, then 17 devices under Standard, each with its width and height, and a width and height the owner can type.

## Decisions

- **A row under the address, for web pages only.** It holds the Device select (Responsive, then the 17 devices under Standard) and the Width and Height fields. A device fills in its size. Typing a size makes the select read Responsive at that size, because the size is no longer that device's. That reading is a hidden option of its own, so picking Responsive from it is a change, and gives the page the Preview's box again. A size that applies clears what the fields had typed. While the page fills the box, the fields show the box's size as their placeholders.
- **Only the size changes.** The page keeps this computer's user agent, pointer and touch. The row's tooltip says so. Its screen density shows as zoomed (below).
- **A side is a whole number of CSS pixels from 50 to 9999.** It applies on Enter or on leaving the field. Anything else (empty, a sign, a fraction, an exponent, units, a leading zero) marks the field invalid and changes nothing. Escape puts the field back. Rust holds the size it is sent to the same rule, and treats any other as no size.
- **A size too big for the box is scaled down to fit, never up.** The page still lays out at the size picked. The row shows the scale, such as 36%. The page sits 8 CSS pixels in from the box's edges, because the pane's resize handle lies over its left edge and the view makes room for it (ADR 0081): a page against that edge lost a strip, and with it its size.
- **On Linux the page view zooms.** The placement sends the size with the box, and Rust sets WebKit's zoom so the page lays out at it in the box's whole pixels. WebKit floors the page's size, and its float arithmetic can land just under a whole number, so Rust aims each side half a CSS pixel over and cuts the view, within the box, to the widest size that lands both. Zooming lays the page out again without loading it: its scroll, its forms and a script's state stay. The view's place, holes and pointer stay as ADR 0081 has them.
- **On Windows the frame is drawn smaller.** The frame is laid out at the size picked, and a CSS transform scales it to the box. Its sandbox, its permissions and its origin stay as ADR 0155 has them.
- **The size stays while the Preview is open.** It holds across the page's own moves, a new address, Back, Forward and Reload. Nothing is saved.
- **A size change ends an annotation** (ADR 0094), and a still that arrives after the change is deleted, because its pixels no longer match the page. A still is measured in the page's own CSS pixels, so a mark on a scaled page lands where the owner pointed: on Linux the view's pixels over its zoom and the font DPI's, and on Windows the frame's box over the size it lays out at.

## Considered options

- **Size the view to the device and let it overflow the box.** Rejected: the view is drawn over the whole app (ADR 0081), so a page larger than the box would cover the chat.
- **Scale the view's pixels rather than zoom the page.** WebKitGTK has no API for a layout size apart from its widget's size. Zoom is the one that lays the page out at another size.
- **Emulate the device: its user agent, touch and pixel density.** Not asked for, and it would make the page differ from a real visit by more than its size.

## Consequences

- **The page's `devicePixelRatio` falls with the zoom on Linux** (0.6 at 60%), so a page that picks images by density gets smaller ones while it is scaled down.
- **Every device lays out exactly in a box the size of the Preview** (all 17, measured in the running app). The view can sit up to 4 pixels short of its box there, showing a strip of the panel's ground at the right or bottom.
- **A typed size far out of the box's shape** (9999 × 50, say) can only land exactly in a view much smaller than its box. Where even that has no whole size, a view a few pixels across, the width is exact and the height comes within one of the view's pixels.
- **The Width placeholder can read a few pixels more than the page has** while the page fills the box: the placeholder is the box's width, and the page loses the strip under the resize handle.
- **An annotation's still fills the pane's width** rather than lining up with the scaled page it was taken from.
