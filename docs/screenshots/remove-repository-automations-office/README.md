# Removing the Repository, Automations and Office screens

The native app after the three screens were removed (ADR 0204).

| File | Shows |
| --- | --- |
| `rail.png` | The rail just after sign-in. The Server group holds only Scheduled jobs and Usage, and no Office button is left. |
| `settings-chats.png` | Settings → Chats. Its description no longer mentions the Office, and no Office section is left. |

They were taken with the `verify-hermes-chat` skill: the native Tauri app under Xvfb, signed in through Setup to the skill's stand-in dashboard (`FakeHermes`, made-up data). The keyring toast in `rail.png` is expected there, since the private bus has no keyring.
