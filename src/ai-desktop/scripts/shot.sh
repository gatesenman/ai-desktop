#!/bin/bash
# usage: scripts/shot.sh <name> <userdata-scene> [electron args...]  -> /tmp/shots/cap-<name>, log /tmp/shots/<name>.log
set -u
name=$1; ud=$2; shift 2
cd "$(dirname "$0")/.."
rm -rf /tmp/shots/cap-$name
pgrep -f "mock-ai.mjs" >/dev/null || (nohup node scripts/mock-ai.mjs 8787 >/tmp/shots/mock.log 2>&1 &)
sleep 0.5
AI_DESKTOP_NO_GPU=1 AI_DESKTOP_DIR=/tmp/fdesk timeout ${SHOT_TIMEOUT:-360} xvfb-run -a -s "-screen 0 ${SHOT_SCREEN:-1600x1000x24}" npx electron . --no-sandbox --user-data-dir=/tmp/shots/ud-$ud --capture=/tmp/shots/cap-$name "$@" >/tmp/shots/$name.log 2>&1
echo "exit $? ; $(ls /tmp/shots/cap-$name 2>/dev/null | tr '\n' ' ')"
