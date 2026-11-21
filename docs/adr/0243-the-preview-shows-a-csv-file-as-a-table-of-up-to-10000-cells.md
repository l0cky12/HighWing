# The Preview shows a CSV file as a table of up to 10,000 cells

> **Accepted.** Issue #30. The parser is `parseDelimited`, `delimiterOf`, `parseTable` and `asTsv` in `src/hermes/documents.ts`. `src/hermes/preview.ts` routes `.csv` and `.tsv` files to the `table` file view (`textView`), and `TableView` in `src/ui/DocumentView.tsx` draws them, in the Preview (`src/ui/PreviewPane.tsx`) and in Server files (`src/ui/FileBrowser.tsx`). Tested in `src/hermes/documents.test.ts`, `src/hermes/preview.test.ts`, `src/ui/previewPane.test.tsx`, `src/ui/fileBrowser.test.tsx` and `e2e/features/preview-table.e2e.tsx`. Timed with `bench.table` in `bench/main.tsx`.

Bots often hand back data as a CSV file: an export, a scrape, a report. The Preview showed it as plain text, so a 30-column file was a wall of commas, and the owner opened it somewhere else to read it.

## Decisions

- **A `.csv` or `.tsv` file shows as a table under its header row**, whether it is a Server file, a file on the dashboard's machine in Server files, a file picked on this computer, or a path in a reply. The file is known by its name. The first row is the header, and it stays at the top while the table scrolls. Columns are as wide as their content, up to 360 px, and the table scrolls sideways.
- **The app parses the file itself, as RFC 4180 says, with no new dependency.** A field in double quotes holds commas, line breaks, and quotes written twice. A file that breaks the rules still shows all its text: a quote inside an unquoted field is kept, text after a closing quote joins the field, and a quote that never closes runs to the end of the file. A blank line is no row, but a line of `""` is a row of one empty field, as a one-column file writes one. A byte-order mark is no text. The parse runs once, where the file is read, and takes 3 to 10 ms for 512 KB.
- **The delimiter is a tab for a `.tsv`.** For a `.csv` it is whichever of comma, tab and semicolon splits the first 20 rows, within the first 64 KB, into the same number of fields, more than one. Excel writes semicolons where the decimal mark is a comma. When none splits them evenly, the one that splits the header into the most fields wins, and a comma when nothing splits it.
- **The read cap is the one the text view already has.** A Server file is read through `GET /api/fs/read-text`, which returns its first 512 KB. A picked file is read by Rust up to its first 512 KB. Server files reads a file whole up to 1 MB and refuses a larger one, as before. A file read only in part loses its last row, which the cut most likely split, unless the read stopped at a row's end. 512 KB of a 10-column file is about 5,000 rows, several times what the table draws, so reading more would only add rows the table leaves out. **Open as text** shows the same text the text view showed.
- **The table draws about 10,000 cells**: as many rows as fit, at the file's width. A file with more than 5,000 columns, so that its header and one row don't fit, shows as text, with a note that it has too many columns for a table. A 10-column file shows its first 1,000 rows, and a 2-column file its first 5,000. A note in the bar says how many rows it shows and of how many (`Showing the first 500 rows of 1,500.`). For a file read only in part, it says how much of the file was read. **Open as text** switches to the file's text, and **Open as table** switches back.
- **A range of cells copies as tab-separated text.** A drag across cells, a Shift+click or Shift with the arrow keys selects a range. Ctrl+A selects every cell drawn, and Esc clears the selection. Ctrl+C puts the range on the clipboard, one line per row and a tab between cells. A cell holding a tab, a line break or a quote is quoted as a spreadsheet quotes it, so it pastes back into one cell. Selecting cells takes the place of selecting the text in them.
- **A row is drawn again only when its selected columns change**, so a drag repaints the rows it covers and not the whole table.

## Measured

On 2026-11-20, `bench.table(rows, cols)` opened the table in WebKitGTK 4.1 under Xvfb (`bench/webkit.py`), on Linux 7.3 with 24 cores. Each time is until painted:

- At 10,000 cells, as shipped, opening took 180 to 285 ms and Ctrl+A took 100 to 172 ms, for 10 × 1,000, 2 × 5,000 and 50 × 200. Growing the selection by a row took 28 to 39 ms, two frames.
- At 50,000 cells, measured before the cap and with cells that could wrap anywhere, which lays out faster, opening took 0.67 to 1.18 s and Ctrl+A 275 to 367 ms. At 20,000 cells, opening took 241 to 272 ms and Ctrl+A 115 to 117 ms.

10,000 cells keeps opening a table near a quarter of a second and selecting every cell under a fifth of one. 20,000 doubles both.

## Considered options

- **A table and text switch on the text view** (issue #30's approach 2). The text view's code highlighting and its Markdown and HTML views would each need to know about the table. A view of its own keeps the two apart.
- **A CSV library** (approach 3). It would be a new dependency that has to meet ADR 0186's bar for files that come from a bot, for a format a small parser handles.
- **Reading the whole file**, up to 25 MB, through `GET /api/fs/read-data-url` as a document is read. The table would still draw the same 10,000 cells, so the rows past them would only add a total to the note. It also needs a new route from Rust for a picked file.
- **Drawing only the rows in view**, as a long chat does (ADR 0138). The table could then show every row read. A table's rows differ in height when a cell wraps, so it would need the same measured spacers and scroll corrections, and Ctrl+A and a drag would cover rows not in the page. It stays an option if 10,000 cells proves too few.
- **Excel's other formats** (`.xlsx`, `.ods`). ADR 0186's reasons still hold.

## Consequences

- A CSV past the cap shows only its first rows. **Open as text** shows the rest of what was read, up to 512 KB, and the file itself has all of it.
- A file named `.csv` that isn't one, such as a log, shows as a one-column table. **Open as text** shows it as before.
- The text in a cell can't be selected on its own. Selecting the cell and pressing Ctrl+C copies all of it.
