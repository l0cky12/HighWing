#!/bin/bash
# Times two builds in turn with run.sh (before, after, before, after, ...), so both see the same load and drift.
#   bench/settings-scroll/compare.sh <before target> <after target> <out.jsonl> [rounds] [samples per round]
# A target is an HV_TARGET that `hv build` wrote. summary.mjs reads <out.jsonl>.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
before=${1:?before target} after=${2:?after target} out=${3:?out.jsonl} rounds=${4:-4} samples=${5:-2}
for r in $(seq 1 "$rounds"); do
  HV_TARGET=$before "$HERE/run.sh" "$out" "$samples" before >/dev/null
  HV_TARGET=$after "$HERE/run.sh" "$out" "$samples" after >/dev/null
  echo "round $r of $rounds done, load $(cut -d' ' -f1-3 /proc/loadavg)"
done
