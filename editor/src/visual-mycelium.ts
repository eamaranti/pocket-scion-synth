import * as THREE from "three";
import {
  BurstPool, type SceneContext, type VisualScene, clamp01, createParticleField, createSkyDome,
  disposeTree, easeOutCubic, laneColor, mulberry32, pitchToUnit,
} from "./visual-core";

const MAX_NODES = 16384, TEX = 128, MAX_SEGS = 15000, MAX_TIPS = 260, MAX_COLONIES = 9, MAX_FRUIT = 56, NUTRIENTS = 10;
const SEG = 0.38, CELL = 1.5, PULSE_DECAY = 2.1;
const BOUND_X = 40, Z_MIN = -54, Z_MAX = -2, Y_MIN = -0.3, Y_MAX = 0.4, GROUND = -0.45;
const HUES: [number, number, number] = [0.84, 0.47, 0.13];

interface Colony { id: number; segs: number[]; nodes: number[]; tips: number; dying: boolean; fade: number }
interface Tip {
  node: number; x: number; y: number; z: number; dx: number; dy: number; dz: number;
  colony: Colony; gen: number; speed: number; energy: number; acc: number; turn: number;
  age: number; seek: boolean; recent: number[];
}
interface Nutrient { x: number; z: number; available: boolean; respawn: number; flash: number; size: number }
interface Fruit { node: number; x: number; y: number; z: number; scale: number; rot: number; born: number; lane: number; prev: number }

const SEGMENT_VERTEX = /* glsl */ `
  attribute vec3 aA, aB; attribute vec2 aRad, aNode; attribute float aBirth, aFade;
  uniform float uTime, uScale, uTex, uDecay, uFog, uGlow; uniform sampler2D uPulse;
  uniform vec3 uC0, uC1, uC2;
  varying float vAcross, vBase, vThin, vFog; varying vec3 vPulse;
  vec4 nodeData(float id){ float row = floor(id / uTex); return texelFetch(uPulse, ivec2(int(id - row * uTex), int(row)), 0); }
  float glowOf(vec4 p){ float dt = uTime - p.x; if (p.y <= 0. || dt < 0.) return 0.; return p.y * exp(-dt * uDecay) * min(1., dt / .07); }
  vec3 laneColor(float l){ return l < .5 ? uC0 : (l < 1.5 ? uC1 : uC2); }
  void main(){
    float t = position.x, side = position.y;
    float grow = clamp((uTime - aBirth) / .14, 0., 1.);
    vec3 tip = mix(aA, aB, grow), p = mix(aA, tip, t);
    vec4 mvA = viewMatrix * vec4(aA, 1.), mvT = viewMatrix * vec4(tip, 1.);
    vec2 d = mvT.xy - mvA.xy; float l = length(d); d = l > 1e-5 ? d / l : vec2(1., 0.);
    vec4 mv = viewMatrix * vec4(p, 1.);
    float depth = max(.5, -mv.z);
    float alive = step(.001, aFade) * step(.001, grow);
    float rad = mix(aRad.x, aRad.y, t) * aFade;
    float minRad = .6 * depth / uScale;
    float w = max(rad, minRad) * alive;
    mv.xy += vec2(-d.y, d.x) * side * w + d * (t * 2. - 1.) * w * 1.1;
    gl_Position = projectionMatrix * mv;
    vec4 pa = nodeData(aNode.x), pb = nodeData(aNode.y);
    float ga = glowOf(pa), gb = glowOf(pb);
    vPulse = mix(laneColor(pa.z) * ga, laneColor(pb.z) * gb, t) * uGlow;
    float shimmer = .55 + .45 * sin(uTime * .7 + aNode.x * .37 + t);
    vBase = shimmer * (.45 + clamp(rad * 9., 0., 1.2)) * aFade;
    vThin = clamp(rad / minRad, .3, 1.);
    vFog = exp(-depth * uFog);
    vAcross = side;
  }`;

const SEGMENT_FRAGMENT = /* glsl */ `
  uniform vec3 uBase; varying float vAcross, vBase, vThin, vFog; varying vec3 vPulse;
  void main(){
    float core = pow(1. - abs(vAcross), 1.6);
    vec3 c = uBase * vBase * core + vPulse * (.25 + 1.15 * core);
    gl_FragColor = vec4(c * vFog * vThin, 1.);
  }`;

/**
 * A living mycelial network on a forest floor. Hyphal tips wander with persistent
 * curvature, steer toward buried nutrients, avoid their own colony, branch, and
 * fuse into loops (anastomosis). Notes feed the network: Bass seeds or extends a
 * colony, Pad pushes new hyphae out, Lead sends a fast signal through the graph
 * and raises a fruiting body. Signals travel along the real hyphal graph, so
 * brightness follows connectivity rather than screen distance.
 */
export class MyceliumScene implements VisualScene {
  readonly root = new THREE.Group();
  readonly background = new THREE.Color(0x01040a);
  readonly fog = new THREE.FogExp2(0x03121a, 0.016);
  readonly exposure = 1.1;
  readonly bloom = 1.05;

  private readonly random = mulberry32(4242);
  private readonly sky = createSkyDome(420);
  private readonly spores = createParticleField(700, new THREE.Vector3(84, 9, 62), 0.07, 11);
  private readonly burst = new BurstPool(900);
  private readonly hemisphere = new THREE.HemisphereLight(0x3a7a90, 0x101820, 1.1);
  private readonly pulseLight = new THREE.PointLight(0xffffff, 0, 30, 1.5);

