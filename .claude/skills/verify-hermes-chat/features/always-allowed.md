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
- An Approval card → **Always allow**: the confirm says where the list is.

## Driving it with wd.mjs

Preconditions:

- A real Hermes, since the stand-in neither saves an Always allow to a config file nor asks again: `$S/real-hermes up "$HOME/.cache/hermes-verify/rh-allowlist"`, then `$S/hv up --dashboard "$(cat "$RH_DIR/url")"`, `$S/wd.mjs open`, and sign in per [sign-in.md](sign-in.md) with that URL, user `verify` and password `verify-pass`. Skip Model providers.
- The model stub answers `danger <tag>` with `rm -rf work/junk-<tag>`, which Hermes flags as "recursive delete" ([approval-mode.md](approval-mode.md)).

- **Grant.** `$S/wd.mjs press Control+n`, `$S/wd.mjs click 'textarea[data-composer]'`, `$S/wd.mjs keys 'danger a1\n'`, `$S/wd.mjs wait button "Always allow" 60000`, then `$S/wd.mjs click button "Always allow"`. `$S/wd.mjs text .approval-confirm` ends "Settings → Approvals lists what is always allowed, and can take it back." Click `button "Yes, always allow"`. `grep -A2 command_allowlist "$RH_DIR/home/.hermes/config.yaml"` shows `- recursive delete`. Send `danger a2`: no card comes, and `$RH_DIR/work/junk-a2` is gone.
- **List.** `$S/wd.mjs press Control+,`, `$S/wd.mjs click '[role=tab]' Approvals`, `$S/wd.mjs wait '[role=list]' "recursive delete" 20000`.
- **Changed meanwhile.** Add a line under the list by hand: `sed -i 's/^  - recursive delete$/  - recursive delete\n  - git force push/' "$RH_DIR/home/.hermes/config.yaml"`. Click `button "Remove recursive delete"`. `$S/wd.mjs wait '[role=alert]' "Nothing was removed"`. The page now lists both, and config.yaml still has both.
- **Remove.** Click `button "Remove recursive delete"` again. `$S/wd.mjs wait '[role=status]' "Removed “recursive delete”"`. The page lists only `git force push`, and so does config.yaml.
- **Asks again.** `$S/wd.mjs click button "Back to chat"`, `$S/wd.mjs press Control+n`, send `danger a4`, and `$S/wd.mjs wait button "Always allow" 60000`: Hermes asks again. Deny it, and `$RH_DIR/work/junk-a4` stays.
- **Profile.** In Approvals, `$S/wd.mjs select select "Profile whose always-allowed commands are shown" -- ada`. The page reads ada's list (empty on a fresh `up`).

## Gotchas

- Hermes's Always allow also allows the command for the rest of the chat that answered it, in memory. Sending `danger a3` in that same chat after Remove runs without asking until Hermes closes the chat. Use a new chat to see Hermes ask again.
- The page compares lists as sets: Hermes saves the list sorted, so a reorder alone isn't a change.
- `hv build` again after any edit to `src/` before `hv up`, or `hv doctor` fails on the stale build.
