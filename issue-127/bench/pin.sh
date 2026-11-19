#!/usr/bin/env bash
# pin.sh <cpulist> : pin every process (all threads) on the run's display, Xvfb included, to cpulist
. "$HV_RUN/state.env"
for p in /proc/[0-9]*; do p=${p#/proc/}
  grep -qz "^DISPLAY=$DISPLAY_NUM$" /proc/$p/environ 2>/dev/null || continue
  c=$(cat /proc/$p/comm 2>/dev/null); case $c in bash|sh|zsh|node) continue;; esac
  taskset -a -cp "$1" "$p" >/dev/null && echo "pinned $c ($p)"
done
[ -n "$XVFB_PID" ] && taskset -a -cp "$1" "$XVFB_PID" >/dev/null && echo "pinned Xvfb ($XVFB_PID)"
