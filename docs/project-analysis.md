# Análisis del proyecto y skills recomendadas

Documento de orientación para trabajar con Claude Code en este repositorio
(rama `sam-voice`, firmware 2.7.0). La fuente de verdad sobre reglas de
ingeniería sigue siendo [`AGENTS.md`](../AGENTS.md); aquí se resume el
proyecto y se propone qué skills, plugins y automatizaciones aportan valor.

## 1. Qué es

Firmware *clean-room* alternativo para el Instruō Pocket SCION (RP2040). Un
sensor de pulsos GPIO0 (planta/tacto) alimenta un secuenciador euclidiano
generativo con tres voces monofónicas PRA32-U (bajo/percusión, pad, lead) y,
en esta rama, una cuarta voz de habla (SAM, Software Automatic Mouth). Hay un
editor web (Web MIDI + SysEx) con visuales en vivo.

## 2. Componentes

| Área | Ruta | Stack | Notas |
| --- | --- | --- | --- |
| Firmware | `src/` (~6 k líneas; `synth.cpp` 3 780) | C11 / C++17, Pico SDK 2.2.0, CMake+Ninja | Dual-core, PIO0+DMA I2S 48 kHz, PIO1 WS2812 |
| DSP vendorizado | `vendor/pra32-u/` | C++ headers | Fijado; no reformatear |
| Voz SAM | `vendor/sam/`, `src/sam_voice.c` | C | Renderiza en core 1, streaming con ring de 512 B; licencia upstream no explícita |
| PIO | `pio/*.pio` | PIO asm | I2S y WS2812 |
| Placa | `boards/pocket_scion.h` | — | Pines en `src/board_pins.h` |
| Editor | `editor/` (`main.ts` 1 500 líneas) | TypeScript, Vite 6, Vitest 3 | PWA; protocolo SysEx en `protocol.ts` |
| Tests host | `tests/*.c`, `editor/src/protocol.test.ts` | C con `cc`, Vitest | Sin framework C; se compilan a mano |
| Presets | `presets/factory-v2.4/`, `tools/export_factory_banks.swift` | JSON / Swift | Export de bancos desde hardware |
| Releases | `releases/` | UF2 + `SHA256SUMS` + notas | Solo artefactos verificados |
| CI | `.github/workflows/build.yml` | GitHub Actions | Tests host, build UF2, editor, deploy a Pages |
| Docs | `docs/` | Markdown | Arquitectura, protocolo, hardware-testing, SAM… |

Flujo de datos: `GPIO0 → intervalos → estadísticas → 3 carriles euclidianos →
notas/ratchets → 3 voces mono (+ SAM) → chorus/delay → limitador → PIO+DMA →
DAC I2S`; los mismos eventos van a MIDI DIN (UART0) y USB MIDI.

## 3. Invariantes que más importan

- El render de audio por muestra no bloquea, no asigna memoria, no registra logs.
- Código DSP y tablas calientes viven en SRAM; reparto de cores (core 1 = lead/SAM).
- Cambios en reloj, DMA, PIO, ganancia, efectos, raw capture o memoria entre cores
  son de **alto riesgo** y exigen el checklist físico completo
  (`docs/hardware-testing.md`).
- Nunca flashear hardware sin petición explícita del usuario.
- Nunca incluir firmware, samples ni manual de Instruō (frontera clean-room).
- Si prosa y código discrepan, manda el código (`synth.cpp`, `board_pins.h`) y se
  corrige la prosa en el mismo cambio.
- Compatibilidad: ocho bancos × 16 escenas, patch records prefijo-compatibles,
  JSON de schema 1–5, protocolo SysEx versionado.

## 4. Comandos de verificación

```sh
git diff --check
cc -std=c11 -Wall -Wextra -Werror -Isrc src/sensor_math.c tests/test_sensor_math.c -lm -o /tmp/t1 && /tmp/t1
cc -std=c11 -Wall -Wextra -Werror -Isrc src/editor_protocol.c tests/test_editor_protocol.c -o /tmp/t2 && /tmp/t2
(cd editor && npm ci && npm test && npm run build)
export PICO_SDK_PATH=/ruta/pico-sdk
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build
picotool info -a build/pocket_scion_synth.uf2
```

## 5. Incoherencias detectadas (para corregir)

1. ~~`docs/building.md` pedía versión 2.5.0~~ — corregido a 2.7.0.
2. ~~El CI no corría en push a `sam-voice`~~ — añadida la rama (el deploy a
   Pages sigue limitado a `multi-timbral`).
3. `multi-tibral` en `build.yml` **no es un typo**: es un tag real del repo.
4. `docs/editor-protocol.md` menciona "Firmware 2.6 y posteriores" y "2.7" para
   las capacidades de voz: unificar qué versión introdujo cada campo.
5. Sin los tests de voz SAM (ASan con frases y ajustes extremos) mencionados en
   `docs/sam-voice.md`: no existe archivo en `tests/`. Conviene versionarlos.
6. ~~No existía `CLAUDE.md`~~ — creado.
7. `editor/package-lock.json` aparece modificado sin commit.

## 6. Skills y plugins: propuesta

