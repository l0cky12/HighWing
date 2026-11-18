# Restart gateway shows beside a change the running gateway picks up only on restart

> **Accepted.** It changes ADR 0073: the app now restarts a profile's gateway, but only when the owner presses Restart gateway beside a change the running gateway hasn't picked up, and the relay passes `POST api/gateway/restart`. The restart and its read-back are `GatewayRestartApi` in `src/hermes/gatewayRestart.ts`, and the button is `RestartGateway` in `src/ui/RestartGateway.tsx`, mounted by `src/ui/GatewaySettings.tsx` and `src/ui/McpSettings.tsx`. The relay rule is `transport::gateway_write`. Tested in `src/hermes/gatewayRestart.test.ts`, `src/ui/gatewaySettings.test.tsx`, `src/ui/mcpSettings.test.tsx` and `src-tauri/tests/transport.rs`.

Settings save as soon as the owner saves them. Most reach Hermes's messaging gateway without a restart: it reads the config again on each turn, so the model, toolsets, the persona and the memory provider apply on the next turn or the next chat. A few it reads only when it starts. After such a change the owner had to restart the gateway on the server, from a terminal. They asked for a Restart gateway button beside the setting, shown only after a change that needs it. Settings that need no restart stay exactly as they were.

What needs a restart was read from Hermes's source at `da9c2bd` (research note `~/.cache/hermes-src-gwrestart-report.md`). Of what this app edits, two things do:

- **A Telegram or Discord change.** The gateway builds its platform adapters from the config it started with. Hermes says when a save didn't reach the running gateway: `PUT /api/messaging/platforms/{id}` answers `hot_served: false` while the gateway runs (`hermes_cli/web_routers/messaging.py`), and the platforms list reads `state: "pending_restart"` for a platform that is on and set up but that the running gateway hasn't reported on.
- **An MCP server edited under the same name.** The gateway reconciles MCP servers about every 60 seconds by name only (`tools/mcp_tool_discovery.py`). An added, removed, renamed, turned-on or turned-off server is picked up by itself. A server whose command, URL or headers changed keeps its old connection until the gateway restarts.

Hermes restarts a gateway with `POST /api/gateway/restart?profile=`, no body. It runs `hermes gateway restart --interrupt` in the background and answers `{ok, pid, name}` (`hermes_cli/web_routers/actions.py`). `GET /api/actions/gateway-restart/status` follows it with `{running, exit_code, pid, lines}`, one record shared by every profile. `GET /api/status?profile=` reports `gateway_running`, `gateway_state`, `active_agents` and, for a profile the shared multiplexer serves, `gateway_shared_with`.

## Decisions

- **The button shows in two places, and only after a change that needs it.**
  - Settings → Gateways shows it under the platform's Status when a save answered `hot_served: false` with the gateway running (`SaveResult.restart`), or while the platform reads Restart needed (`pending_restart`). The save's note and Restart needed's line say to use it, where they used to say to restart the gateway on the server.
  - Settings → MCP servers shows it beside a server after a saved edit that kept its name and changed how it connects (its command, arguments, variables, URL, sign-in, or a typed secret; `connectionChanged`), with the server on and the profile's gateway running (read from `/api/status`). Its line says chats on Telegram and Discord keep the server's old settings until the gateway restarts. A switch-off, a removal or a rename, once saved, takes the button away, since the gateway drops the old connection by itself. One Hermes refused leaves the button, and so does Test.
  - Nothing else in Settings shows it. Models, text generation, the persona, toolsets, skills and the theme need no restart. The memory provider's `restart_required` means the whole Hermes install restarts, not the gateway, so it stays as it was.
- **The app restarts the gateway only when the owner presses the button.** No save restarts it on its own, since a restart drops every platform's connection and cuts running replies (`--interrupt`).
- **It asks first when replies are running.** Pressing the button reads `/api/status`. When `active_agents` is more than 0, or the status can't be read, it asks "N replies running on this profile will be cut off" with Restart anyway and Cancel. Cancel sends nothing. When the gateway is the shared multiplexer, the question and the confirmation also name the other profiles whose bots reconnect.
- **A restart counts only once Hermes reads it back.** The app follows the action record while its `pid` is the restart's, and then reads `/api/status?profile=` until `gateway_running` is true and `gateway_state` is `running`. Exit 0 alone isn't enough: with a systemd unit whose restart failed and linger off, the command exits 0 without restarting. Each other ending says why:
  - A nonzero exit is a failure, with the command's last lines, redacted.
  - A refusal (500: the system service needs passwordless sudo, or another profile's restart is running) is a failure, with Hermes's reason.
  - A Hermes without the route (404) is a failure that says updating Hermes adds it.
  - A command still running after 90 seconds, a record taken over by another restart, or a gateway that doesn't read back as running within 30 seconds is "Hermes didn't confirm the restart", with the reason. The button stays, to try again. The limits are elapsed time, and a request Hermes doesn't answer in what's left of one counts as a failed read.
- **A second restart waits out Hermes's cooldown.** Hermes answers a restart asked for a profile within 10 seconds of that profile's last one with the last one's pid, though it has ended (`GATEWAY_RESTART_COOLDOWN_SECONDS`, `hermes_cli/web_server.py`), and that record already says exit 0. So the app remembers each profile's last restart, waits out the rest of the 10 seconds before asking again, and asks once more if Hermes still answers with the old pid. A second such answer is "Hermes didn't confirm the restart".
- **A restart that read back hides the button and says "Gateway restarted."** Settings → Gateways reads the platforms again, so Restart needed clears.
- **The changes waiting for a restart are kept per profile for the connection, in `GatewayRestartApi`, not in a screen.** Hermes can't say that an MCP server was edited in place, or that a token was replaced on a platform that stays connected, so a mark kept only on screen would be lost on switching tabs or profiles. A restart applies every change saved before it was asked for, so a confirmed one clears those marks of the profile, in both screens; a change saved while it ran, even one saved again under the same name, keeps its mark. An MCP edit whose status read fails leaves an earlier mark for that server as it was.
- **The relay passes the one route.** `transport::gateway_write` lets `POST api/gateway/restart` through with no body, the profile in the query. The gateway's other lifecycle routes (`start`, `stop`) and a restart with a body stay refused. Its status and action reads are `GET`s, which the relay passes already.

## Considered options

- **A list of every config key the gateway reads only at start**, such as `display.busy_input_mode`, `provider_routing` and `human_delay.*`. Rejected for now: the app edits none of them, and Hermes signals the two cases it does edit.
- **Restart the gateway after a save, without asking.** Rejected: a restart cuts running replies and reconnects every platform, so it should be the owner's choice, made when it suits them.
- **Show the button for the default model.** Rejected: the gateway reads the model on each turn, so a restart changes nothing, and a chat that ran `/model` keeps its own model after a restart too.
- **Offer `/reload-mcp` instead of a restart for an MCP edit.** Rejected: it is a chat command, run per chat on the platform, not something this app can send.

## Consequences

- An owner who changes a Telegram or Discord token, or edits an MCP server, can apply it from the app instead of a terminal on the server.
- A restart cuts running replies in every chat the gateway serves, and on a multiplexed gateway every profile's bots reconnect. The question says so when Hermes reports replies running.
- The verify stand-in's `default` profile has a running gateway, so a Telegram save or an MCP edit shows the button there. `HV_ACTIVE_AGENTS=<n>` makes it report n replies running, and `/__state` lists `gatewayRestarts` per profile.
