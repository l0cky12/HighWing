#!/usr/bin/env bash
# Runs an AppImage the way a user does (through FUSE) on a virtual display and checks that it opens a window titled
# Highwing (ADR 0213).
#
#   scripts/release/appimage-launches.sh <path to the AppImage>
#
# Needs xvfb-run, xdotool and FUSE with a `fusermount` command (package fuse3 on Ubuntu 24.04). Exits 0 when the
# window appeared, 1 when the app exited first or no window showed up within 60 seconds, printing the app's log.
set -euo pipefail

if [[ ${1:-} == --inside ]]; then
  appimage=$2
  home=$(mktemp -d)
  log=$home/app.log
  pid=
  trap '[[ -n $pid ]] && kill -TERM -- "-$pid" 2> /dev/null; rm -rf "$home"' EXIT
  mkdir -m 700 "$home/run"
  # A throwaway account, so a Highwing of this machine's own can't be what answers. HERMES_CHAT_NEW_INSTANCE makes
  # the app start even if one is already running, which would otherwise hand over to it and exit.
  export HOME=$home XDG_CONFIG_HOME=$home/config XDG_DATA_HOME=$home/data XDG_CACHE_HOME=$home/cache \
    XDG_RUNTIME_DIR=$home/run HERMES_CHAT_NEW_INSTANCE=1
  setsid "$appimage" > "$log" 2>&1 &
  pid=$!
  for _ in $(seq 60); do
    if ! kill -0 "$pid" 2> /dev/null; then
      echo "error: $appimage exited before it opened a window" >&2
      cat "$log" >&2
      exit 1
    fi
    if xdotool search --name '^Highwing$' > /dev/null 2>&1; then
      echo "ok: $appimage opened a window titled Highwing"
      exit 0
    fi
    sleep 1
  done
  echo "error: $appimage opened no window titled Highwing within 60 seconds" >&2
  cat "$log" >&2
  exit 1
fi

appimage=$(realpath "${1:?path to the AppImage}")
exec xvfb-run -a "$(realpath "$0")" --inside "$appimage"
