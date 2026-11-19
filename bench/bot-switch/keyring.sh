#!/bin/bash
# Starts a throwaway gnome-keyring on the verify run's private bus, so the app saves its password at sign-in and a
# relaunch signs in by itself. Run it before the first `wd.mjs open`. `hv down` doesn't stop it: kill the PID it prints.
set -euo pipefail
. "$HV_RUN/state.env"
mkdir -m 700 -p "$HV_RUN/runtime"
printf throwaway | env -i PATH=/usr/bin:/bin DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" HOME="$HV_RUN/home" \
  XDG_DATA_HOME="$HV_RUN/data" XDG_RUNTIME_DIR="$HV_RUN/runtime" gnome-keyring-daemon --unlock --components=secrets --daemonize
for pid in $(pgrep -x gnome-keyring-d); do
  grep -qz "$HV_RUN" "/proc/$pid/environ" 2>/dev/null && echo "keyring pid $pid"
done
