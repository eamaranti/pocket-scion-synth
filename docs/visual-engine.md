# Visual performance engine

The editor's **Visual performance** tab renders live MIDI as one of five
scenes. This document describes the architecture for contributors; the user
guide is in [editor.md](editor.md#visual-performance).

## Scenes

| Scene | Renderer | Module |
| --- | --- | --- |
| Bioluminescent forest | WebGL2 / Three.js | `visual-flora.ts` (`forestConfig`) |
| Deep ocean | WebGL2 / Three.js | `visual-ocean.ts` |
| Nebula | WebGL2 / Three.js | `visual-nebula.ts` |
| Dusk garden | WebGL2 / Three.js | `visual-flora.ts` (`gardenConfig`) |
| Neural network | Canvas 2D | `visual-neural.ts` |

The forest and garden share `FloraScene`, which differs only by configuration
(palette, lighting, fog, glow, and whether Bass grows mushrooms or trees).

## Module layout

```text
editor/src/
  main.ts            tab UI, MIDI → engine wiring, scene selector
  visual-names.ts    scene ids and labels (no Three.js import)
  visual3d.ts        Three.js engine: renderer, post-processing, camera, words, scene swap
  visual-core.ts     shared types, noise GLSL, sky dome, particle field, burst pool, blade field
  visual-flora.ts    forest and garden
  visual-ocean.ts    ocean
  visual-nebula.ts   nebula
  visual-neural.ts   2D neural network (implements the same VisualEngine interface)
```

`main.ts` only depends on the `VisualEngine` interface
(`noteOn`, `pulse`, `phrase`, `setControls`, `setTint`, `setInstrument`,
`setPersistence`, `resize`, `render`, `clear`, `dispose`). Both the Three.js
engine and the neural engine implement it, so adding a scene means implementing
`VisualScene` (3D) or a new engine (2D) and listing it in `visual-names.ts`.

## Loading and lifecycle

- `visual3d` (~157 KB gzip with Three.js) and `visual-neural` are loaded with
  dynamic `import()` the first time the tab needs them, keeping the editor's
  initial bundle small.
- Every engine gets a fresh `<canvas>`. A WebGL context lost by `dispose()`
  cannot be reused, so switching 3D → 2D → 3D replaces the element.
- Changing between 3D scenes reuses the renderer: the old scene is disposed
  and the new one built while the final post-process pass fades through black.
- If WebGL2 is unavailable, the tab reports the error and falls back to the
  neural network.
- The chosen scene is stored in `localStorage` (`scion-visual-scene`); the
  former value `classic` migrates to `neural`.

## MIDI mapping

| Input | Effect |
| --- | --- |
| Note on, channel 1–3 | Spawns an organism (3D) or stimulates a neuron (2D); pitch → horizontal position, velocity → size/intensity, lane → kind |
| CC 74 cutoff | Opens leaves, petals and light; neuron pulse speed and reach |
| CC 71 resonance | Bloom and turbulence; lowers neuron firing threshold |
| CC 1 modulation | Sway, pulsing, flow strength |
| CC 2 breath | Glow, haze density, background activity |
| Pitch bend | Wind and camera lean; parallax shift in 2D |
| CC 119 | SAM phrase: words drift through the scene, the neural net fires together |
| Program change / bank select | Rotates the palette; rewires the neural network |
| MIDI clock | Small energy pulse every beat |
| Bank LED colour | Tints every scene |

## Rendering notes

- 3D post-processing: afterimage (Persistence) → bloom → output tone mapping →
  finishing pass (vignette, chromatic aberration scaled by note energy, grain,
  rare slice shift on ratchets, scene fade).
- Pixel ratio is capped at 1.75; shadow mapping is enabled for flora scenes.
- Geometry is procedural and cached per variant (mushroom lathes, recursive
  trees, fronds, flower stalks); materials are shared and driven by controller
  uniforms.
- The 2D engine pre-renders the resting tissue (dendrites, axons, terminals) to
  one offscreen canvas per depth layer and draws only active pulses, glows,
  vesicles and ripples each frame. Additive light is scaled by the trail fade
  rate so Persistence does not change overall brightness.

## Verification status

Scenes were rendered in headless Chrome with a software WebGL stack using
simulated notes and checked visually. They were **not** profiled on a GPU and
were not tested with a connected Pocket SCION. Check frame rate on target
hardware, especially the forest and garden shadow passes, before relying on
them for a live set.