  private readonly pos = new Float32Array(MAX_NODES * 3);
  private readonly nodeColony = new Int32Array(MAX_NODES).fill(-1);
  private readonly nodeAdj: number[][] = Array.from({ length: MAX_NODES }, () => []);
  private readonly freeNodes: number[] = [];
  private readonly freeSegs: number[] = [];
  private readonly hash = new Map<number, number[]>();
  private readonly pulseData = new Float32Array(MAX_NODES * 4);
  private readonly pulseTexture = new THREE.DataTexture(this.pulseData, TEX, TEX, THREE.RGBAFormat, THREE.FloatType);
  private readonly visit = new Int32Array(MAX_NODES);
  private readonly dist = new Float32Array(MAX_NODES);
  private readonly queue = new Int32Array(MAX_NODES);
  private readonly scratch: number[] = [];
  private stamp = 0;

  private readonly aA = new Float32Array(MAX_SEGS * 3);
  private readonly aB = new Float32Array(MAX_SEGS * 3);
  private readonly aRad = new Float32Array(MAX_SEGS * 2);
  private readonly aNode = new Float32Array(MAX_SEGS * 2);
  private readonly aBirth = new Float32Array(MAX_SEGS);
  private readonly aFade = new Float32Array(MAX_SEGS);
  private readonly segments: THREE.Mesh;
  private readonly segmentGeometry = new THREE.InstancedBufferGeometry();
  private readonly segmentUniforms: Record<string, THREE.IUniform>;
  private segHigh = 0;
  private segmentsDirty = true;
  private pulseDirty = true;

  private readonly colonies: Colony[] = [];
  private readonly tips: Tip[] = [];
  private readonly nutrients: Nutrient[] = [];
  private readonly fruits: Fruit[] = [];
  private colonySeq = 0;
  private growth = 1;
  private pulseSpeed = 12;
  private ambientTimer = 1;
  private idleTimer = 4;
  private time = 0;
  private paletteKey = "";

  private readonly tipPoints: THREE.Points;
  private readonly tipPosition = new Float32Array(MAX_TIPS * 3);
  private readonly tipSize = new Float32Array(MAX_TIPS);
  private readonly tipUniforms: Record<string, THREE.IUniform> = { uScale: { value: 500 }, uColor: { value: new THREE.Color(0xbfffee) } };
  private readonly fruitBody: THREE.InstancedMesh;
  private readonly fruitCap: THREE.InstancedMesh;
  private readonly nutrientMesh: THREE.InstancedMesh;
  private readonly ground: THREE.Mesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly dummy = new THREE.Object3D();
  private readonly colour = new THREE.Color();
  private readonly vec = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();

