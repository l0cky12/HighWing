#!/bin/bash
# Times opening a long Bot Chat in the real app, with no profile switch and its Saved copy already on this computer
# (#124): the stand-in's bot ada has the bench's chat of <turns> turns (HV_BOT_TURNS) as its Bot Chat. After one visit
# to ada, each sample opens a new chat with ada, then clicks ada's row and times it with probe.js. It also follows the
# transcript for 60 frames from the first message on screen, to check that the chat opens at the bottom and stays
# there. Starts its own `hv up` and signs in, so it needs only `hv build` first. One TSV row per sample goes to <out>:
# label, sample, then ms from the click to: bot, chat, ready; the messages and chunks in the page at `chat`, the most
# the view was ever off the bottom in those 60 frames (px), and the chunks in the page at the end.
#   bench/bot-switch/open.sh <label> <turns> <samples> <out.tsv>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S=$(git -C "$HERE" rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
W=$S/wd.mjs
label=${1:?label} turns=${2:?turns} samples=${3:?samples} out=${4:?out.tsv}
run=$(HV_BOTS=1 HV_BOT_TURNS=$turns "$S/hv" up 2>&1 | sed -n 's/^export HV_RUN=//p')
[ -n "$run" ] || { echo "hv up failed" >&2; exit 1; }
export HV_RUN=$run
trap '"$S/hv" down >/dev/null 2>&1' EXIT
"$HERE/../clone-profile/signin.sh" >/dev/null

bots='.sidebar [role=tab][data-mode=bots]'
$W click "$bots" >/dev/null
$W wait '.bots-row[data-profile=ada]' "" 30000 >/dev/null
$W click '.bots-row[data-profile=ada] .bots-open' >/dev/null
$W wait '.msg.assistant' "" 60000 >/dev/null
$W gone .switch-progress "" 60000 >/dev/null

WATCH='const bs = window.__bs; bs.offBottom = 0; bs.frames = 0;
const follow = () => {
  if (bs.chat === undefined) return requestAnimationFrame(follow);
  const t = document.querySelector(".transcript");
  if (bs.frames === 0) bs.chunksAtChat = document.querySelectorAll(".transcript-chunk").length;
  bs.offBottom = Math.max(bs.offBottom, Math.round(t.scrollHeight - t.scrollTop - t.clientHeight));
  if (++bs.frames < 60) requestAnimationFrame(follow);
};
requestAnimationFrame(follow);
return 1'
for i in $(seq 1 "$samples"); do
  $W click button "New chat with Ada" >/dev/null
  $W gone .msg "" 30000 >/dev/null
  sleep 1
  $W eval "$(sed -e "s/__PROFILE__/ada/" -e "s/__NAME__/Ada/" "$HERE/probe.js")" >/dev/null
  $W eval "$WATCH" >/dev/null
  $W click '.bots-row[data-profile=ada] .bots-open' >/dev/null
  for _ in $(seq 1 300); do
    [ "$($W eval 'return (window.__bs.ready !== undefined && window.__bs.frames >= 60) || window.__bs.error || null')" != null ] && break
    sleep 0.1
  done
  row=$($W eval 'const b = window.__bs; return [b.bot, b.chat, b.ready, b.chatCount, b.chunksAtChat, b.offBottom, document.querySelectorAll(".transcript-chunk").length, b.error ?? ""].join("\t")' | python3 -c 'import json, sys; print(json.loads(sys.stdin.read()))')
  printf '%s\t%s\t%s\n' "$label" "$i" "$row" | tee -a "$out"
done
