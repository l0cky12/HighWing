# The Preview's page size row is removed

> **Accepted.** It supersedes ADR 0198.

The owner doesn't want the Preview to change a web page's size or show how it looks on other devices. They asked for the page size row to go: the Device select (Responsive and the 17 devices), the Width and Height fields, and the scaling behind them.

## Decisions

- **A web page always fills the Preview's box.** The row under the address is gone. So are the device list, the side check, the fit, and the 8-pixel ground a sized page kept around it.
- **Everything only the row used goes with it.** On Linux the page view's placement no longer carries a size, and Rust no longer zooms the view (`Placement.page`, `PageSize` and `Placement::view_at` in `page_view.rs`). On Windows the frame is no longer laid out at a size and scaled, and its still no longer carries a page size. A size change no longer ends an annotation (ADR 0094), because there is none.
- **A still on Linux keeps the font DPI's zoom out.** ADR 0198 made a still divide the view's pixels by the font DPI's zoom as well as the page's (`Xft.dpi: 144` makes it 1.5). The page's zoom is gone, but the view is still zoomed by the font DPI, so the still keeps dividing by it (`Placement::app_zoom`). Without it a pick at 1.5 lands a third off. `page_view.rs`'s `a_pick_finds_what_is_there_at_any_font_dpi` checks it, run as is and with `GDK_DPI_SCALE=1.5`.
- **Nothing to clean up.** The size was never saved (ADR 0198), so an older install keeps nothing of it.

## Considered options

- **Hide the row behind a setting.** Rejected: the owner asked for the feature to go, and a hidden row still costs code, tests and review, as ADR 0204 found for three screens.

## Consequences

- A page's `devicePixelRatio` on Linux is this computer's again, as the zoom no longer lowers it.
- To see a page at a phone's size, the owner opens it in their browser (Open in your browser) and uses its own device toolbar.
