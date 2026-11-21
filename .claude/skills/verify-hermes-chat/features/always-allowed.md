# Always allowed

Settings → Approvals lists, for the profile picked, the kinds of command Hermes runs without asking because an Approval was answered Always allow, each with Remove. Remove checks that the list hasn't changed since it was shown, writes it without that entry, and reads it back. Hermes then asks again before a command like it in every chat but the one that gave the Always allow, which keeps its own grant until Hermes closes it. The Always allow confirm on an Approval card points to this page.

## Sub-features

- `confirm-pointer`: the Always allow confirm names Settings → Approvals.
- `list`: the page lists the profile's `command_allowlist` as Hermes holds it.
- `changed`: a list changed on the server since it was shown is not written, and the page shows the new one.
- `remove`: Remove writes the list without the entry, and the read back shows it.
- `asks-again`: after Remove, a new chat asks again before the same kind of command.
- `profile`: the page's profile picker shows another profile's list.

## How to get to it (user POV)

- Settings (Ctrl+,) → Agent → **Approvals**.
- An Approval card → **Always allow…**: the confirm says where the list is.

## Driving it with wd.mjs

Preconditions:

- The stand-in covers every sub-feature but `asks-again`: it saves an Always allow into the profile's `command_allowlist` and serves the list through `GET` and `PUT /api/config`, but asks on every prompt with `approval` in it without reading the list. Start `HV_BOTS=1 $S/hv up` (so the profile `ada` exists), `$S/wd.mjs open`, sign in per [sign-in.md](sign-in.md), and `. $HV_RUN/state.env`.
- `asks-again` needs a real Hermes: `$S/real-hermes up "$HOME/.cache/hermes-verify/rh-allowlist"`, run the `export RH_DIR=…` line it prints, then `$S/hv up --dashboard "$(cat "$RH_DIR/url")"`, `$S/wd.mjs open`, and sign in with that URL, user `verify` and password `verify-pass`. Its model stub answers `danger <tag>` with `rm -rf work/junk-<tag>`, which Hermes flags as "recursive delete" ([approval-mode.md](approval-mode.md)).
- An Approval card's buttons, and its confirm step's, ignore a click for 400 ms after they show or move. Run `sleep 0.5` before each click on the card.

- **Grant.** `$S/wd.mjs press Control+n`, `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs keys 'approval please\n'` (on a real Hermes, `danger a1`), `$S/wd.mjs wait '.approval button' "Always allow…" 20000`, `sleep 0.5`, then `$S/wd.mjs click '.approval button' "Always allow…"`. `$S/wd.mjs text .approval-confirm` ends "Settings → Approvals lists what is always allowed, and can take it back." `sleep 0.5` again (the confirm's buttons are new), then click `'.approval button' "Yes, always allow"`: the card reads "Always allowed". `curl -s "$DASHBOARD_URL/api/config?profile=default"` has `"command_allowlist": ["recursive delete"]` (on a real Hermes, `grep -A2 command_allowlist "$RH_DIR/home/.hermes/config.yaml"`).
- **List.** `$S/wd.mjs press Control+,`, `$S/wd.mjs click '[role=tab]' Approvals`, `$S/wd.mjs wait '[role=list]' "recursive delete" 20000`.
- **Changed meanwhile.** Change the list on the server: `curl -s -XPUT "$DASHBOARD_URL/api/config?profile=default" -H 'content-type: application/json' -d '{"config":{"command_allowlist":["git force push","recursive delete"]}}'` (on a real Hermes, `sed -i 's/^  - recursive delete$/  - recursive delete\n  - git force push/' "$RH_DIR/home/.hermes/config.yaml"`). Click `button "Remove recursive delete"`. `$S/wd.mjs wait '[role=alert]' "Nothing was removed"`. The page now lists both, and the server still has both.
- **Remove.** Click `button "Remove recursive delete"` again. `$S/wd.mjs wait '[role=status]' "Removed “recursive delete”"`. The page lists only `git force push`, and so does the server.
- **Asks again** (real Hermes). `$S/wd.mjs click button "Back to chat"`, `$S/wd.mjs press Control+n`, send `danger a4`, and `$S/wd.mjs wait button "Always allow" 60000`: Hermes asks again. Deny it, and `$RH_DIR/work/junk-a4` stays. Before Remove, `danger a2` asks nothing and `$RH_DIR/work/junk-a2` is gone.
- **Profile.** In Approvals, `$S/wd.mjs select select "Profile whose always-allowed commands are shown" -- ada`. The page reads "Nothing is in this profile's list."

## Gotchas

- Hermes's Always allow also allows the command for the rest of the chat that answered it, in memory. Sending `danger a3` in that same chat after Remove runs without asking until Hermes closes the chat. Use a new chat to see Hermes ask again.
- On the stand-in, the `approval please` reply never ends after the Approval is answered, so that chat stays in Working. Start each check that needs a quiet list in a new chat.
- The page compares lists as sets: Hermes saves the list sorted, so a reorder alone isn't a change.
- `hv build` again after any edit to `src/` before `hv up`, or `hv doctor` fails on the stale build.
