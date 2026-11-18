# One Archived drawer and one Archive button

Shots of the native app (`.claude/skills/verify-hermes-chat`), driven with real pointer input against the stand-in dashboard, with made-up chats. ADR 0202.

| File | Shows |
| --- | --- |
| `before-settled-and-archived.png` | `main` (`c48c493`): a hovered row has Settle and "Archive: hide in every Hermes client" buttons, and the list's foot has a Settled drawer and an Archived drawer. |
| `after-one-archived.png` | This branch: a hovered row has one Archive button, and one Archived drawer holds the chats archived here and the chat archived in another Hermes client (Rotate the API keys). |

To make them, run `HV_LIST=6 hv up` and sign in per `features/sign-in.md`. Archive `list6` (Cron job drift) from its row's hover button; on `main` that is the eye button, on this branch the Archive button. On this branch, also archive `list5` as another client would, with `curl -s -XPOST "$DASHBOARD_URL/__archive?id=list5"`. Open the drawers and hover Renew the TLS certificate.
