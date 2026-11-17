# Images placed where they were added

The first image stays above the words; each later one goes on the line where it was added (ADR 0197). Every image entered through a real Ctrl+V on the X clipboard: a red 320 × 200 PNG first, then two files both named `image.png`, a blue 160 × 90 and a green 240 × 160, pasted between "These two" and "show the error".

| File | Shows |
| --- | --- |
| `before-composer.png` | `main`: all three images wait above the words. |
| `before-sent.png` | `main`: the sent message shows all three images above its words. |
| `after-composer.png` | This branch: the red image waits above the words; each `image.png` is a chip with its thumbnail, name and size on the line it was pasted on. |
| `after-sent.png` | This branch: the sent message shows the red image above its words and the blue and green ones on their line. |
| `after-relaunch.png` | The same after closing and reopening the app, read back from what the dashboard stored. |
| `after-preview.png` | Clicking the second `image.png` opens the green 240 × 160 image, not the blue one, in the Preview. |

These are the native Tauri app (WebKitGTK) on Xvfb, driven through tauri-driver by the `verify-hermes-chat` skill, with empty app data, against its stand-in dashboard (`FakeHermes` behind HTTP and WebSocket). No live model was involved. `before-*` is `e87381b`; `after-*` is this branch.
