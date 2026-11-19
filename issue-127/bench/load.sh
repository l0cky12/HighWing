#!/usr/bin/env bash
# load.sh start <n> <cpulist> | stop : busy loops pinned to cpulist, PIDs kept in /tmp/hv127/load.pids
case $1 in
  start) : > /tmp/hv127/load.pids; for i in $(seq "$2"); do setsid taskset -c "$3" sh -c 'while :; do :; done' </dev/null >/dev/null 2>&1 & echo $! >> /tmp/hv127/load.pids; done; cat /tmp/hv127/load.pids | tr '\n' ' ';;
  stop) xargs -r kill < /tmp/hv127/load.pids; : > /tmp/hv127/load.pids; echo stopped;;
esac
