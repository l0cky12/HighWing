# Connections

Settings → General → Connection lists the saved connections. Each one has Rename, Test, Edit and Remove, and the section has Add connection, Sign out and Connection diagnostics. Test checks a connection without leaving the one in use. Sign out returns to the Sign in screen and keeps the connection.

## Sub-features

- `settings-open`: the rail's Settings button or Ctrl+, opens Settings on the General tab.
- `conn-test`: **Test** reports whether the connection works, with the Hermes version.
- `sign-out`: **Sign out** ends the session and shows Sign in.
- `switch-menu`: the rail's connection button opens **Switch connection**: Recent connections, **Add connection** and **Manage**, which opens Settings on Connection.
- `conn-remove`: **Remove** asks first, in `[role=alertdialog]` "Remove <name>?", with **Cancel**.
- `conn-add`: **Add connection** opens Setup over Settings; **Cancel setup** goes back.
- `conn-rename`, `conn-edit`: the other row actions.

## How to get to it (user POV)

- Rail: the gear button at the bottom, `aria-label` "Settings".
- Keyboard: Ctrl+, (comma).
- Rail: the connection button, `aria-label` "Connection: <name> (<url>). Switch connection", and its **Manage**.
- In Settings: the **General** tab, then the **Connection** sub-nav.

## Driving it with wd.mjs

Preconditions:

- Signed in to the stand-in (see [sign-in.md](sign-in.md)). The connection is named `127.0.0.1:<port>`.

- **Open Settings.** Run `$S/wd.mjs click button Settings`, then `$S/wd.mjs wait 'input[aria-label="Search settings"]'`. The tabs General through Diagnostics and **Back to chat** show.
- **Switch connection.** Run `$S/wd.mjs click button "Switch connection"`, then `$S/wd.mjs wait '[role=dialog][aria-label="Switch connection"]'`. It lists the connection "In use", with **Add connection** and **Manage**. Run `$S/wd.mjs click '[role=dialog] button' Manage`: Settings opens.
- **Test.** Run `$S/wd.mjs click button "Test 127.0.0.1"`, then `$S/wd.mjs wait .conn-test.ok "The connection works"`, then `$S/wd.mjs shot 09-settings-test`. The text reads "The connection works: http://127.0.0.1:<port>, Hermes 0.17.0."
- **Remove asks.** Run `$S/wd.mjs click button "Remove 127.0.0.1"`, then `$S/wd.mjs wait '[role=alertdialog]' "Remove 127.0.0.1"`: it says the connection in use is signed out first. Run `$S/wd.mjs click '[role=alertdialog] button' Cancel`.
- **Add.** Run `$S/wd.mjs click button "Add connection"`, `$S/wd.mjs wait button "Cancel setup"`, then `$S/wd.mjs click button "Cancel setup"`: Settings shows again.
- **Back to chat.** Run `$S/wd.mjs click button "Back to chat"`, then `$S/wd.mjs gone 'input[aria-label="Search settings"]'`.
- **Keyboard entry.** Run `$S/wd.mjs press "Control+,"`, then `$S/wd.mjs wait 'input[aria-label="Search settings"]'`.
- **Sign out.** Run `$S/wd.mjs click button "Sign out"`, then `$S/wd.mjs wait button Connect`. No confirmation is asked. The Sign in screen shows the username `verify` kept, along with **Remove this connection…**.
- **Proof.** Take shots of the Test result and the Sign in screen after signing out. Signing in again (see [sign-in.md](sign-in.md) "Sign in again") proves the connection was kept.

## Gotchas

- Test's result is a `.conn-test` element with class `ok` or `bad`. Assert the class as well as the text.
- Remove, once confirmed, deletes the connection and everything kept for it. On a fresh run that means going back through Setup.
- Settings search filters the sections that are shown. Clear it before you look for a control by text.
- On the private bus, Sign out also shows the alert "Signed out, but couldn't delete the saved password from the system keyring". This is expected here and is not a bug.
- With an unsaved edit in Settings (memory, a skill, an artifact), Sign out asks first. This recipe has none.
