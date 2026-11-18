#!/usr/bin/env bash
# Runs an AppImage the way a user does (through FUSE) on a virtual display and checks that it opens a window titled
# Highwing, and that WebKit gets WEBKIT_DISABLE_DMABUF_RENDERER=1 when it is unset and a value the user set when it
# is set (ADR 0221). It runs the AppImage twice: with the variable unset, then set to 0.
#
#   scripts/release/appimage-launches.sh <path to the AppImage>
#
# Needs xvfb-run, xdotool and FUSE with a `fusermount` command (package fuse3 on Ubuntu 24.04). Exits 0 when both
# runs pass, 1 when the app exited first, no window showed up within 60 seconds, or WebKit got the wrong value,
# printing the app's log.
set -euo pipefail

if [[ ${1:-} == --inside ]]; then
  appimage=$2
  home=$(mktemp -d)
  log=$home/app.log
  pid=
  trap '[[ -z $pid ]] || kill -TERM -- "-$pid" 2> /dev/null || true; rm -rf "$home"' EXIT
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
    if xdotool search --onlyvisible --name '^Highwing$' > /dev/null 2>&1 \
      && web=$(pgrep -s "$pid" -f WebKitWebProcess | head -n 1); then
      want=${WEBKIT_DISABLE_DMABUF_RENDERER-1}
      got=$(tr '\0' '\n' < "/proc/$web/environ" | sed -n 's/^WEBKIT_DISABLE_DMABUF_RENDERER=//p')
      if [[ $got != "$want" ]]; then
        echo "error: WebKit got WEBKIT_DISABLE_DMABUF_RENDERER=${got:-<unset>}, want $want" >&2
        cat "$log" >&2
        exit 1
      fi
      echo "ok: $appimage opened a window titled Highwing, WebKit got WEBKIT_DISABLE_DMABUF_RENDERER=$got"
      exit 0
    fi
    sleep 1
  done
  echo "error: $appimage opened no window titled Highwing within 60 seconds" >&2
  cat "$log" >&2
  exit 1
fi

appimage=$(realpath "${1:?path to the AppImage}")
self=$(realpath "$0")
env -u WEBKIT_DISABLE_DMABUF_RENDERER xvfb-run -a "$self" --inside "$appimage"
WEBKIT_DISABLE_DMABUF_RENDERER=0 xvfb-run -a "$self" --inside "$appimage"
