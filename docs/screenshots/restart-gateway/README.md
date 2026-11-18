# Restart gateway beside a change that needs it

Shots of the native app (`.claude/skills/verify-hermes-chat`), driven with real input against the stand-in dashboard. ADR 0205.

| File | Shows |
| --- | --- |
| `before-gateways-saved.png` | `main` (`3f9835f`): after saving a Telegram token while the gateway runs, the page says to restart the gateway "on the server". There is no button. |
| `after-gateways-open.png` | This branch: Telegram before any change. No button. |
| `after-gateways-button.png` | This branch: after the same save, **Restart gateway** sits under Status. |
| `after-gateways-ask.png` | This branch: with 2 replies running, the button asks before it cuts them off. |
| `after-gateways-restarted.png` | This branch: after Restart anyway, "Gateway restarted." and Status reads Connected. The button is gone. |
| `before-mcp-saved.png` | `main`: after editing `github`'s bearer token, only "Saved". Telegram and Discord chats keep the old token until the gateway restarts, and nothing says so. |
| `after-mcp-open.png` | This branch: MCP servers before any change. No button. |
| `after-mcp-button.png` | This branch: after the same edit, **Restart gateway** sits in `github`'s row with the reason. |
| `after-mcp-button-after-tab-switch.png` | This branch: the button is still there after switching to Gateways and back. |
| `after-mcp-restarted.png` | This branch: after the restart, "Gateway restarted." The button is gone. |
| `after-mcp-switch-no-button.png` | This branch: turning `weather` on needs no restart, so no button shows. |
| `restart-gateway-demo.mp4` | This branch: both spots, end to end, in under a minute. |

To make them, run `HV_ACTIVE_AGENTS=2 hv up`, sign in per `features/sign-in.md`, then follow the Restart gateway recipes in `features/gateways.md` and `features/mcp-servers.md`. For the `main` shots, `default`'s gateway must be running in the stand-in, which `main`'s bridge doesn't do; set `server.gateways.gateway.default = { running: true, platforms: {} }` in `bridge.ts` for that run.
