#!/bin/bash
# Times New bot in the real app against a real Hermes, as the owner sees it: from the Create bot click to the new
# bot open, connected, and its models loaded. Each run fills in only the name, clicks Create bot, clicks the new row
# when it appears, and then goes back to default and deletes the bot through the dashboard. Runs are 15 s apart,
# because every profile switch signs in again and Hermes refuses sign-ins that come too often.
# Needs a signed-in app (signin.sh) on the Bots tab, with default as the profile in use.
#   HERMES_USER=<name> HERMES_PASSWORD_FILE=<file> bench/bot-create/run.sh <label> <runs> <out.tsv>
# Each row: label, run, bot, then ms from the click to: row shown, form closed, row clicked, bot current, ready.
# With TRACE_DIR set, each run's timeline is saved there for phases.py; it has entries only in a build with
# docs/research/bot-create-speed/instrument.patch applied.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(git -C "$HERE" rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts/wd.mjs
. "$HV_RUN/state.env"
label=$1 runs=$2 out=$3
[[ $label =~ ^[a-z0-9]+$ ]] || { echo "label: lowercase letters and digits only, as a profile name takes" >&2; exit 2; }
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT
login=$(HERMES_USER=${HERMES_USER:?} python3 -c 'import json, os, sys; print(json.dumps({"provider": "basic", "username": os.environ["HERMES_USER"], "password": open(sys.argv[1]).read()}))' "${HERMES_PASSWORD_FILE:?}")
curl -sf -m 15 -c "$jar" -o /dev/null -H 'content-type: application/json' --data "$login" "$DASHBOARD_URL/auth/password-login"
remove() { curl -sf -m 60 -b "$jar" -X DELETE "$DASHBOARD_URL/api/profiles/$1" | grep -q '"ok":true'; }

for i in $(seq 1 "$runs"); do
  name="bpt-$label-$i-$(date +%H%M%S)"
  $W click button "New bot" >/dev/null
  $W wait '[role=dialog]' "Create bot" 20000 >/dev/null
  $W fill input "Name" -- "$name" >/dev/null
  $W eval "$(sed "s/__NAME__/$name/" "$HERE/probe.js")" >/dev/null
  $W click button "Create bot" >/dev/null
  $W wait ".bots-row[data-profile=\"$name\"] .bots-open" "" 120000 >/dev/null
  $W gone .profile-dialog "" 120000 >/dev/null
  $W eval 'window.__bp.clicked = Math.round(performance.now() - window.__bp.t0); return 1' >/dev/null
  $W click ".bots-row[data-profile=\"$name\"] .bots-open" >/dev/null
  for _ in $(seq 1 600); do [ "$($W eval 'return window.__bp.ready ?? null')" != null ] && break; sleep 0.1; done
  $W shot "$label-$i-ready" >/dev/null
  [ -n "${TRACE_DIR:-}" ] && $W eval 'return JSON.stringify({ bp: window.__bp, perf: window.__perf ?? [] })' >"$TRACE_DIR/$name.json"
  t=$($W eval 'const b = window.__bp; return [b.row, b.closed, b.clicked, b.current, b.ready ?? ""].join(",")' | tr -d '"')
  printf '%s\t%s\t%s\t%s\n' "$label" "$i" "$name" "${t//,/$'\t'}" | tee -a "$out"
  $W click '.bots-row[data-profile="default"] .bots-open' >/dev/null
  $W wait '.bots-row.is-current[data-profile="default"]' "" 60000 >/dev/null
  $W gone .switch-progress "" 60000 >/dev/null
  remove "$name" || echo "couldn't delete $name: delete it by hand" >&2
  $W click '.bots-head button[aria-label*="eload"]' >/dev/null
  $W gone ".bots-row[data-profile=\"$name\"]" "" 60000 >/dev/null
  sleep 15
done
