# Slack is a third gateway, with two write-only tokens and a short guide to its app

> **Accepted.** It changes ADR 0073: Settings → Gateways offers Slack beside Telegram and Discord, and the relay passes Slack's save and status check. The platform list is `PLATFORMS` in `src/hermes/gateways.ts`, the card is `src/ui/GatewaySettings.tsx`, and the relay rule is `transport::gateway_write`. Tested in `src/hermes/gateways.test.ts`, `src/ui/gatewaySettings.test.tsx` and `src-tauri/tests/transport.rs`, against FakeHermes's messaging routes (`src/hermes/fakeGateways.ts`).

The owner wants to reach a bot from Slack: DM it, or mention it in a channel, and have it answer there with the skills and memory it has in Highwing (#29, part of #25). A Hermes profile's gateway can already run a Slack connection, but Settings → Gateways offered only Telegram and Discord, so setting up Slack meant editing the profile's `.env` on the server.

ADR 0073 left the other platforms out because they need flows the screen doesn't have: WhatsApp's QR pairing, webhooks with public URLs, OAuth apps. Slack in Hermes uses Socket Mode, which needs none of them. The owner makes a Slack app by hand, and Hermes needs two tokens from it.

What Hermes does was read from its source at `ae2a81c` (the checkout at `~/.hermes/hermes-agent`), and Slack's catalog entry was printed from `_messaging_platform_catalog()` there:

- `GET /api/messaging/platforms` lists Slack with three settings, from `plugins/platforms/slack/dashboard_card.py`: `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` (both required, both passwords, so both come back only as a redacted preview) and `SLACK_ALLOWED_USERS` (an allowlist, which comes back as its value). Its `docs_url` is `https://api.slack.com/apps`.
- `PUT /api/messaging/platforms/slack` checks each value before it writes anything (`env_value_rules`): the bot token must start `xoxb-`, the app token `xapp-`, and the allowlist must be comma-separated member IDs like `U01ABC2DEF3`, or `*`. Each refusal is a 400 with a sentence that says which token goes where.
- `POST /api/messaging/platforms/slack/test` is the same route as for Telegram and Discord. `test_messaging_platform` builds its answer from the platform's payload and nothing platform-specific, so it works for Slack and sends nothing.
- `SLACK_HOME_CHANNEL` is **not** among Slack's settings in the catalog. Hermes reads it from `.env` (`plugins/platforms/slack/gateway_env.py`) and `hermes gateway setup` writes it, but `PUT /api/messaging/platforms/slack` refuses it as "not configurable for Slack". Every platform's payload carries `home_channel` from config.yaml, which `/sethome` writes (`persist_home_channel`).
- Slack's adapter reports `missing_dependency` when slack-bolt isn't installed. A token Slack turns down (`auth.test` fails) makes `connect()` return false with no error code, so the gateway marks Slack `retrying` with "failed to connect".

## Decisions

- **Slack is a third entry in `PLATFORMS`, after Telegram and Discord, in Hermes's order.** Its card is the one ADR 0073 built: Status, Turned on, its settings in Hermes's order, Check status, Save. The fields come from Hermes's list, so the two tokens are write-only rows (Replace, Remove, Keep current) and the member IDs are an editable field. Nothing about saving, the read before and after it, redaction or Restart gateway (ADR 0205) changes for Slack.
- **The relay passes `SLACK_` names for Slack.** `transport::gateway_write` takes `PUT api/messaging/platforms/slack` with `enabled`, `env` and `clear_env` under `SLACK_…` names only, and `POST api/messaging/platforms/slack/test` with no body. A `SLACK_` name on Telegram's or Discord's route, or another platform's name on Slack's, isn't relayed. Other platforms are still refused.
- **Check status stays for Slack.** The issue asked to hide it if Hermes's test route didn't work for Slack. It does, by reading the same payload as for the other platforms.
- **The home channel is shown, not edited.** The issue asked for `SLACK_HOME_CHANNEL` as a field, but Hermes refuses it on this route, and a form that always fails would be worse than none. Every platform's card has a Home channel row: the channel ID and its name as config.yaml has them, or "Not set", with the hint to send `/sethome` in the chat or channel that should be home. Its (i) says that a home channel set only in the server's `.env` doesn't show here, since Hermes's list reads config.yaml for it. If a later Hermes adds the setting to Slack's card, it appears as an ordinary field, since the screen draws whatever settings Hermes lists.
- **A Slack app row, with a short guide.** Slack's card has a row the other two don't, above its settings: "Make a Slack app with Socket Mode on, then paste its two tokens below", with a **Hermes's Slack guide** button that opens Hermes's own guide (`https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack`, from `website/docs/user-guide/messaging/slack.md`), which lists the scopes and events. Its (i) has four steps: create the app at api.slack.com/apps (from scratch, or from the manifest `hermes slack manifest --agent-view --write` makes on the server); turn on Socket Mode and make an app-level token with `connections:write` (the `xapp-` token); add the scopes and events, install the app, and copy the `xoxb-` token; add your member ID and invite the bot to a channel. It is a row rather than the card's (i) because in Settings' page the card has no heading of its own, so the guide would hide behind Status's (i).
- **The manifest isn't copied into the app.** Approach 2 of #29 showed a ready-to-paste manifest. It lives in Hermes's CLI, which builds it from Hermes's command list, so a copy here would drift. The guide names the command that prints it.
- **A turned-down token reads as Hermes words it.** A token in the wrong field is refused by Hermes's shape rule, with its sentence, as "Token turned down", followed by where each Slack token comes from. A token of the right shape that Slack turns down shows as Retrying with Hermes's "failed to connect". The screen doesn't guess that this was the token, since Slack's adapter doesn't say so. A missing slack-bolt reads "Missing on the server", with Hermes's `slack` extra to install.
- **Redaction knows Slack's app token.** The secret shapes this screen and Logs take out (ADR 0033) already had Slack's `xox…-` tokens. They now have `xapp-` too.

## Considered options

- **Approach 2, the manifest in the app.** Rejected above: it would drift from Hermes's.
- **Approach 3, a form for every platform Hermes lists.** Rejected, as in ADR 0073: it would offer platforms whose setup needs QR pairing, webhooks or OAuth, as forms that can't finish it.
- **Write `SLACK_HOME_CHANNEL` through another Hermes route**, such as the Keys page's env write. Rejected: it widens what the relay passes beyond the messaging routes for one value that `/sethome` already sets from Slack.
- **Hide Check status for Slack.** Not needed: the route works for it.

## Consequences

- The owner sets up Slack for any profile, a bot included, from the app. They still create the Slack app by hand, in Slack.
- The home channel can't be set from the app. The card says how to set it from Slack.
- A Slack token of the right shape that Slack turns down reads "failed to connect" rather than "Token turned down".
- A Hermes older than Slack's dashboard card (no `slack` in the list, or Slack without its settings) shows no Slack in the tree, or a card with only what Hermes lists.
- Verification: the Rust relay tests, and the API and screen tests against FakeHermes, whose Slack entry and value rules are copied from `ae2a81c`. The real app was driven against the verify stand-in for the screenshots. A DM to a bot in a real Slack workspace was not tried: it needs a Slack workspace where an app can be installed, and real tokens.