  constructor() {
    for (let index = MAX_NODES - 1; index >= 0; index--) this.freeNodes.push(index);
    for (let index = MAX_SEGS - 1; index >= 0; index--) this.freeSegs.push(index);
    for (let index = 0; index < MAX_NODES; index++) this.pulseData[index * 4] = -1e4;
    this.pulseTexture.minFilter = this.pulseTexture.magFilter = THREE.NearestFilter;
    this.pulseTexture.generateMipmaps = false; this.pulseTexture.needsUpdate = true;

    this.sky.uniforms.uTop.value.set(0x010208); this.sky.uniforms.uHorizon.value.set(0x06141c);
    this.sky.uniforms.uGlow.value.set(0x0b3340); this.sky.uniforms.uStars.value = 0.5;
    this.spores.uniforms.uCenter.value.set(0, 3, -28); this.spores.uniforms.uDrift.value.set(0.012, 0.01, 0.006);
    this.spores.uniforms.uSway.value = 0.7;
    this.root.add(this.sky.mesh, this.hemisphere, this.pulseLight, this.spores.points, this.burst.points);

    // Soil: dark, lumpy, lit only by the colony's own signals.
    const terrain = new THREE.PlaneGeometry(220, 220, 110, 110);
    terrain.rotateX(-Math.PI / 2);
    const tp = terrain.attributes.position, soil = new Float32Array(tp.count * 3), tone = new THREE.Color();
    for (let index = 0; index < tp.count; index++) {
      const x = tp.getX(index), z = tp.getZ(index);
      tp.setY(index, GROUND + this.soilHeight(x, z));
      const patch = 0.5 + 0.5 * Math.sin(x * 0.4) * Math.cos(z * 0.33);
      tone.setHSL(0.5 + patch * 0.06, 0.4, 0.09 + patch * 0.07);
      soil.set([tone.r, tone.g, tone.b], index * 3);
    }
    terrain.setAttribute("color", new THREE.BufferAttribute(soil, 3));
    terrain.computeVertexNormals();
    this.ground = new THREE.Mesh(terrain, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
    this.root.add(this.ground);

    // Hyphae: instanced camera-facing ribbons so thin threads stay at least a pixel wide.
    const quad = new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]);
    this.segmentGeometry.setAttribute("position", new THREE.BufferAttribute(quad, 3));
    this.segmentGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    const dynamic = (array: Float32Array, size: number, name: string): void => {
      this.segmentGeometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage));
    };
    dynamic(this.aA, 3, "aA"); dynamic(this.aB, 3, "aB"); dynamic(this.aRad, 2, "aRad");
    dynamic(this.aNode, 2, "aNode"); dynamic(this.aBirth, 1, "aBirth"); dynamic(this.aFade, 1, "aFade");
    this.segmentGeometry.instanceCount = 0;
    this.segmentUniforms = {
      uTime: { value: 0 }, uScale: { value: 500 }, uTex: { value: TEX }, uDecay: { value: PULSE_DECAY }, uFog: { value: 0.01 },
      uGlow: { value: 1 }, uPulse: { value: this.pulseTexture }, uBase: { value: new THREE.Color(0x2fa890) },
      uC0: { value: new THREE.Color() }, uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() },
    };
    this.segments = new THREE.Mesh(this.segmentGeometry, new THREE.ShaderMaterial({
      uniforms: this.segmentUniforms, vertexShader: SEGMENT_VERTEX, fragmentShader: SEGMENT_FRAGMENT,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    }));
    this.segments.frustumCulled = false; this.segments.renderOrder = 2;
    this.root.add(this.segments);

    // Growing tips.
    const tipGeometry = new THREE.BufferGeometry();
    tipGeometry.setAttribute("position", new THREE.BufferAttribute(this.tipPosition, 3).setUsage(THREE.DynamicDrawUsage));
    tipGeometry.setAttribute("aSize", new THREE.BufferAttribute(this.tipSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.tipPoints = new THREE.Points(tipGeometry, new THREE.ShaderMaterial({
      uniforms: this.tipUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      vertexShader: `attribute float aSize; uniform float uScale;
        void main(){ vec4 mv=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*mv;
          gl_PointSize=aSize>0.?max(2.,aSize*uScale/max(.5,-mv.z)):0.; }`,
      fragmentShader: `uniform vec3 uColor; void main(){ vec2 d=gl_PointCoord-.5; float r=length(d)*2.; if(r>1.) discard;
        float a=pow(1.-r,2.2); gl_FragColor=vec4(uColor*a*1.6,a); }`,
    }));
    this.tipPoints.frustumCulled = false; this.tipPoints.renderOrder = 3;
    this.root.add(this.tipPoints);

    // Fruiting bodies: a dark lit mushroom plus an additive glowing cap.
    const profile: THREE.Vector2[] = [];
    for (let step = 0; step <= 5; step++) { const t = step / 5; profile.push(new THREE.Vector2(0.07 + 0.05 * (1 - t) * (1 - t), t * 0.9)); }
    const capProfile: THREE.Vector2[] = [];
    for (let step = 0; step <= 12; step++) {
      const a = step / 12 * Math.PI * 0.5;
      const point = new THREE.Vector2(Math.max(0.005, Math.sin(a) * 0.55), 0.82 + Math.cos(a) * 0.38);
      profile.push(point); capProfile.push(new THREE.Vector2(point.x * 1.06, point.y + 0.015));
    }
    this.fruitBody = new THREE.InstancedMesh(new THREE.LatheGeometry(profile, 18),
      new THREE.MeshStandardMaterial({ color: 0x1b1626, roughness: 0.6 }), MAX_FRUIT);
    const capGeometry = new THREE.LatheGeometry(capProfile, 18), capPosition = capGeometry.attributes.position;
    const capShade = new Float32Array(capPosition.count * 3);
    for (let index = 0; index < capPosition.count; index++) {
      const y = capPosition.getY(index), x = Math.hypot(capPosition.getX(index), capPosition.getZ(index));
      const shade = 0.15 + 0.85 * Math.pow(clamp01((y - 0.8) / 0.42), 1.4) + 0.35 * clamp01(x / 0.6) * clamp01(1 - (y - 0.8) / 0.3);
      capShade.fill(Math.min(1, shade), index * 3, index * 3 + 3);
    }
    capGeometry.setAttribute("color", new THREE.BufferAttribute(capShade, 3));
    this.fruitCap = new THREE.InstancedMesh(capGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }), MAX_FRUIT);
    for (const mesh of [this.fruitBody, this.fruitCap]) { mesh.count = 0; mesh.frustumCulled = false; this.root.add(mesh); }
    this.fruitCap.setColorAt(0, this.colour.setRGB(0, 0, 0));
    this.fruitCap.renderOrder = 4;

    // Buried nutrients that tips seek out.
    this.nutrientMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.45, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }), NUTRIENTS);
    this.nutrientMesh.frustumCulled = false; this.nutrientMesh.setColorAt(0, this.colour.setRGB(0, 0, 0));
    this.root.add(this.nutrientMesh);
    for (let index = 0; index < NUTRIENTS; index++) {
      this.nutrients.push({ x: 0, z: 0, available: true, respawn: 0, flash: 0, size: 0.6 + this.random() * 0.5 });
      this.placeNutrient(this.nutrients[index]);
    }

    // Start with established colonies so the forest floor is never empty.
    for (let index = 0; index < 3; index++) this.createColony(-20 + index * 20 + (this.random() - 0.5) * 8, -34 + (this.random() - 0.5) * 14, 0, 60);
    for (let step = 0; step < 420; step++) this.simulate(0.05, 0);
    this.flushAttributes();
  }

  private soilHeight(x: number, z: number): number {
    return Math.sin(x * 0.11 + 1.3) * 0.18 + Math.cos(z * 0.09) * 0.16 + Math.sin(x * 0.7) * Math.cos(z * 0.6) * 0.04;
  }

  private placeNutrient(nutrient: Nutrient): void {
    nutrient.x = (this.random() * 2 - 1) * (BOUND_X - 6); nutrient.z = Z_MIN + 6 + this.random() * (Z_MAX - Z_MIN - 14);
    nutrient.available = true; nutrient.flash = 0;
  }

  // --- graph storage -------------------------------------------------------

  private cellKey(ix: number, iy: number, iz: number): number { return (ix + 512) * 1048576 + (iy + 512) * 1024 + (iz + 512); }

  private addNode(x: number, y: number, z: number, colony: Colony): number {
    const id = this.freeNodes.pop();
    if (id === undefined) return -1;
    this.pos[id * 3] = x; this.pos[id * 3 + 1] = y; this.pos[id * 3 + 2] = z;
    this.nodeColony[id] = colony.id; colony.nodes.push(id);
    this.pulseData[id * 4 + 1] = 0; this.pulseData[id * 4] = -1e4;
    const key = this.cellKey(Math.floor(x / CELL), Math.floor(y / CELL), Math.floor(z / CELL));
    const cell = this.hash.get(key);
    if (cell) cell.push(id); else this.hash.set(key, [id]);
    return id;
  }

  private addSegment(a: number, b: number, r0: number, r1: number, colony: Colony, time: number): void {
    const s = this.freeSegs.pop();
    if (s === undefined) return;
    colony.segs.push(s);
    this.aA.set(this.pos.subarray(a * 3, a * 3 + 3), s * 3); this.aB.set(this.pos.subarray(b * 3, b * 3 + 3), s * 3);
    this.aRad[s * 2] = r0; this.aRad[s * 2 + 1] = r1; this.aNode[s * 2] = a; this.aNode[s * 2 + 1] = b;
    this.aBirth[s] = time; this.aFade[s] = 1;
    this.nodeAdj[a].push(b); this.nodeAdj[b].push(a);
    if (s >= this.segHigh) this.segHigh = s + 1;
    this.segmentsDirty = true;
  }

  /** Node ids within `radius` of a point, written into `scratch`. */
  private gather(x: number, y: number, z: number, radius: number): number[] {
    const out = this.scratch; out.length = 0;
    const span = Math.ceil(radius / CELL), cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL), r2 = radius * radius;
    for (let i = -span; i <= span; i++) for (let j = -span; j <= span; j++) for (let k = -span; k <= span; k++) {
      const cell = this.hash.get(this.cellKey(cx + i, cy + j, cz + k));
      if (!cell) continue;
      for (const id of cell) {
        const dx = this.pos[id * 3] - x, dy = this.pos[id * 3 + 1] - y, dz = this.pos[id * 3 + 2] - z;
        if (dx * dx + dy * dy + dz * dz <= r2) out.push(id);
      }
    }
    return out;
  }

  private nearestNode(x: number, z: number): { id: number; distance: number } {
    let best = -1, bestDistance = Infinity;
    for (let id = 0; id < MAX_NODES; id++) {
      if (this.nodeColony[id] < 0) continue;
      const dx = this.pos[id * 3] - x, dz = this.pos[id * 3 + 2] - z, d = dx * dx + dz * dz;
      if (d < bestDistance) { bestDistance = d; best = id; }
    }
    return { id: best, distance: Math.sqrt(bestDistance) };
  }

  private colonyOf(id: number): Colony | undefined { return this.colonies.find(colony => colony.id === this.nodeColony[id]); }

  // --- colonies and tips -----------------------------------------------------

  private createColony(x: number, z: number, time: number, energy: number): Colony | undefined {
    if (this.colonies.filter(colony => !colony.dying).length >= MAX_COLONIES) this.killOldest();
    const colony: Colony = { id: this.colonySeq++, segs: [], nodes: [], tips: 0, dying: false, fade: 1 };
    const root = this.addNode(x, 0, z, colony);
    if (root < 0) return undefined;
    this.colonies.push(colony);
    const count = 5 + Math.floor(this.random() * 3), offset = this.random() * Math.PI * 2;
    for (let index = 0; index < count; index++) {
      const angle = offset + index / count * Math.PI * 2 + (this.random() - 0.5) * 0.5;
      this.addTip(root, Math.cos(angle), (this.random() - 0.5) * 0.1, Math.sin(angle), colony, 0, energy * (3.4 + this.random() * 1.4), 2.2 + this.random() * 0.8, [root]);
    }
    return colony;
  }

  private addTip(node: number, dx: number, dy: number, dz: number, colony: Colony, gen: number, energy: number, speed: number, recent: number[]): void {
    if (this.tips.length >= MAX_TIPS) return;
    const length = Math.hypot(dx, dy, dz) || 1;
    this.tips.push({
      node, x: this.pos[node * 3], y: this.pos[node * 3 + 1], z: this.pos[node * 3 + 2], dx: dx / length, dy: dy / length, dz: dz / length,
      colony, gen, speed, energy, acc: 0, turn: (this.random() - 0.5) * 0.4, age: 0, seek: this.random() < 0.35, recent: recent.slice(-16),
    });
    colony.tips++;
  }

  private killOldest(): void {
    const victim = this.colonies.find(colony => !colony.dying);
    if (victim) this.killColony(victim);
  }

  private killColony(colony: Colony): void {
    colony.dying = true;
    for (let index = this.tips.length - 1; index >= 0; index--) if (this.tips[index].colony === colony) this.tips.splice(index, 1);
    colony.tips = 0;
    for (let index = this.fruits.length - 1; index >= 0; index--) if (this.nodeColony[this.fruits[index].node] === colony.id) this.fruits.splice(index, 1);
  }

  private releaseColony(colony: Colony): void {
    for (const s of colony.segs) { this.aFade[s] = 0; this.aRad[s * 2] = this.aRad[s * 2 + 1] = 0; this.freeSegs.push(s); }
    for (const id of colony.nodes) {
      const key = this.cellKey(Math.floor(this.pos[id * 3] / CELL), Math.floor(this.pos[id * 3 + 1] / CELL), Math.floor(this.pos[id * 3 + 2] / CELL));
      const cell = this.hash.get(key);
      if (cell) { const at = cell.indexOf(id); if (at >= 0) cell.splice(at, 1); }
      this.nodeColony[id] = -1; this.nodeAdj[id].length = 0; this.pulseData[id * 4 + 1] = 0; this.freeNodes.push(id);
    }
    this.segmentsDirty = true; this.pulseDirty = true;
    this.colonies.splice(this.colonies.indexOf(colony), 1);
  }

  private steer(tip: Tip, px: number, py: number, pz: number): void {
    const r = this.random;
    tip.turn = Math.max(-0.55, Math.min(0.55, tip.turn + (r() - 0.5) * 0.28));
    const cos = Math.cos(tip.turn * 0.4), sin = Math.sin(tip.turn * 0.4);
    let dx = tip.dx * cos + tip.dz * sin, dz = -tip.dx * sin + tip.dz * cos, dy = tip.dy + (r() - 0.5) * 0.08 - py * 0.12;
    // Chemotropism toward the nearest free nutrient.
    let bestD = 18 * 18, target: Nutrient | undefined;
    for (const nutrient of this.nutrients) {
      if (!nutrient.available) continue;
      const ex = nutrient.x - px, ez = nutrient.z - pz, d = ex * ex + ez * ez;
      if (d < bestD) { bestD = d; target = nutrient; }
    }
    if (target) {
      const ex = target.x - px, ez = target.z - pz, d = Math.sqrt(bestD) || 1, pull = 0.45 * (1.2 - d / 18);
      dx += ex / d * pull; dz += ez / d * pull;
    }
    // Self-avoidance, or deliberate approach when this tip is looking to fuse.
    const near = this.gather(px, py, pz, tip.seek ? 2.6 : 1.1);
    let sx = 0, sy = 0, sz = 0, found = 0;
    for (const id of near) {
      if (tip.recent.includes(id)) continue;
      const ox = this.pos[id * 3] - px, oy = this.pos[id * 3 + 1] - py, oz = this.pos[id * 3 + 2] - pz, d = Math.hypot(ox, oy, oz) || 1;
      if (tip.seek) {
        if (this.nodeColony[id] !== tip.colony.id || tip.age < 12 || ox * tip.dx + oz * tip.dz < 0) continue;
        sx += ox / d; sy += oy / d; sz += oz / d; found++;
      } else { const push = 0.5 / (d * d + 0.2); sx -= ox / d * push; sy -= oy / d * push; sz -= oz / d * push; }
    }
    if (found) { dx += sx / found * 0.55; dy += sy / found * 0.55; dz += sz / found * 0.55; }
    else { dx += sx; dy += sy; dz += sz; }
    // Keep the colony inside the stage.
    if (px > BOUND_X - 5) dx -= 0.7; else if (px < -BOUND_X + 5) dx += 0.7;
    if (pz < Z_MIN + 4) dz += 0.7; else if (pz > Z_MAX - 3) dz -= 0.7;
    const length = Math.hypot(dx, dy, dz) || 1;
    tip.dx = dx / length; tip.dy = dy / length; tip.dz = dz / length;
  }

  /** Lays one more segment for the tip. Returns false when the tip ends. */
  private extend(tip: Tip, time: number): boolean {
    const base = tip.node * 3;
    this.steer(tip, this.pos[base], this.pos[base + 1], this.pos[base + 2]);
    const nx = this.pos[base] + tip.dx * SEG, nz = this.pos[base + 2] + tip.dz * SEG;
    const ny = Math.max(Y_MIN, Math.min(Y_MAX, this.pos[base + 1] + tip.dy * SEG));
    const id = this.addNode(nx, ny, nz, tip.colony);
    if (id < 0 || this.freeSegs.length === 0) return false;
    const radius = Math.max(0.02, 0.075 * Math.pow(0.82, tip.gen));
    this.addSegment(tip.node, id, radius, radius * 0.88, tip.colony, time);
    tip.recent.push(id); if (tip.recent.length > 16) tip.recent.shift();
    tip.node = id; tip.x = nx; tip.y = ny; tip.z = nz; tip.energy -= 1; tip.age++;

    // Anastomosis: fuse with a nearby hypha of the same colony.
    if (tip.age > 10) {
      for (const other of this.gather(nx, ny, nz, 0.42)) {
        if (other === id || tip.recent.includes(other) || this.nodeColony[other] !== tip.colony.id) continue;
        if (this.random() < 0.6) { this.addSegment(id, other, radius * 0.8, radius * 0.8, tip.colony, time); return false; }
        break;
      }
    }
    for (const nutrient of this.nutrients) {
      if (nutrient.available && Math.hypot(nutrient.x - nx, nutrient.z - nz) < 1.5) { this.feed(nutrient, tip, id, time); break; }
    }
    if (tip.energy <= 0) return false;
    if (tip.colony.tips < 70 && this.tips.length < MAX_TIPS && tip.energy > 8 && this.random() < 0.12 * (tip.gen < 6 ? 1 : 0.5)) {
      const angle = (this.random() < 0.5 ? -1 : 1) * (0.55 + this.random() * 0.75), c = Math.cos(angle), s = Math.sin(angle);
      const share = tip.energy * 0.45; tip.energy -= share;
      this.addTip(id, tip.dx * c + tip.dz * s, tip.dy + (this.random() - 0.5) * 0.2, -tip.dx * s + tip.dz * c, tip.colony, tip.gen + 1, share, tip.speed * 0.88, tip.recent);
    }
    return true;
  }

  private feed(nutrient: Nutrient, tip: Tip, node: number, time: number): void {
    nutrient.available = false; nutrient.respawn = time + 22; nutrient.flash = 1;
    tip.energy += 70;
    for (let index = 0; index < 3; index++) {
      const angle = this.random() * Math.PI * 2;
      this.addTip(node, Math.cos(angle), 0, Math.sin(angle), tip.colony, 1 + index, 55, 2.2, [node]);
    }
    this.spawnFruit(node, 0, time);
    this.pulse(node, 1, this.pulseSpeed, 2, time, 34);
    this.flare(node, 0.9, 1);
  }

  private simulate(dt: number, time: number): void {
    for (let index = this.tips.length - 1; index >= 0; index--) {
      const tip = this.tips[index];
      if (tip.colony.dying) { this.tips.splice(index, 1); continue; }
      const step = tip.speed * dt * this.growth;
      tip.x += tip.dx * step; tip.y += tip.dy * step * 0.2; tip.z += tip.dz * step; tip.acc += step;
      let alive = true;
      while (alive && tip.acc >= SEG) { tip.acc -= SEG; alive = this.extend(tip, time); }
      if (!alive) { tip.colony.tips--; this.tips.splice(index, 1); }
    }
    for (let index = this.colonies.length - 1; index >= 0; index--) {
      const colony = this.colonies[index];
      if (!colony.dying) continue;
      colony.fade -= dt * 0.7;
      for (const s of colony.segs) this.aFade[s] = Math.max(0, colony.fade);
      this.segmentsDirty = true;
      if (colony.fade <= 0) this.releaseColony(colony);
    }
    if (this.freeSegs.length < 1200 || this.freeNodes.length < 1200) this.killOldest();
    for (const nutrient of this.nutrients) {
      nutrient.flash = Math.max(0, nutrient.flash - dt * 0.6);
      if (!nutrient.available && time >= nutrient.respawn && nutrient.flash <= 0) this.placeNutrient(nutrient);
    }
    // A quiet network still explores: a random node pushes out a new hypha now and then.
    this.idleTimer -= dt;
    if (this.idleTimer <= 0 && this.tips.length < 8) {
      this.idleTimer = 3 + this.random() * 3;
      const live = this.colonies.filter(colony => !colony.dying && colony.nodes.length > 0);
      if (live.length) {
        const colony = live[Math.floor(this.random() * live.length)], node = colony.nodes[Math.floor(this.random() * colony.nodes.length)];
        const angle = this.random() * Math.PI * 2;
        this.addTip(node, Math.cos(angle), 0, Math.sin(angle), colony, 2, 45, 2, [node]);
      }
    }
  }

  // --- signals ---------------------------------------------------------------

  /** Floods a signal along the hyphal graph; arrival time follows path length. */
  private pulse(source: number, strength: number, speed: number, lane: number, time: number, reach: number): void {
    if (source < 0 || this.nodeColony[source] < 0) return;
    const stamp = ++this.stamp; let head = 0, tail = 0;
    this.queue[tail++] = source; this.visit[source] = stamp; this.dist[source] = 0;
    while (head < tail) {
      const node = this.queue[head++], d = this.dist[node];
      const s = strength * Math.exp(-d / reach);
      if (s < 0.05) continue;
      const arrival = time + d / speed, at = node * 4;
      const previous = this.pulseData[at + 1] * Math.exp(-Math.max(0, time - this.pulseData[at]) * PULSE_DECAY);
      if (s >= previous * 0.8) { this.pulseData[at] = arrival; this.pulseData[at + 1] = s; this.pulseData[at + 2] = lane; }
      for (const next of this.nodeAdj[node]) {
        if (this.visit[next] === stamp) continue;
        this.visit[next] = stamp;
        this.dist[next] = d + Math.hypot(this.pos[next * 3] - this.pos[node * 3], this.pos[next * 3 + 1] - this.pos[node * 3 + 1], this.pos[next * 3 + 2] - this.pos[node * 3 + 2]);
        this.queue[tail++] = next;
      }
    }
    this.pulseDirty = true;
  }

  private glowAt(node: number, time: number): number {
    const at = node * 4, dt = time - this.pulseData[at], s = this.pulseData[at + 1];
    return s <= 0 || dt < 0 ? 0 : s * Math.exp(-dt * PULSE_DECAY) * Math.min(1, dt / 0.07);
  }

  private spawnFruit(node: number, lane: number, time: number): void {
    for (const fruit of this.fruits) if (Math.hypot(fruit.x - this.pos[node * 3], fruit.z - this.pos[node * 3 + 2]) < 2.4) return;
    if (this.fruits.length >= MAX_FRUIT) this.fruits.shift();
    const x = this.pos[node * 3], z = this.pos[node * 3 + 2];
    this.fruits.push({ node, x, y: GROUND + this.soilHeight(x, z), z, scale: 0.7 + this.random() * 0.8, rot: this.random() * 6.28, born: time, lane, prev: 0 });
  }

  private flare(node: number, intensity: number, lane: number): void {
    this.colour.copy(this.laneColours[lane]);
    this.pulseLight.color.copy(this.colour);
    this.pulseLight.position.set(this.pos[node * 3], 2.2, this.pos[node * 3 + 2]);
    this.pulseLight.intensity = 3 + intensity * 6;
    for (let index = 0; index < 10; index++) {
      this.vec.set(this.pos[node * 3] + (this.random() - 0.5), 0.2, this.pos[node * 3 + 2] + (this.random() - 0.5));
      this.vel.set((this.random() - 0.5) * 1.2, 0.5 + this.random() * 1.4, (this.random() - 0.5) * 1.2);
      this.burst.emit(this.vec, this.vel, 2.5 + this.random() * 3, 0.05 + this.random() * 0.08, this.laneColours[lane]);
    }
  }

  private readonly laneColours = [new THREE.Color(), new THREE.Color(), new THREE.Color()];

  spawn(note: number, velocity: number, lane: number, ctx: SceneContext): void {
    const time = ctx.time, r = this.random;
    const tx = pitchToUnit(note) * 30 + (r() - 0.5) * 4;
    const tz = lane === 0 ? -42 + r() * 14 : lane === 1 ? -34 + r() * 14 : -26 + r() * 14;
    const nearest = this.nearestNode(tx, tz);
    const amount = 0.55 + velocity / 127 * 0.45;
    if (lane === 0 && (nearest.id < 0 || nearest.distance > 11)) {
      const colony = this.createColony(tx, tz, time, 55 + velocity * 0.4);
      if (colony) { this.pulse(colony.nodes[0], 1, this.pulseSpeed, 0, time, 30); this.flare(colony.nodes[0], amount, 0); return; }
    }
    if (nearest.id < 0) return;
    const colony = this.colonyOf(nearest.id);
    if (lane === 0) {
      if (colony) for (let index = 0; index < 3; index++) {
        const angle = r() * Math.PI * 2;
        this.addTip(nearest.id, Math.cos(angle), 0, Math.sin(angle), colony, 1, 30 + velocity * 0.4, 2.6, [nearest.id]);
      }
      this.pulse(nearest.id, amount, this.pulseSpeed * 0.7, 0, time, 28);
    } else if (lane === 1) {
      if (colony) {
        const angle = r() * Math.PI * 2;
        this.addTip(nearest.id, Math.cos(angle), 0, Math.sin(angle), colony, 1, 40, 2.4, [nearest.id]);
      }
      this.pulse(nearest.id, amount, this.pulseSpeed, 1, time, 36);
    } else {
      this.pulse(nearest.id, 1, this.pulseSpeed * 1.7, 2, time, 44);
      this.spawnFruit(nearest.id, 2, time);
    }
    this.flare(nearest.id, amount, lane);
  }

  // --- frame -----------------------------------------------------------------

  private applyPalette(ctx: SceneContext): void {
    const key = `${ctx.variant}:${ctx.tint.getHexString()}`;
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    for (let lane = 0; lane < 3; lane++) laneColor(HUES, lane, ctx.variant, ctx.tint, 0.9, 0.58, this.laneColours[lane]);
    const u = this.segmentUniforms;
    u.uC0.value.copy(this.laneColours[0]); u.uC1.value.copy(this.laneColours[1]); u.uC2.value.copy(this.laneColours[2]);
    u.uBase.value.copy(this.laneColours[1]).multiplyScalar(0.55).lerp(new THREE.Color(0x3a9a8a), 0.35);
    this.spores.uniforms.uColor.value.copy(this.laneColours[2]); this.spores.uniforms.uColorB.value.copy(this.laneColours[1]);
  }

  private flushAttributes(): void {
    if (this.segmentsDirty) {
      for (const name of ["aA", "aB", "aRad", "aNode", "aBirth", "aFade"]) this.segmentGeometry.attributes[name].needsUpdate = true;
      this.segmentGeometry.instanceCount = this.segHigh; this.segmentsDirty = false;
    }
    if (this.pulseDirty) { this.pulseTexture.needsUpdate = true; this.pulseDirty = false; }
  }

  update(dt: number, ctx: SceneContext): void {
    this.time = ctx.time;
    this.applyPalette(ctx);
    const { controls } = ctx, open = controls.cutoff / 127, mod = controls.modulation / 127, breath = controls.breath / 127;
    this.growth = 1 + mod * 1.3 + ctx.energy * 0.6;
    this.pulseSpeed = 8 + open * 14;
    this.simulate(dt, ctx.time);

    this.ambientTimer -= dt * (1 + mod * 2);
    if (this.ambientTimer <= 0) {
      this.ambientTimer = 2.2 + this.random() * 3;
      const live = this.colonies.filter(colony => !colony.dying && colony.nodes.length > 0);
      if (live.length) {
        const colony = live[Math.floor(this.random() * live.length)];
        this.pulse(colony.nodes[Math.floor(this.random() * colony.nodes.length)], 0.5, 6 + open * 6, 1, ctx.time, 20);
      }
    }
    this.flushAttributes();

    const u = this.segmentUniforms;
    u.uTime.value = ctx.time; u.uScale.value = ctx.pixelScale; u.uGlow.value = 0.75 + breath * 1.1 + ctx.energy * 0.5 + ctx.flash * 0.5;
    this.sky.uniforms.uTime.value = ctx.time;
    this.tipUniforms.uScale.value = ctx.pixelScale;
    this.spores.uniforms.uTime.value = ctx.time; this.spores.uniforms.uScale.value = ctx.pixelScale;
    this.spores.uniforms.uGlow.value = 0.8 + breath * 1.4 + ctx.energy;
    this.spores.uniforms.uDrift.value.set(0.012 + ctx.wind * 0.03, 0.01, 0.006);
    this.burst.uniforms.uScale.value = ctx.pixelScale; this.burst.uniforms.uGlow.value = 1.2 + breath;
    this.burst.update(dt, ctx.time, 0.3, 0.985, 0.8 + mod * 2);
    this.pulseLight.intensity *= Math.pow(0.9, dt * 60);

    // Tips.
    this.tipSize.fill(0);
    this.tips.forEach((tip, index) => {
      this.tipPosition[index * 3] = tip.x; this.tipPosition[index * 3 + 1] = tip.y; this.tipPosition[index * 3 + 2] = tip.z;
      this.tipSize[index] = 0.16 / (1 + tip.gen * 0.18);
    });
    this.tipPoints.geometry.attributes.position.needsUpdate = true; this.tipPoints.geometry.attributes.aSize.needsUpdate = true;

    // Fruiting bodies glow when a signal reaches their node.
    this.fruitBody.count = this.fruitCap.count = this.fruits.length;
    this.fruits.forEach((fruit, index) => {
      const glow = this.glowAt(fruit.node, ctx.time), age = ctx.time - fruit.born;
      const size = fruit.scale * easeOutCubic(age / 2.6) * (1 + Math.sin(clamp01(age / 2) * Math.PI) * 0.08);
      this.dummy.position.set(fruit.x, fruit.y, fruit.z); this.dummy.rotation.set(0, fruit.rot, Math.sin(ctx.time * 0.6 + fruit.rot) * 0.015);
      this.dummy.scale.set(size, Math.max(0.001, size * 1.1), size); this.dummy.updateMatrix();
      this.fruitBody.setMatrixAt(index, this.dummy.matrix); this.fruitCap.setMatrixAt(index, this.dummy.matrix);
      const level = 0.1 + breath * 0.12 + glow * 1.3;
      this.fruitCap.setColorAt(index, this.colour.copy(this.laneColours[fruit.lane]).multiplyScalar(level));
      if (glow > 0.45 && fruit.prev <= 0.45 && age > 2.6) {
        for (let spore = 0; spore < 5; spore++) {
          this.vec.set(fruit.x + (this.random() - 0.5) * 0.4, fruit.y + 0.4 * size + 0.4, fruit.z + (this.random() - 0.5) * 0.4);
          this.vel.set((this.random() - 0.5) * 0.5, 0.5 + this.random() * 0.9, (this.random() - 0.5) * 0.5);
          this.burst.emit(this.vec, this.vel, 3 + this.random() * 3, 0.04 + this.random() * 0.05, this.laneColours[fruit.lane]);
        }
      }
      fruit.prev = glow;
    });
    this.fruitBody.instanceMatrix.needsUpdate = this.fruitCap.instanceMatrix.needsUpdate = true;
    if (this.fruitCap.instanceColor) this.fruitCap.instanceColor.needsUpdate = true;

    // Nutrients.
    this.nutrients.forEach((nutrient, index) => {
      const shown = nutrient.available ? 1 : nutrient.flash;
      const pulse = nutrient.available ? 0.5 + 0.5 * Math.sin(ctx.time * 1.4 + index * 2) : 0;
      this.dummy.position.set(nutrient.x, GROUND + this.soilHeight(nutrient.x, nutrient.z) + 0.05, nutrient.z);
      this.dummy.rotation.set(index, index * 2, 0);
      this.dummy.scale.setScalar(nutrient.size * (0.35 + shown * 0.65 + nutrient.flash * 0.6)); this.dummy.updateMatrix();
      this.nutrientMesh.setMatrixAt(index, this.dummy.matrix);
      this.nutrientMesh.setColorAt(index, this.colour.copy(this.laneColours[2]).multiplyScalar(nutrient.available ? 0.12 + pulse * 0.22 : nutrient.flash * 1.4));
    });
    this.nutrientMesh.instanceMatrix.needsUpdate = true;
    if (this.nutrientMesh.instanceColor) this.nutrientMesh.instanceColor.needsUpdate = true;
  }

  camera(ctx: SceneContext, camera: THREE.PerspectiveCamera, look: THREE.Vector3): void {
    const t = ctx.time, angle = t * 0.028 + 0.6, radius = 24 + Math.sin(t * 0.05) * 6;
    camera.position.set(Math.sin(angle) * radius * 0.85 + ctx.wind * 4, 6.5 + Math.sin(t * 0.07) * 2.6 + ctx.energy * 0.2, -27 + Math.cos(angle) * radius * 0.6);
    look.set(Math.sin(t * 0.04) * 5, -0.2, -27 + Math.cos(t * 0.03) * 4);
  }

  clear(): void {
    this.tips.length = 0;
    for (const colony of [...this.colonies]) { colony.fade = 0; this.releaseColony(colony); }
    this.fruits.length = 0; this.burst.clear();
    this.segHigh = 0; this.segmentGeometry.instanceCount = 0;
    this.createColony(-12 + this.random() * 24, -34 + (this.random() - 0.5) * 12, this.time, 60);
  }

  dispose(): void {
    this.burst.dispose();
    this.segmentGeometry.dispose(); (this.segments.material as THREE.Material).dispose();
    this.pulseTexture.dispose();
    disposeTree(this.root);
  }
}
