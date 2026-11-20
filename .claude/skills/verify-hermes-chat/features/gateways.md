# Gateways

Settings → Gateways sets up one profile's Telegram and Discord gateways on the server, picked in the tab's profile list, one platform at a time from Settings' side list. Each platform shows its state as Hermes reports it, a Turned on switch, its bot token as Hermes's redacted preview (Replace opens an empty masked field, Remove clears it on Save, a row left alone keeps it), its allowed user IDs, Check status (sends no message), and Save. Save reads the platform first and sends nothing if it changed on the server, then says "Saved, and Hermes reads it back that way" only once a read shows all of it. When the running gateway hasn't picked a save up, Restart gateway shows under Status; it asks first when replies are running and says "Gateway restarted." once Hermes reads the gateway back as running.

## Sub-features

- `gw-list`: Settings' side list has Telegram and Discord under Gateways; each shows Status, Turned on, its settings and the token's preview, never the token.
- `gw-replace`: Replace, paste, Save; the preview changes and the field is gone.
- `gw-remove`: Remove, Save; the token row offers Add again.
- `gw-switch`: the switch changes only on Save, and a new token alone never turns a platform on.
- `gw-invalid-token`: a token Hermes or the platform turns down reads "Token turned down".
- `gw-missing-dependency`: a gateway without python-telegram-bot or discord.py reads "Missing on the server".
- `gw-conflict`: a change made on the server after the screen read it stops the save with "changed on the server".
- `gw-check`: Check status shows Hermes's answer.
- `gw-profile`: the profile list shows another profile's gateways.
- `gw-restart`: after a save the running gateway hasn't picked up, Restart gateway under Status restarts it; with replies running it asks first.

## How to get to it (user POV)

- Rail → Settings (gear) → **Gateways** tab.
- Settings search for "Telegram" or "Discord" → **Open Gateways**.

## Driving it with wd.mjs

Preconditions:

- Signed in ([sign-in.md](sign-in.md)). The stand-in's FakeHermes has the messaging routes with nothing set, and `default`'s gateway running, so Status reads Off for both platforms and a Telegram save with the switch on needs a restart. For the gateway's own states (missing dependency, a running gateway), use a real `f0d94882` dashboard: `hv up --dashboard <url>`, and start its gateway with `hermes gateway run` under the same `env -i` and `HERMES_HOME`. The box's Hermes venv has neither python-telegram-bot nor discord.py; see Gotchas for what the gateway does about that.

- **Open.** `$S/wd.mjs click button Settings`, `$S/wd.mjs click '[role=tab]' Gateways`, `$S/wd.mjs wait h2 Telegram`.
- **Turned-down token.** `$S/wd.mjs click button "Add Telegram bot token"`, `$S/wd.mjs fill input "Telegram bot token" -- not-a-token`, `$S/wd.mjs click button Save`, `$S/wd.mjs wait '[role=alert]' "Token turned down"`.
- **Replace.** `$S/wd.mjs fill input "Telegram bot token" -- 123456789:AAAAdummydummydummydummydummydummy00`, `$S/wd.mjs click '[role=switch]' ` (Turned on), `$S/wd.mjs click button Save`, `$S/wd.mjs wait '[role=status]' "Hermes reads it back"`. The token row shows `«redacted:1234...my00»`; the dashboard's `GET /api/messaging/platforms` shows `is_set: true`, `enabled: true`.
- **Missing dependency.** Start the gateway, then `$S/wd.mjs click button Reload` and `$S/wd.mjs wait .gw-problem "Missing on the server"`.
- **Check status.** `$S/wd.mjs click button "Check status"`, `$S/wd.mjs wait .gw-line "python-telegram-bot not installed"`.
- **Conflict.** Change the token through the dashboard's API, then flip the switch, `$S/wd.mjs click button Save`, `$S/wd.mjs wait .gw-line "changed on the server"`.
- **Remove.** `$S/wd.mjs click button "Remove Telegram bot token"`, `$S/wd.mjs click button Save`, `$S/wd.mjs wait button "Add Telegram bot token"`. Don't wait for `.set-hint "Not set."`: the Webhook secret row reads that before any removal.
- **Discord.** `$S/wd.mjs click .settings-sub Discord`, `$S/wd.mjs wait h2 Discord`.
- **Restart gateway.** On `default`'s Telegram, do Replace (above) with the switch on. The save's line ends "Restart gateway, under Status, applies them", and Status reads Restart needed. `$S/wd.mjs click button "Restart gateway"`, `$S/wd.mjs wait .gw-line "Gateway restarted."`; Status reads Connected and the button is gone. `$S/hv state` shows `gatewayRestarts: {"default": 1}`. With `HV_ACTIVE_AGENTS=2` set for `hv up`, the click first shows `[role=alertdialog]` "2 replies running on this profile will be cut off."; `$S/wd.mjs click '[role=alertdialog] button' Cancel` leaves `gatewayRestarts` empty, and `$S/wd.mjs click '[role=alertdialog] button' "Restart anyway"` restarts it.

## Gotchas

- A live connection to Telegram or Discord needs a real bot token and account; dummy tokens only reach the "turned down" and "missing" states.
- On the stand-in, the restart connects every platform that is on and set up, without reaching Telegram. Against a real dashboard, Restart gateway runs `hermes gateway restart --interrupt` for real: it cuts running replies, and a system service without passwordless sudo refuses it.
- Hermes turns a platform on by itself when a token is saved without `enabled`; the app always sends the switch, so check `enabled` on the server after a token-only save.
- Hermes lazily installs python-telegram-bot or discord.py when its gateway starts a platform without it, and then logs in to Telegram or Discord with the token (a dummy one is turned down; no message is sent). To see a missing library instead, start the gateway with `HERMES_DISABLE_LAZY_INSTALLS=1`; Discord then reports `adapter_unavailable`, which the screen shows as "Missing on the server".
