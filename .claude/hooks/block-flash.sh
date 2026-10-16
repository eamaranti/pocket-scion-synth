#!/bin/bash
# Block flashing hardware from Claude unless the user does it themselves.
cmd=$(jq -r '.tool_input.command // ""')
if echo "$cmd" | grep -Eq 'RPI-RP2|picotool +(load|reboot)'; then
  echo "Blocked: flashing hardware requires explicit user action (see AGENTS.md)." >&2
  exit 2
fi
