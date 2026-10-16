---
name: release-checklist
description: Walk through the Pocket SCION release checklist from AGENTS.md. Only use when the user explicitly asks to prepare a release.
disable-model-invocation: true
---

Follow AGENTS.md "Release checklist". Ask for the version first, then:

1. Update consistently: `pico_set_program_version` in CMakeLists.txt, README
   (install section, filename, SHA-256), docs/building.md expected version,
   `releases/vX.Y.Z.md` notes.
2. Run the `firmware-verify` skill; require a clean Release build.
3. Confirm with `picotool info -a` the version, board `pocket_scion`, RP2040 family.
4. Ask the user to confirm the full `docs/hardware-testing.md` checklist was done
   on hardware; do not claim it yourself.
5. Place only the verified UF2 in `releases/` named `pocket_scion_synth_<version>.uf2`
   and update `releases/SHA256SUMS` (`shasum -a 256`).
6. Check the Instruō factory-recovery link still responds (HTTP 200).
7. Do not commit, push, tag or attach to a GitHub Release without explicit approval.

Report: tests, build result, hardware status, UF2 path, checksum, remaining risk.
