#!/bin/bash
# Opens the app under the verify skill and signs in to the real dashboard `hv up --dashboard` named, then shows the
# Bots tab. The password is read from $HERMES_PASSWORD_FILE and typed, never printed.
#   HERMES_USER=<name> HERMES_PASSWORD_FILE=<file> bench/bot-create/signin.sh
set -euo pipefail
S=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
W=$S/wd.mjs
. "$HV_RUN/state.env"
$W open >/dev/null
$W wait button "Get started" 30000 >/dev/null
$W click button "Get started" >/dev/null
$W select select "Connect through" -- "Web address" >/dev/null
$W fill input "Dashboard URL" -- "$DASHBOARD_URL" >/dev/null
$W click button "Test the route" >/dev/null
$W wait '[role=status]' "Reached Hermes" 20000 >/dev/null
$W click button Next >/dev/null
$W fill input "Dashboard username" -- "${HERMES_USER:?}" >/dev/null
$W fill input "Dashboard password" -- "$(cat "${HERMES_PASSWORD_FILE:?}")" >/dev/null
$W click button "Test connection" >/dev/null
$W wait '[role=status]' "At least one route works" 30000 >/dev/null
$W click button "Save and connect" >/dev/null
$W wait '[role=dialog]' "Model providers" 30000 >/dev/null
# Skip is lost if clicked before the providers have loaded (features/sign-in.md).
sleep 4
$W click button Skip >/dev/null
$W gone '[role=dialog]' "" 20000 >/dev/null
$W click '[role=tab][data-mode=bots]' >/dev/null
$W wait '.bots-row[data-profile="default"]' "" 30000 >/dev/null
echo "signed in to $DASHBOARD_URL"
