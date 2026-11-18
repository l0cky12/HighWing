#!/bin/bash
# Settings' scrolling timed in the real app. Starts its own `hv up` (stand-in), signs in, opens Settings, and on each
# page that scrolls turns the wheel with real X input (xdotool, a click every 16 ms) to the foot and back, <samples>
# times. Each sample records frame intervals and the number of scroll events (probe.js), how often the current
# jump link changed, and the CPU the app's processes used. Needs `hv bootstrap` and `hv build` (HV_TARGET picks the build).
# chromium.mjs times the scroll-spy's own work, which these frames can't separate from painting.
#   bench/settings-scroll/run.sh <out.jsonl> [samples] [label]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S=$(git -C "$HERE" rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts
W=$S/wd.mjs
out=${1:?out.jsonl} samples=${2:-5} label=${3:-build}
PAGES=(Appearance "Keyboard Shortcuts" Voice Model Providers)
run=$("$S/hv" up 2>&1 | sed -n 's/^export HV_RUN=//p')
[ -n "$run" ] || { echo "hv up failed" >&2; exit 1; }
export HV_RUN=$run
trap '"$S/hv" down >/dev/null 2>&1' EXIT
. "$HV_RUN/state.env"
"$HERE/../clone-profile/signin.sh" >/dev/null
$W press 'Control+,' >/dev/null
$W wait .settings-main "" 20000 >/dev/null
$W eval "$(cat "$HERE/probe.js"); return !!window.__scroll" | grep -q true || { echo "probe did not install" >&2; exit 1; }

hz=$(getconf CLK_TCK)
ticks() {
  local p comm t=0
  for p in /proc/[0-9]*; do
    p=${p#/proc/}
    grep -qz "^DISPLAY=$DISPLAY_NUM$" "/proc/$p/environ" 2>/dev/null || continue
    comm=$(cat "/proc/$p/comm" 2>/dev/null) || continue
    case $comm in openbox | tauri-driver | WebKitWebDriver | bash | sh | zsh | xdotool) continue ;; esac
    t=$((t + $(awk '{ sub(/^.*\) /, ""); print $12 + $13 }' "/proc/$p/stat" 2>/dev/null || echo 0)))
  done
  echo "$t"
}

$W eval 'window.__pt = null; addEventListener("pointermove", (e) => (window.__pt = [e.clientX, e.clientY])); return 1' >/dev/null
"$S/hv" x mousemove 400 400 >/dev/null
read -r px py < <($W eval 'return (window.__pt ?? []).join(" ")' | tr -d '"')
[ -n "$px" ] || { echo "no pointermove reached the page" >&2; exit 1; }
read -r mx my < <($W eval 'const r = document.querySelector(".settings-main").getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)].join(" ")' | tr -d '"')
sx=$((400 - px + mx)) sy=$((400 - py + my))

for page in "${PAGES[@]}"; do
  $W click .settings-tab "$page" >/dev/null
  $W wait '[aria-current=location]' "" 10000 >/dev/null
  clicks=$($W eval 'const m = document.querySelector(".settings-main"); return Math.ceil((m.scrollHeight - m.clientHeight) / 40) + 5')
  for i in $(seq 1 "$samples"); do
    $W eval 'document.querySelector(".settings-main").scrollTop = 0; return new Promise((r) => setTimeout(r, 300))' >/dev/null
    $W eval 'return window.__scroll.start()' >/dev/null
    t0=$(ticks)
    "$S/hv" x mousemove "$sx" "$sy" click --repeat "$clicks" --delay 16 5 click --repeat "$clicks" --delay 16 4 >/dev/null
    $W eval 'return new Promise((r) => setTimeout(r, 400))' >/dev/null
    t1=$(ticks)
    sample=$($W eval 'return window.__scroll.stop()' | tr -d '\n ')
    cpu=$(awk -v d=$((t1 - t0)) -v hz="$hz" 'BEGIN { printf "%d", 1000 * d / hz }')
    echo "{\"label\":\"$label\",\"page\":\"$page\",\"kind\":\"wheel\",\"sample\":$i,\"clicks\":$clicks,\"cpuMs\":$cpu,\"load\":\"$(cut -d' ' -f1-3 /proc/loadavg)\",\"probe\":$sample}" | tee -a "$out"
  done
done
$W shot "settings-scroll-$label" >/dev/null
