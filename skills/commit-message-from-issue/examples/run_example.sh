#!/usr/bin/env bash
# Replay the offline keras #9585 case: link the issue, write the message, score
# it. No GitHub access needed. The LLM backend is picked automatically; run
# `python3 scripts/pdil.py --check` to see which one, or set CM_LLM_CMD /
# CM_API_KEY + CM_BASE_URL + CM_LLM_MODEL to choose.
set -euo pipefail

SKILL="$(cd "$(dirname "$0")/.." && pwd)"
CASE="${1:-$SKILL/examples/keras-9585}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== case: $CASE ==="
python3 "$SKILL/scripts/link_and_write.py" \
  --diff-file "$CASE/staged.diff" \
  --candidates-file "$CASE/candidates.json" \
  --top-n 5 --chunk-size 30 \
  --out "$WORK/run.json" --message-out "$WORK/msg.txt"

echo
echo "=== scoring (0-4 What/Why) ==="
python3 "$SKILL/scripts/score_message.py" \
  --diff-file "$CASE/staged.diff" \
  --message-file "$WORK/msg.txt"