### Ya instaladas y útiles aquí

| Skill / plugin | Uso en este proyecto |
| --- | --- |
| `commit-commands` (`commit`, `commit-push-pr`) | Commits y PRs con el formato de AGENTS.md |
| `code-review` y `simplify` | Revisar diffs de firmware y del editor antes del PR |
| `claude-security:scan` | Parsing de SysEx, buffers de SAM y flash journal: superficie de memoria real |
| `frontend-design` | Pulir el editor web y los visuales en vivo |
| `claude-md-management` | Crear y mantener `CLAUDE.md` |
| `claude-code-setup` | Recomendador de hooks/subagentes (base de este análisis) |
| `dataviz` | Gráficas de calibración del sensor y visuales |
| `run` | Levantar `npm run dev` del editor y verificarlo en el navegador |
| `fewer-permission-prompts` | Permitir `cc`, `cmake`, `npm test`, `git diff` sin preguntas |

### No relevantes (ignorar en este repo)

Todas las skills de Cloudflare, Supabase, Figma y `claude-api`: el proyecto no
usa esos servicios. Figma solo sería útil si se rediseña el editor.

### A instalar / crear (prioridad)

**Alta**

1. **Skills de proyecto en `.claude/skills/`** (se versionan con el repo):
   - `firmware-verify`: ejecuta el bloque de la sección 4, resume resultados y
     declara si hubo prueba en hardware (regla de AGENTS.md).
   - `release-checklist`: automatiza el checklist de release (versión en CMake,
     nombres, `SHA256SUMS`, `picotool`, notas, enlace de recuperación).
   - `hardware-test-report`: genera el informe a partir de
     `docs/hardware-testing.md` con commit, fuente de alimentación, audio, MIDI.
   - `sysex-protocol-change`: guía para tocar a la vez `editor_protocol.c/.h`,
     `protocol.ts`, `docs/editor-protocol.md` y ambos tests.
   - `clean-room-check`: revisa un diff buscando contenido de Instruō
     (binarios, samples, volcados) antes de commitear.
2. **Skill de Pico SDK / embedded** del ecosistema (p. ej. buscar en
   `npx skills find pico-sdk` o RP2040): el catálogo cambia, revisar el
   código fuente antes de instalar cualquier skill de terceros.
3. **Hooks** (vía skill `update-config`):
   - `PostToolUse` sobre `Edit|Write` en `editor/**`: `npx tsc --noEmit`.
   - `PostToolUse` sobre `src/sensor_math.c` / `src/editor_protocol.c`: recompilar
     y correr el test host correspondiente.
   - `PreToolUse` sobre `Bash`: bloquear `cp *.uf2 /Volumes/RPI-RP2*` y `picotool load`
     salvo confirmación explícita (regla "no flashear sin permiso").
   - `PreToolUse` sobre `Write|Edit` en `vendor/**`: avisar, está fijado.

**Media**

4. **Subagente `audio-realtime-reviewer`**: revisa diffs en `src/synth.cpp`,
   `audio_i2s.c`, `sam_voice.c` contra los invariantes de la sección 3
   (asignación, bloqueos, SRAM, cross-core).
5. **Subagente `protocol-sync-checker`**: verifica coherencia entre C, TS y docs.
6. **MCP `context7`** para documentación actualizada de Vite, Vitest y Web MIDI.
7. **MCP de navegador** (Playwright o el integrado) para probar el editor con
   un Web MIDI simulado; la skill `run` ya cubre el arranque.

**Baja**

8. Plugin `pr-review-toolkit` para revisiones más profundas de PR.
9. Skill de `swift` solo si se amplía `tools/export_factory_banks.swift`.
10. Skill `graphify`: el `CLAUDE.md` global lo menciona pero este repo no tiene
    `graphify-out/`; ejecutar `graphify` una vez si se quiere consulta por grafo
    (`synth.cpp` con 3 780 líneas es buen candidato).

## 7. Siguientes pasos sugeridos

1. Crear `CLAUDE.md` con `@AGENTS.md` y una nota de rama (`sam-voice`,
   experimental, licencia SAM sin resolver).
2. Corregir las incoherencias de la sección 5 (1 y 3 son rápidas).
3. Crear `firmware-verify` y `release-checklist` como primeras skills de proyecto.
4. Añadir los hooks de protección de flasheo y de `tsc`.
5. Ejecutar `fewer-permission-prompts` tras una sesión de trabajo real.

## 8. Trabajo realizado en esta sesión

- Documentación y propuestas: este archivo, `CLAUDE.md`, skills de proyecto
  (`firmware-verify`, `release-checklist`) y hooks (`.claude/`).
- Correcciones: versión en `docs/building.md`, CI también en `sam-voice`.
- Visual performance: nuevo motor con cuatro escenas 3D (Three.js) y una red
  neuronal 2D bioluminiscente, documentado en
  [visual-engine.md](visual-engine.md) y [editor.md](editor.md).
- Pendiente: medir rendimiento en GPU real, probar con el dispositivo, versionar
  el test ASan de SAM, unificar versiones en `docs/editor-protocol.md`.
