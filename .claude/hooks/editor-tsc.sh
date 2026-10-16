#!/bin/bash
f=$(jq -r '.tool_input.file_path // ""')
case "$f" in
  */editor/src/*.ts)
    cd "$(dirname "$f")/.." && out=$(npx --no-install tsc --noEmit 2>&1) || { echo "$out" >&2; exit 2; } ;;
esac
