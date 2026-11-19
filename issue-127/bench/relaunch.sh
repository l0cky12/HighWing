#!/usr/bin/env bash
# relaunch.sh <app binary> : restart the app under WebDriver with that binary, sign in, pin to cores 20,21, open Settings
set -e
[ -n "$2" ] && sed -i "s|^BUILD_REV=.*|BUILD_REV='$2'|; s|^export BUILD_REV=.*|export BUILD_REV='$2'|" "$HV_RUN/state.env"
sed -i "s|^APP=.*|APP='$1'|; s|^export APP=.*|export APP='$1'|" "$HV_RUN/state.env"
$S/wd.mjs close >/dev/null 2>&1 || true
$S/wd.mjs open >/dev/null
$S/wd.mjs wait button Connect 30000 >/dev/null
$S/wd.mjs fill input "Dashboard password" -- verify-pass >/dev/null
$S/wd.mjs click button Connect >/dev/null
$S/wd.mjs wait button "Search all chats (Ctrl+K)" 30000 >/dev/null
/tmp/hv127/pin.sh 20,21 >/dev/null
$S/wd.mjs press Control+, >/dev/null
$S/wd.mjs wait .settings-main >/dev/null
for i in 1 2 3 4 5; do $S/wd.mjs click "button[role=tab]" Skills >/dev/null 2>&1 && break; sleep 1; done
$S/wd.mjs wait ".settings-main" "bench-skill-44" 20000 >/dev/null
echo "relaunched $(basename $(dirname $1))/$(basename $1); pinned $(taskset -cp $(pgrep -f -n WebKitWebProces) | awk '{print $NF}')"
