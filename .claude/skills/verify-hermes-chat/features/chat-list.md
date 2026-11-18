# Chat list and the Archived drawer

The chat list beside the chat shows one profile's chats in sections: Pinned, Inbox, Snoozed, and Working last, in the list's scroll. Archived is the one drawer at the panel's foot, outside the scroll, until Settings turns it off (ADR 0090, ADR 0201, ADR 0202). It holds the chats archived in this app (settled, Hermes's `pinned` flag off) and the chats Hermes has archived. Its header opens it upward, to at most half the panel, with its own scroll, and closes it again. The list's right edge drags it between 200 and 560 pixels wide, and Ctrl+=, Ctrl+- and Ctrl+0 zoom the whole app (ADR 0201). Open or closed is kept across restarts. Archive, from a row's hover button or right-click menu, is the one way to clear a chat from the Inbox. Unarchive moves an Archived chat back, and also restores it in Hermes if Hermes has it archived. No control hides a chat in every Hermes client.

## Sub-features

- `drawer`: the "Archived N" header at the foot opens and closes the drawer; the drawer caps at half the panel and scrolls on its own.
- `remembered`: open or closed survives a relaunch.
- `archive` / `unarchive`: the right-click menu's Archive on an Inbox row, and Unarchive on a drawer row, with the stand-in's `pinned` flag read back. Unarchive on a chat Hermes archived also clears its `archived` flag.
- `keys`: Up and Down walk from the last row in the scroll into the open drawer's rows, and back.
- `drag`: a row dragged onto the drawer archives it, and a row archived in this app dragged onto the Inbox unarchives it (issue #299), with the target tinted only while the drop would change something. A chat Hermes archived dragged onto the Inbox stays put.
- `archive-all`: the Inbox header's Archive all, by keyboard, with its question, the toast, Undo, and writes that fail.
- `opened-elsewhere`: opening an Archived chat from search opens a closed drawer.
- `archived-in-hermes`: a chat Hermes has archived shows in the same drawer; switching Archived off in Settings → Chats → Chat list sections hides the drawer and stops listing those chats, and switching it on brings both back.
- `working-last`: a chat with a reply running is the scroll's last row, right above the drawer, with Archived shown or hidden.
- `resize`: dragging the list's right edge, or the arrow keys on it, makes the list narrower or wider, never hidden; the width is kept across a relaunch.
- `zoom`: Ctrl+= and Ctrl+Shift+= zoom the whole app in, Ctrl+- out, and Ctrl+0 back; the zoom is kept across a relaunch.

## How to get to it (user POV)

- The list panel, beside the rail.
- Settings (Ctrl+,) → Chats → Chat list sections, for the switches.

## Driving it with wd.mjs

Preconditions:

- `HV_LIST=24 $S/hv up`, so `default` has 24 Active chats (`list1` … `list24`) and its Inbox is longer than the panel. Then sign in per [sign-in.md](sign-in.md).

- **Header at the foot.** `$S/wd.mjs wait .archived-drawer`. `$S/wd.mjs count '.sb-scroll .archived-drawer'` prints `0`, and `.sb-foot` has one child. The header `[data-section-head=archived]` reads `Archived4` with `aria-expanded="false"`, and its bottom is the panel's bottom (`eval` the two `getBoundingClientRect()`s). Run `$S/wd.mjs shot 01-drawer-closed`.
- **Archive from the menu.** For each of `list1`, `list3`, `list4`, `list6`, `list7`, `list8`, run `$S/wd.mjs rightclick '.row-open[data-chat=<id>]'`, then `$S/wd.mjs click '[role=menuitem]' Archive`. The header reads `Archived10`. `$S/hv state` shows each with `"pinned": false` and `"archived": false`.
- **Open.** `$S/wd.mjs click '[data-section-head=archived]'`, then `$S/wd.mjs wait .archived-list`, then `$S/wd.mjs shot 02-drawer-open`. The drawer's height is half the panel's at most, and `.archived-list` has `scrollHeight > clientHeight`.
- **Own scroll.** `$S/hv x mousemove 190 700`, then `$S/hv x click 5` a few times. `.archived-list` `scrollTop` grows and `.sb-scroll` `scrollTop` stays `0`.
- **Unarchive.** `$S/wd.mjs rightclick '.archived-list .row-open' "Swap usage spikes"`, then `$S/wd.mjs click '[role=menuitem]' Unarchive`. The row is back in `.sb-scroll`, and `$S/hv state` shows `list7` with `"pinned": true`.
- **Drag.** WebDriver can't start an HTML5 drag in WebKitGTK, so drag with real X input through `$S/hv x`. Get the window's client origin from `$S/hv x getactivewindow getwindowgeometry` (its `Position`), and each target's centre from `eval` of `getBoundingClientRect()`; screen point = origin + centre. Then `mousemove` to the row, `mousedown 1`, about ten `mousemove`s 80 ms apart to the target, and read the tint before `mouseup 1`: `.sb-scroll` has `data-drop="inbox"` over the Inbox, and `.archived-drawer` has the class `drop` over the drawer. `hv shot` shows the drag image and the tint. Open the drawer and drag an Archived row onto `[data-section-head=inbox]`: the row moves to the Inbox and `$S/hv state` shows it `"pinned": true`. Close the drawer and drag that row onto `[data-section-head=archived]`: the header reads one more and keeps `aria-expanded="false"`. An Inbox row over the Inbox shows no tint, a row onto `.tab-strip` still opens a tab, and `hv x key Escape` before `mouseup` cancels with no tint left.
- **Archive all.** Give one Inbox chat an Approval: `$S/wd.mjs click '.row-open[data-chat=list2]'`, click `textarea[data-composer]`, `$S/wd.mjs keys 'Run the approval check\n'`, then `$S/wd.mjs wait .approval`. Click `[data-section-head=inbox]` twice so it keeps focus, then `$S/wd.mjs press Tab` (focus is on Archive all) and `$S/wd.mjs press Enter`. `[role=alertdialog]` reads `Archive N chats from the Inbox?` and `1 of them has an Approval waiting.` Click `[role=alertdialog] button "Archive all"`. `.toast` reads `Archived N chats`, the Inbox is empty, the drawer stays closed, and `$S/hv state` shows each with `"pinned": false`. Click `.toast button Undo` at once, because the toast goes after a few seconds. The chats are back in the Inbox and `pinned` is `true` again. For writes that fail, start with `HV_FAIL_PATCH=list5,list9` as well. The toast then reads `Archived N chats. 2 chats couldn't be archived and are still in the Inbox.` and those two stay in the Inbox with `"pinned": true`.
- **Keys.** Find the last scroll row (`eval` the last `.sb-scroll .row-open`'s `data-chat`). Click it twice: the first click opens the chat and focuses the composer, the second leaves focus on the row. `$S/wd.mjs press ArrowDown` moves focus into `.archived-drawer`; `ArrowUp` moves it back.
- **Opened elsewhere.** Close the drawer, then `$S/wd.mjs press Control+k`, `$S/wd.mjs keys "Why is the VPN"`, `$S/wd.mjs click .hit-row "Why is the VPN slow"`. The header has `aria-expanded="true"` and `.archived-list .row-open[data-chat=vpn]` counts `1`.
- **Remembered.** Close the drawer, then `$S/wd.mjs close`, `$S/wd.mjs open` and sign in again. The header still has `aria-expanded="false"`.
- **Archived in Hermes.** Archive a chat as another Hermes client would: `curl -s -XPOST "$DASHBOARD_URL/__archive?id=list9"`. Its row moves to `.archived-list`, and neither its hover buttons nor its menu offer to hide it in every Hermes client. Unarchive it from its menu: `$S/hv state` shows it `"archived": false` and `"pinned": true`, and its row is back in the Inbox. Settings → Chats, then `$S/wd.mjs click '[role=switch][aria-labelledby=chat-section-archived]'` hides the drawer; clicking it again brings it back with its rows.
- **Resize.** Read the edge with `$S/wd.mjs eval` of `.list-resize`'s `getBoundingClientRect()`, then `$S/wd.mjs drag .list-resize -- 3 300 <dx> 300`. `.sidebar`'s width follows, stops at 200 and 560, and `.sidebar` stays. Focus `.list-resize` with a click and press `ArrowRight`: 32 more. Relaunch: the width is kept.
- **Zoom.** `$S/wd.mjs press Control+=` and `$S/hv x key ctrl+plus` each make `window.innerWidth` smaller (1280 at 100%, 1163 at 110%); `Control+-` and `Control+0` take it back. A relaunch opens at the zoom kept.
- **Working last.** Start `hv up` with `HV_LONG_REPLY=400`. Press `Control+n`, then type a prompt that starts with `long` into `textarea[data-composer]` and press Enter. Run `$S/wd.mjs wait '.row[data-section=working]'`. `.sb-scroll`'s `lastElementChild` has `data-section="working"`, and its `nextElementSibling` is `.sb-foot`, whose only child is `.archived-drawer`. With Archived hidden, Working is still the scroll's last section and there is no `.sb-foot`.

## Gotchas

- The row's hover buttons (Archive, Unarchive) show only under the pointer; drive Archive and Unarchive through `rightclick` and the menu.
- `rightclick` can print "the press landed on something else" and still open the menu. Check for the menu item before retrying.
- `wait <css> <ms>` reads the number as text. Give a text, or none, before the timeout.
- `click '[role=menuitem]' Archive` also matches Unarchive by text; on a drawer row, name Unarchive.
- To prove an upgrade (state left by an older build), keep one `hv up` run: `wd.mjs close`, `hv build` from the newer source, then `wd.mjs open`. `hv doctor` then reports the build as stale against the stamp `hv up` recorded; that is expected.
