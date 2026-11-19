# Approval mode

A pill in a started chat's composer, after the reasoning pill, shows the chat's approval mode as Hermes reports it: "Smart", "Manual", "YOLO · this chat", "YOLO · all chats", or "Approvals" (disabled) until Hermes reports. Its menu offers Smart and Manual, which change the profile's mode for every chat on it, and YOLO, which changes this chat only after a warning shown every time. A pick waits for Hermes's answer; a refusal shows Hermes's message in the menu. The New chat pane has no pill. In a composer narrower than 600px only the icon and chevron show.

## Sub-features

- `unknown`: "Approvals", disabled with the reason, until the chat's first `session.info` with approvals.
- `profile-mode`: Smart or Manual sets the profile's `approvals.mode`; other open chats on the profile follow.
- `yolo`: the warning (Cancel sends nothing), then YOLO for this chat only.
- `yolo-off`: Smart or Manual in a YOLO chat turns its YOLO off, then sets the mode.
- `all-chats`: the profile's mode `off` shows "YOLO · all chats"; YOLO there does nothing; Smart puts it back.
- `refused`: Hermes's refusal shows in the menu and the face stays.
- `narrow`: at an 820px window the model name stays whole and the pill is icon-only.

## How to get to it (user POV)

- Open any chat; the pill is in the composer bar, after the model picker and the reasoning pill.

## Driving it with wd.mjs

Preconditions:

- The stand-in reports no approvals, so there the pill only ever reads "Approvals", disabled. Drive this feature against a real Hermes from `$S/real-hermes up "$HOME/.cache/hermes-verify/rh-approval"` (SKILL.md, "A real dashboard"; set `RH_VENV` when the SKILL's venv isn't on the box). Run the `export RH_DIR=…` it prints, then `$S/hv up --dashboard "$(cat "$RH_DIR/url")"`, `$S/wd.mjs open`, and sign in per [sign-in.md](sign-in.md) with that URL, user `verify` and password `verify-pass`. Real Hermes lists no ready provider on Model providers; Skip it.
- Its model stub answers `danger <tag>` by making the folder `$RH_DIR/work/junk-<tag>` and calling the terminal tool with `rm -rf work/junk-<tag>` there, which Hermes flags as a recursive delete. It answers Smart mode's judge with ESCALATE, so Smart asks too. `$RH_DIR/model-requests.jsonl` logs each request's `kind` (`turn`, `title` or `judge`).
- A fresh `up` has no `approvals:` block in `$RH_DIR/home/.hermes/config.yaml`, so the mode is Hermes's default, `smart`. The first Smart or Manual pick writes the block.

- **Unknown, then Smart.** Run `$S/wd.mjs press Control+n`, `$S/wd.mjs click 'textarea[data-composer]'` and `$S/wd.mjs keys 'hello\n'`. Until Hermes has built the chat's agent, `$S/wd.mjs text button "Approval mode: unknown"` reads `Approvals` and the button is disabled. Then `$S/wd.mjs wait button "Approval mode: Smart" 20000`. Send `danger s1`: `model-requests.jsonl` gets a `judge` line, the stub's ESCALATE brings up the Approval card, and Approve once deletes `$RH_DIR/work/junk-s1`.
- **Manual.** Run `$S/wd.mjs click button "Approval mode: Smart"` and `$S/wd.mjs click '[role=menuitemradio]' Manual`. `$S/wd.mjs wait button "Approval mode: Manual"`, and the menu is gone. `grep -A1 '^approvals:' "$RH_DIR/home/.hermes/config.yaml"` shows `mode: manual`. Send `danger m1`: an Approval card shows `rm -rf work/junk-m1` and "recursive delete", with no `judge` line in `model-requests.jsonl`. Click its Deny: the card reads Denied and `$RH_DIR/work/junk-m1` stays.
- **YOLO, with the warning.** Click the pill, then `$S/wd.mjs click '[role=menuitemradio]' YOLO`. `$S/wd.mjs wait '[role=dialog]' "Turn on YOLO for this chat?"` shows both bullets. `$S/wd.mjs click button Cancel` closes it with nothing sent: the pill still reads Manual and the chat's `model_config` in `$RH_DIR/home/.hermes/state.db` (read-only) has no `yolo_mode: true`. Do it again and `$S/wd.mjs click button "Turn on YOLO"`. `$S/wd.mjs wait button "Approval mode: YOLO, this chat"`. `state.db` now has `yolo_mode: true`. Send `danger y1`: no card, and `$RH_DIR/work/junk-y1` is gone.
- **Back to Smart.** Click the pill and `$S/wd.mjs click '[role=menuitemradio]' Smart`. `$S/wd.mjs wait button "Approval mode: Smart"`, and it stays Smart (this is the stale `session.info` race, ADR 0091); `yolo_mode` is now false. Picking YOLO again shows the warning again.
- **All chats.** Run `sed -i '/^approvals:/,/^[^ ]/s/^  mode: .*/  mode: off/' "$RH_DIR/home/.hermes/config.yaml"`, then change the chat's reasoning effort from the reasoning pill so Hermes re-sends `session.info`. The pill reads "YOLO · all chats". Picking YOLO closes the menu with no warning, and `config.yaml` still has `mode: off`. Pick Smart: it reads "Smart", and `config.yaml` has `mode: smart`.
- **Narrow.** Resize the window to 820px wide with `$S/hv x` (`search --name Highwing windowsize 820 600`). `$S/wd.mjs shot narrow`: the model name is whole and the pill shows only its icon and chevron. Its aria-label still names the mode.

## Gotchas

- The create answer carries no approvals; the first `session.info` with them comes a second or two after the chat starts, so wait with a long timeout.
- `approvals.mode` is the profile's: it carries over between chats in one `real-hermes` run. A new `real-hermes up` starts at `smart` again.
- Under Smart, a flagged command first goes to the model as a one-word judge request. The stub always answers ESCALATE, so this page can't show Smart approving or denying a command by itself.
- The stub's `rm` names `workdir` `$RH_DIR`, so it touches only `$RH_DIR/work`, whatever the chat's own working folder is.
- A Hermes launched with `--yolo` reports YOLO in every chat. Right after a Smart or Manual pick the pill shows the mode, until Hermes's next `session.info` (ADR 0091).
- The refusal (4030) needs a Hermes with administrator-managed keys, which `f0d94882` doesn't have; `src/ui/approvalsPill.test.tsx` covers it.
- To compare the pill with what Hermes holds, read `approvals.mode` in `$RH_DIR/home/.hermes/config.yaml` and the chat's `model_config.yolo_mode` in `$RH_DIR/home/.hermes/state.db` (read-only): `session.info.yolo` is that flag or the mode `off`. Don't resume the chat from a second client to read its `session.info`: Hermes hands that client the app's own live session, and closing it there ends the app's session ("session not found" on the next pick).
