#!/bin/bash
# Times a bot switch in the real app against a real Hermes, as the owner sees it: from the click on a bot's row to
# that bot shown, its chat's messages shown, and everything loaded (probe.js). Each launch relaunches the app, so its
# memory is cold, then clicks every bot once (a first visit) and every bot once more (a visited bot). The order turns
# by one bot per launch. Clicks are $GAP s apart (default 12), because every profile switch signs in again and
# Hermes refuses sign-ins that come too often.
# Needs a signed-in app (bench/bot-create/signin.sh) whose password is in a keyring on the run's bus, so a relaunch
# signs in by itself; keyring.sh starts one. With TRACE_DIR set, each switch's timeline is saved there for phases.py;
# it has entries only in a build with instrument.patch applied. With FORGET=1, each launch first deletes every chat's
# Saved copy, so its first visits are to bots never opened on this computer.
#   bench/bot-switch/run.sh <label> <launches> <out.tsv>
# Each row: label, launch, step, visit (first|again), profile, then ms from the click to: respond, bot, chat, ready,
# then the error, the header and last message at `chat`, and the message counts at chat and ready.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(git -C "$HERE" rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts/wd.mjs
label=$1 launches=$2 out=$3 gap=${GAP:-12}

bots() { $W eval 'return [...document.querySelectorAll(".bots-row")].map((r) => r.dataset.profile + "=" + r.querySelector(".bots-name").textContent.trim()).join("\n")' | tr -d '"' | sed 's/\\n/\n/g'; }

for l in $(seq 1 "$launches"); do
  $W close >/dev/null 2>&1 || true
  $W open >/dev/null
  $W wait '.status-conn.connected' "" 60000 >/dev/null
  if [ -n "${FORGET:-}" ]; then
    $W eval 'Object.keys(localStorage).filter((k) => k.startsWith("hermes-chat.transcript.")).forEach((k) => localStorage.removeItem(k)); return 1' >/dev/null
    $W close >/dev/null
    $W open >/dev/null
    $W wait '.status-conn.connected' "" 60000 >/dev/null
  fi
  $W click '[role=tab][data-mode=bots]' >/dev/null
  $W wait '.bots-row[data-profile="default"]' "" 30000 >/dev/null
  $W gone .switch-progress "" 60000 >/dev/null
  sleep "$gap"
  mapfile -t all < <(bots)
  n=${#all[@]}
  order=()
  for i in $(seq 0 $((n - 1))); do order+=("${all[$(((i + l) % n))]}"); done
  step=0
  for visit in first again; do
    for pair in "${order[@]}"; do
      profile=${pair%%=*} name=${pair#*=}
      step=$((step + 1))
      $W eval 'window.__perf = []; return 1' >/dev/null
      $W eval "$(sed -e "s/__PROFILE__/$profile/" -e "s/__NAME__/$name/" "$HERE/probe.js")" >/dev/null
      $W click ".bots-row[data-profile=\"$profile\"] .bots-open" >/dev/null
      for _ in $(seq 1 600); do
        [ "$($W eval 'return window.__bs.ready ?? window.__bs.error ?? null')" != null ] && break
        sleep 0.1
      done
      $W shot "$label-$l-$step-$profile" >/dev/null
      [ -n "${TRACE_DIR:-}" ] && $W eval 'return JSON.stringify({ bs: window.__bs, perf: window.__perf ?? [] })' >"$TRACE_DIR/$label-$l-$step-$profile.json"
      row=$($W eval 'const b = window.__bs; return [b.respond, b.bot, b.chat, b.ready, b.error, b.chatTitle, b.chatLast, b.chatCount, b.readyCount].map((v) => String(v ?? "").replace(/[\t\n]/g, " ")).join("\t")' | python3 -c 'import json, sys; print(json.loads(sys.stdin.read()))')
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$l" "$step" "$visit" "$profile" "$row" | tee -a "$out"
      sleep "$gap"
    done
  done
done
