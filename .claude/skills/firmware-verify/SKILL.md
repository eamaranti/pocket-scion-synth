---
name: firmware-verify
description: Run this project's host tests, editor tests/build and optional firmware build, then report results and hardware-test status. Use before handing off any firmware or editor change.
---

Run from the repo root, report each step as pass/fail with output for failures:

1. `git diff --check`
2. Sensor test:
   `cc -std=c11 -Wall -Wextra -Werror -Isrc src/sensor_math.c tests/test_sensor_math.c -lm -o /tmp/t_sensor && /tmp/t_sensor`
3. Protocol test (if `editor_protocol`, `protocol.ts` or `sam_voice` changed):
   `cc -std=c11 -Wall -Wextra -Werror -Isrc src/editor_protocol.c tests/test_editor_protocol.c -o /tmp/t_proto && /tmp/t_proto`
4. Editor (if `editor/` changed): `cd editor && npm test && npm run build`
5. Firmware build if `PICO_SDK_PATH` is set:
   `cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build`,
   then `picotool info -a build/pocket_scion_synth.uf2` if picotool exists.
   If the SDK is missing, say the build was skipped.

Final summary must state: tests run, build result, and explicitly
"not hardware-tested" unless the user reports physical testing. Never flash
a device. If the change touches clocks, DMA, PIO, gain, effects, raw capture or
cross-core memory, flag it as high-risk requiring `docs/hardware-testing.md`.
