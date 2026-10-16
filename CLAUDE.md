@AGENTS.md

## Notas de rama

- Rama `sam-voice`: experimental (firmware 2.7.0, voz SAM). La licencia upstream
  de `vendor/sam/` no es explícita; no la presentes como MIT.
- Skills de proyecto en `.claude/skills/`: `firmware-verify` y `release-checklist`.
- Hooks en `.claude/settings.json`: bloquean flasheo a `RPI-RP2` y ejecutan
  `tsc` tras editar `editor/src`.
- Análisis y propuestas: `docs/project-analysis.md`.
