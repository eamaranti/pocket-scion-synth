import type { VisualControls } from "./visual-core";
import type { VisualEngine } from "./visual3d";

// A bioluminescent neural network drawn on a 2D canvas. Each lane of incoming
// MIDI stimulates a neuron; the action potential travels along axons, lights the
// synaptic terminals, releases vesicles and, when the target crosses its
// threshold, fires onward. Three depth layers give parallax.

interface Neuron {
  x: number; y: number; radius: number; layer: number;
  out: number[]; glow: number; hue: number; potential: number; refractory: number;
  arbor: number[]; // flattened dendrite segments x0,y0,cx,cy,x1,y1,width
}
interface Edge {
  a: number; b: number; layer: number; points: Float32Array; length: number;
  energy: number; head: number; dir: 1 | -1; hue: number; hasPulse: boolean;
}
interface Pulse { edge: number; dir: 1 | -1; t: number; speed: number; hue: number; intensity: number; hops: number }
interface Vesicle { x: number; y: number; vx: number; vy: number; life: number; max: number; hue: number; layer: number; size: number }
interface Ripple { x: number; y: number; radius: number; life: number; hue: number; layer: number }
interface Word { text: string; x: number; y: number; vx: number; vy: number; life: number; max: number; size: number }

const SAMPLES = 14;
const LAYERS = [{ count: 46, gap: 0.085, depth: 0.45, alpha: 0.5 }, { count: 62, gap: 0.07, depth: 0.75, alpha: 0.75 }, { count: 78, gap: 0.055, depth: 1, alpha: 1 }];
const LANE_HUES = [196, 142, 318];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createNeuralEngine(canvas: HTMLCanvasElement): VisualEngine {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  const ctx = context;
  const controls: VisualControls = { cutoff: 64, resonance: 32, modulation: 0, breath: 0, bend: 8192 };
  let tintHue = 170, variant = 0, persistence = 10;
  let width = 800, height = 500, ratio = 1;
  let neurons: Neuron[] = [], edges: Edge[] = [];
  const staticLayers: HTMLCanvasElement[] = [];
  const pulses: Pulse[] = [], vesicles: Vesicle[] = [], ripples: Ripple[] = [], words: Word[] = [];
  const plankton: { x: number; y: number; z: number; phase: number }[] = [];
  let energy = 0, flash = 0, lastTime = 0, ambientClock = 0, wind = 0, clearRequested = true;
  const random = mulberry32(Date.now() & 0xffff);

  const laneHue = (lane: number): number => (LANE_HUES[lane % 3] + variant * 13 + (tintHue - 170) * 0.25 + 360) % 360;

  function build(): void {
    const layout = mulberry32(4001 + variant * 977);
    neurons = []; edges = [];
    const scale = Math.max(0.55, Math.min(1.4, Math.sqrt(width * height) / 700));
    LAYERS.forEach((layer, layerIndex) => {
      const first = neurons.length, minGap = layer.gap * Math.min(width, height);
      let attempts = 0;
      while (neurons.length - first < layer.count && attempts++ < layer.count * 60) {
        const x = (layout() * 1.1 - 0.05) * width, y = (layout() * 1.1 - 0.05) * height;
        if (neurons.slice(first).some(other => Math.hypot(other.x - x, other.y - y) < minGap * 2.2)) continue;
        neurons.push({ x, y, radius: (3 + layout() * 3.5) * layer.depth * scale + 1.5, layer: layerIndex, out: [], glow: 0,
          hue: 0, potential: 0, refractory: 0, arbor: [] });
      }
      // Dendritic arbors: curved branches that fork twice.
      for (let index = first; index < neurons.length; index++) {
        const neuron = neurons[index];
        const branches = 4 + Math.floor(layout() * 3), reach = minGap * (1.1 + layout() * 0.7);
        const fork = (x: number, y: number, angle: number, length: number, depth: number, thickness: number): void => {
          const bend = (layout() - 0.5) * 0.9;
          const mx = x + Math.cos(angle) * length * 0.5, my = y + Math.sin(angle) * length * 0.5;
          const ex = x + Math.cos(angle + bend) * length, ey = y + Math.sin(angle + bend) * length;
          neuron.arbor.push(x, y, mx + Math.cos(angle + 1.57) * bend * length * 0.35, my + Math.sin(angle + 1.57) * bend * length * 0.35, ex, ey, thickness);
          if (depth > 0) {
            fork(ex, ey, angle + bend - 0.55 - layout() * 0.4, length * 0.62, depth - 1, thickness * 0.7);
            fork(ex, ey, angle + bend + 0.55 + layout() * 0.4, length * 0.62, depth - 1, thickness * 0.7);
          }
        };
        for (let branch = 0; branch < branches; branch++) {
          fork(neuron.x, neuron.y, branch / branches * Math.PI * 2 + layout() * 0.6, reach, 2, 1.3 * layer.depth + 0.3);
        }
      }
      // Axons: each neuron projects to its nearest neighbours.
      const linked = new Set<string>();
      for (let index = first; index < neurons.length; index++) {
        const near = neurons.slice(first).map((other, offset) => ({ offset: first + offset, distance: Math.hypot(other.x - neurons[index].x, other.y - neurons[index].y) }))
          .filter(entry => entry.offset !== index).sort((p, q) => p.distance - q.distance).slice(0, 3);
        for (const { offset } of near) {
          const key = index < offset ? `${index}:${offset}` : `${offset}:${index}`;
          if (linked.has(key)) continue;
          linked.add(key);
          const a = neurons[index], b = neurons[offset];
          const length = Math.hypot(b.x - a.x, b.y - a.y), sway = (layout() - 0.5) * length * 0.5;
          const cx = (a.x + b.x) / 2 - (b.y - a.y) / length * sway, cy = (a.y + b.y) / 2 + (b.x - a.x) / length * sway;
          const points = new Float32Array((SAMPLES + 1) * 2);
          for (let step = 0; step <= SAMPLES; step++) {
            const t = step / SAMPLES, u = 1 - t;
            points[step * 2] = u * u * a.x + 2 * u * t * cx + t * t * b.x;
            points[step * 2 + 1] = u * u * a.y + 2 * u * t * cy + t * t * b.y;
          }
          edges.push({ a: index, b: offset, layer: layerIndex, points, length, energy: 0, head: 0, dir: 1, hue: 190, hasPulse: false });
          a.out.push(edges.length - 1); b.out.push(edges.length - 1);
        }
      }
    });
    plankton.length = 0;
    for (let index = 0; index < 140; index++) plankton.push({ x: layout() * width, y: layout() * height, z: 0.3 + layout() * 0.7, phase: layout() * 6.28 });
    pulses.length = 0; vesicles.length = 0; ripples.length = 0;
    paintStatic();
  }

  /** The resting tissue: faint dendrites, axons and boutons rendered once per layer. */
  function paintStatic(): void {
    const base = laneHue(1) - 140 + 190; // keep a cool bioluminescent base that follows the instrument hue
    LAYERS.forEach((layer, layerIndex) => {
      const surface = staticLayers[layerIndex] ?? (staticLayers[layerIndex] = document.createElement("canvas"));
      surface.width = Math.floor(width * ratio); surface.height = Math.floor(height * ratio);
      const paint = surface.getContext("2d")!;
      paint.setTransform(ratio, 0, 0, ratio, 0, 0); paint.clearRect(0, 0, width, height);
      paint.lineCap = "round";
      paint.strokeStyle = `hsla(${base},70%,55%,${0.1 * layer.alpha})`;
      for (const neuron of neurons) {
        if (neuron.layer !== layerIndex) continue;
        for (let index = 0; index < neuron.arbor.length; index += 7) {
          const a = neuron.arbor;
          paint.beginPath(); paint.lineWidth = a[index + 6];
          paint.moveTo(a[index], a[index + 1]); paint.quadraticCurveTo(a[index + 2], a[index + 3], a[index + 4], a[index + 5]); paint.stroke();
        }
      }
      for (const edge of edges) {
        if (edge.layer !== layerIndex) continue;
        paint.beginPath(); paint.lineWidth = 0.9 * layer.depth + 0.3;
        paint.strokeStyle = `hsla(${base + 10},75%,60%,${0.2 * layer.alpha})`;
        paint.moveTo(edge.points[0], edge.points[1]);
        for (let step = 1; step <= SAMPLES; step++) paint.lineTo(edge.points[step * 2], edge.points[step * 2 + 1]);
        paint.stroke();
        // Synaptic terminals at both ends.
        for (const end of [0, SAMPLES]) {
          paint.beginPath(); paint.fillStyle = `hsla(${base + 25},80%,65%,${0.3 * layer.alpha})`;
          paint.arc(edge.points[end * 2], edge.points[end * 2 + 1], 1.2 * layer.depth + 0.5, 0, Math.PI * 2); paint.fill();
        }
      }
      for (const neuron of neurons) {
        if (neuron.layer !== layerIndex) continue;
        const gradient = paint.createRadialGradient(neuron.x, neuron.y, 0, neuron.x, neuron.y, neuron.radius * 3);
        gradient.addColorStop(0, `hsla(${base + 20},85%,70%,${0.55 * layer.alpha})`);
        gradient.addColorStop(0.35, `hsla(${base},80%,50%,${0.25 * layer.alpha})`);
        gradient.addColorStop(1, `hsla(${base},80%,40%,0)`);
        paint.fillStyle = gradient; paint.beginPath(); paint.arc(neuron.x, neuron.y, neuron.radius * 3, 0, Math.PI * 2); paint.fill();
        paint.beginPath(); paint.fillStyle = `hsla(${base + 30},60%,18%,${0.9 * layer.alpha})`;
        paint.arc(neuron.x, neuron.y, neuron.radius, 0, Math.PI * 2); paint.fill();
        paint.lineWidth = 0.8; paint.strokeStyle = `hsla(${base + 15},85%,65%,${0.45 * layer.alpha})`; paint.stroke();
      }
    });
  }

  function fire(index: number, intensity: number, hue: number, hops: number): void {
    const neuron = neurons[index];
    if (neuron.refractory > 0 || !neuron.out.length) return;
    neuron.refractory = 0.28; neuron.potential = 0; neuron.glow = Math.min(1.2, neuron.glow + intensity * 0.8); neuron.hue = hue;
    const reach = Math.max(1, Math.round(0.8 + intensity * 1.1 + controls.cutoff / 170));
    const speed = 260 + controls.cutoff * 3.4 + intensity * 180;
    const edgesOut = neuron.out.slice().sort(() => random() - 0.5).slice(0, reach);
    for (const edgeIndex of edgesOut) {
      const edge = edges[edgeIndex], dir: 1 | -1 = edge.a === index ? 1 : -1;
      pulses.push({ edge: edgeIndex, dir, t: 0, speed: speed / Math.max(40, edge.length), hue, intensity, hops });
    }
    ripples.push({ x: neuron.x, y: neuron.y, radius: neuron.radius, life: 1, hue, layer: neuron.layer });
    if (pulses.length > 420) pulses.splice(0, pulses.length - 420);
  }

  function arrive(pulse: Pulse): void {
    const edge = edges[pulse.edge];
    const target = neurons[pulse.dir === 1 ? edge.b : edge.a];
    const px = edge.points[(pulse.dir === 1 ? SAMPLES : 0) * 2], py = edge.points[(pulse.dir === 1 ? SAMPLES : 0) * 2 + 1];
    ripples.push({ x: px, y: py, radius: 1, life: 0.9, hue: pulse.hue, layer: edge.layer });
    // Neurotransmitter vesicles spill across the synaptic cleft.
    const count = 5 + Math.round(pulse.intensity * 8);
    for (let index = 0; index < count; index++) {
      const angle = random() * Math.PI * 2, speed = 8 + random() * 38;
      vesicles.push({ x: px, y: py, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, max: 0.8 + random() * 1.1,
        hue: pulse.hue + (random() - 0.5) * 30, layer: edge.layer, size: 0.8 + random() * 1.6 });
    }
    if (vesicles.length > 900) vesicles.splice(0, vesicles.length - 900);
    target.glow = Math.min(1.2, target.glow + 0.3 * pulse.intensity + 0.1);
    target.potential += pulse.intensity * (0.65 + controls.resonance / 160);
    const threshold = 0.78 - controls.resonance / 450;
    if (pulse.hops > 0 && target.potential > threshold) fire(neurons.indexOf(target), pulse.intensity * 0.88, pulse.hue, pulse.hops - 1);
  }

  function pickNeuron(note: number, lane: number): number {
    const targetX = (Math.max(24, Math.min(96, note)) - 24) / 72 * width;
    const bandY = [0.7, 0.5, 0.3][lane % 3] * height + (random() - 0.5) * height * 0.22;
    const layerPick = random() < 0.5 ? 2 : random() < 0.6 ? 1 : 0;
    let best = -1, bestDistance = Infinity;
    neurons.forEach((neuron, index) => {
      if (neuron.layer !== layerPick || !neuron.out.length) return;
      const distance = Math.hypot(neuron.x - targetX, (neuron.y - bandY) * 1.4) + neuron.refractory * 90;
      if (distance < bestDistance) { best = index; bestDistance = distance; }
    });
    return best;
  }

  const offsetFor = (layer: number, time: number): [number, number] => {
    const depth = LAYERS[layer].depth;
    return [(Math.sin(time * 0.05) * 18 + wind * 46) * (1.2 - depth * 0.6) * (layer + 0.6), Math.cos(time * 0.04) * 11 * (1.2 - depth * 0.6) * (layer + 0.6)];
  };

  return {
    setScene() { /* single scene */ },
    noteOn(note, velocity, lane) {
      if (!neurons.length) return;
      const index = pickNeuron(note, lane);
      if (index < 0) return;
      const intensity = 0.45 + velocity / 127 * 0.7;
      neurons[index].refractory = 0;
      fire(index, intensity, laneHue(lane), 1 + Math.round(velocity / 70) + Math.round(controls.resonance / 90));
      energy = Math.min(1, energy + velocity / 150); flash = Math.min(1, flash + velocity / 260);
    },
    pulse(amount) { energy = Math.min(1, energy + amount); ambientClock += amount * 3; },
    phrase(list) {
      list.forEach((text, index) => words.push({
        text, x: width * (0.2 + random() * 0.6), y: height * (0.25 + random() * 0.5), vx: (random() - 0.5) * 8, vy: -4 - random() * 6,
        life: -index * 0.3, max: 4.5 + random() * 2, size: Math.min(64, 22 + text.length * 3.5) }));
      // Speech makes the whole tissue fire together.
      for (let index = 0; index < 8; index++) {
        const neuron = Math.floor(random() * neurons.length);
        if (neurons[neuron]) fire(neuron, 0.7, laneHue(index % 3), 3);
      }
      while (words.length > 24) words.shift();
    },
    setControls(next) { Object.assign(controls, next); },
    setTint(red, green, blue) {
      const max = Math.max(red, green, blue), min = Math.min(red, green, blue), delta = max - min;
      let hue = 0;
      if (delta > 0) hue = max === red ? ((green - blue) / delta) % 6 : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
      const next = (hue * 60 + 360) % 360;
      if (Math.abs(next - tintHue) > 6) { tintHue = next; if (neurons.length) paintStatic(); }
    },
    setInstrument(program) {
      if (program === variant) return;
      variant = program; flash = Math.max(flash, 0.3);
      if (neurons.length) build();
    },
    setPersistence(value) { persistence = value; },
    resize(nextWidth, nextHeight) {
      width = Math.max(320, Math.floor(nextWidth)); height = Math.max(320, Math.floor(nextHeight));
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * ratio); canvas.height = Math.floor(height * ratio);
      clearRequested = true; build();
    },
    render(timeMs) {
      if (!neurons.length) return;
      const time = timeMs / 1000, dt = Math.min(0.08, Math.max(0.001, time - lastTime)); lastTime = time;
      const open = controls.cutoff / 127, mod = controls.modulation / 127, breath = controls.breath / 127;
      wind += ((controls.bend - 8192) / 8192 - wind) * (1 - Math.pow(0.001, dt));

      // Spontaneous background activity keeps the tissue alive between notes.
      ambientClock += dt * (0.5 + breath * 1.5 + mod * 1.2);
      while (ambientClock > 1.6) {
        ambientClock -= 1.6;
        const index = Math.floor(random() * neurons.length);
        fire(index, 0.25 + random() * 0.2, laneHue(Math.floor(random() * 3)), 1);
      }

      const trail = 0.04 + (20 - persistence) * 0.025;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      const wash = ctx.createRadialGradient(width * 0.5, height * 0.55, 0, width * 0.5, height * 0.55, Math.max(width, height) * 0.75);
      wash.addColorStop(0, `hsla(${tintHue + 190},60%,${5 + breath * 4}%,${clearRequested ? 1 : trail})`);
      wash.addColorStop(1, `hsla(${tintHue + 200},70%,2%,${clearRequested ? 1 : trail})`);
      ctx.fillStyle = wash; ctx.fillRect(0, 0, width, height); clearRequested = false;

      for (let layer = 0; layer < LAYERS.length; layer++) {
        const [ox, oy] = offsetFor(layer, time);
        ctx.drawImage(staticLayers[layer], ox, oy, width, height);
      }
      ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
      // Additive light accumulates through the fading trail, so scale it by the fade rate.
      ctx.globalAlpha = Math.min(1.1, trail * 2);

      // Plankton motes drifting in the medium.
      for (const mote of plankton) {
        mote.x += Math.sin(time * 0.3 + mote.phase) * 4 * dt * mote.z; mote.y -= (2 + mod * 6) * dt * mote.z;
        if (mote.y < -5) { mote.y = height + 5; mote.x = random() * width; }
        ctx.fillStyle = `hsla(${tintHue + 10},80%,70%,${(0.1 + breath * 0.2) * mote.z * (0.6 + 0.4 * Math.sin(time + mote.phase))})`;
        ctx.fillRect(mote.x, mote.y, 1.4 * mote.z, 1.4 * mote.z);
      }

      // Advance pulses; lit axon segments trail behind each head.
      for (const edge of edges) edge.energy *= Math.pow(0.12, dt);
      for (let index = pulses.length - 1; index >= 0; index--) {
        const pulse = pulses[index], edge = edges[pulse.edge];
        pulse.t += pulse.speed * dt;
        edge.energy = Math.max(edge.energy, 0.7 * pulse.intensity + 0.15); edge.hue = pulse.hue;
        edge.head = pulse.dir === 1 ? Math.min(1, pulse.t) : 1 - Math.min(1, pulse.t); edge.dir = pulse.dir; edge.hasPulse = true;
        if (pulse.t >= 1) { arrive(pulse); pulses.splice(index, 1); }
      }
      for (const edge of edges) {
        if (edge.energy < 0.02) continue;
        const [ox, oy] = offsetFor(edge.layer, time);
        const last = Math.round(edge.head * SAMPLES);
        const from = edge.dir === 1 ? 0 : last, to = edge.dir === 1 ? last : SAMPLES;
        if (to <= from) continue;
        ctx.beginPath(); ctx.moveTo(edge.points[from * 2] + ox, edge.points[from * 2 + 1] + oy);
        for (let step = from + 1; step <= to; step++) ctx.lineTo(edge.points[step * 2] + ox, edge.points[step * 2 + 1] + oy);
        const layer = LAYERS[edge.layer];
        ctx.strokeStyle = `hsla(${edge.hue},95%,${58 + open * 14}%,${Math.min(1, edge.energy) * 0.6 * layer.alpha})`;
        ctx.lineWidth = (0.8 + edge.energy * 1.1 + controls.resonance / 160) * layer.depth; ctx.stroke();
        ctx.strokeStyle = `hsla(${edge.hue},100%,88%,${Math.min(1, edge.energy) * 0.5 * layer.alpha})`; ctx.lineWidth = 0.7 * layer.depth; ctx.stroke();
      }
      for (const pulse of pulses) {
        const edge = edges[pulse.edge], layer = LAYERS[edge.layer], [ox, oy] = offsetFor(edge.layer, time);
        const position = pulse.dir === 1 ? pulse.t : 1 - pulse.t, exact = Math.max(0, Math.min(1, position)) * SAMPLES;
        const base = Math.min(SAMPLES - 1, Math.floor(exact)), fraction = exact - base;
        const x = edge.points[base * 2] * (1 - fraction) + edge.points[base * 2 + 2] * fraction + ox;
        const y = edge.points[base * 2 + 1] * (1 - fraction) + edge.points[base * 2 + 3] * fraction + oy;
        const size = (5 + pulse.intensity * 5 + open * 2) * layer.depth;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, size);
        glow.addColorStop(0, `hsla(${pulse.hue},100%,92%,${0.95 * layer.alpha})`);
        glow.addColorStop(0.3, `hsla(${pulse.hue},100%,60%,${0.35 * layer.alpha})`);
        glow.addColorStop(1, `hsla(${pulse.hue},100%,50%,0)`);
        ctx.fillStyle = glow; ctx.fillRect(x - size, y - size, size * 2, size * 2);
      }

      // Somas flare when stimulated and settle back slowly.
      for (const neuron of neurons) {
        neuron.refractory = Math.max(0, neuron.refractory - dt);
        neuron.potential *= Math.pow(0.35, dt);
        if (neuron.glow < 0.02) { neuron.glow = 0; continue; }
        neuron.glow *= Math.pow(0.08, dt);
        const layer = LAYERS[neuron.layer], [ox, oy] = offsetFor(neuron.layer, time);
        const size = neuron.radius * (2.6 + neuron.glow * 2.6) * (1 + breath * 0.25);
        const glow = ctx.createRadialGradient(neuron.x + ox, neuron.y + oy, 0, neuron.x + ox, neuron.y + oy, size);
        glow.addColorStop(0, `hsla(${neuron.hue},100%,85%,${Math.min(1, neuron.glow) * 0.8 * layer.alpha})`);
        glow.addColorStop(0.35, `hsla(${neuron.hue},100%,60%,${Math.min(1, neuron.glow) * 0.3 * layer.alpha})`);
        glow.addColorStop(1, `hsla(${neuron.hue},100%,45%,0)`);
        ctx.fillStyle = glow; ctx.fillRect(neuron.x + ox - size, neuron.y + oy - size, size * 2, size * 2);
        // The lit dendrites shimmer with modulation.
        if (neuron.glow > 0.15) {
          ctx.strokeStyle = `hsla(${neuron.hue},100%,70%,${Math.min(1, neuron.glow) * 0.3 * layer.alpha})`; ctx.lineWidth = 0.8 * layer.depth;
          ctx.beginPath();
          for (let index = 0; index < neuron.arbor.length; index += 7) {
            const a = neuron.arbor, wobble = Math.sin(time * 3 + index) * mod * 2;
            ctx.moveTo(a[index] + ox, a[index + 1] + oy);
            ctx.quadraticCurveTo(a[index + 2] + ox + wobble, a[index + 3] + oy + wobble, a[index + 4] + ox, a[index + 5] + oy);
          }
          ctx.stroke();
        }
      }

      for (let index = ripples.length - 1; index >= 0; index--) {
        const ripple = ripples[index];
        ripple.radius += (34 + open * 40) * dt; ripple.life -= dt * 1.4;
        if (ripple.life <= 0) { ripples.splice(index, 1); continue; }
        const [ox, oy] = offsetFor(ripple.layer, time);
        ctx.beginPath(); ctx.arc(ripple.x + ox, ripple.y + oy, ripple.radius, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${ripple.hue},100%,75%,${ripple.life * 0.5 * LAYERS[ripple.layer].alpha})`; ctx.lineWidth = 1; ctx.stroke();
      }
      for (let index = vesicles.length - 1; index >= 0; index--) {
        const vesicle = vesicles[index];
        vesicle.life -= dt / vesicle.max;
        if (vesicle.life <= 0) { vesicles.splice(index, 1); continue; }
        vesicle.vx = vesicle.vx * Math.pow(0.35, dt) + Math.sin(time * 2 + index) * mod * 20 * dt;
        vesicle.vy = vesicle.vy * Math.pow(0.35, dt) + Math.cos(time * 2 + index) * mod * 20 * dt;
        vesicle.x += vesicle.vx * dt; vesicle.y += vesicle.vy * dt;
        const [ox, oy] = offsetFor(vesicle.layer, time);
        ctx.fillStyle = `hsla(${vesicle.hue},100%,75%,${vesicle.life * 0.85 * LAYERS[vesicle.layer].alpha})`;
        ctx.beginPath(); ctx.arc(vesicle.x + ox, vesicle.y + oy, vesicle.size * (0.5 + vesicle.life * 0.7), 0, Math.PI * 2); ctx.fill();
      }

      // Spoken phrases surface as drifting thoughts.
      ctx.globalCompositeOperation = "lighter"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (let index = words.length - 1; index >= 0; index--) {
        const word = words[index];
        word.life += dt;
        if (word.life < 0) continue;
        if (word.life >= word.max) { words.splice(index, 1); continue; }
        word.x += word.vx * dt; word.y += word.vy * dt;
        const alpha = Math.min(1, word.life * 2, (word.max - word.life) * 0.8) * 0.85;
        ctx.font = `500 ${word.size}px Inter, system-ui, sans-serif`;
        ctx.shadowBlur = 18; ctx.shadowColor = `hsla(${laneHue(1)},100%,70%,${alpha})`;
        ctx.fillStyle = `hsla(${laneHue(1)},60%,92%,${alpha})`; ctx.fillText(word.text, word.x, word.y);
        ctx.shadowBlur = 0;
      }
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;

      energy *= Math.pow(0.985, dt * 60); flash *= Math.pow(0.82, dt * 60);
    },
    clear() { pulses.length = 0; vesicles.length = 0; ripples.length = 0; words.length = 0; neurons.forEach(neuron => { neuron.glow = 0; neuron.potential = 0; }); clearRequested = true; },
    dispose() { pulses.length = 0; vesicles.length = 0; ripples.length = 0; words.length = 0; neurons = []; edges = []; staticLayers.length = 0; },
  };
}
