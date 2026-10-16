import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  BurstPool, type SceneContext, type VisualScene, clamp01, createBladeField, createParticleField, createSkyDome,
  disposeTree, easeOutCubic, laneColor, lerp, mulberry32, pitchToUnit, taperedTube,
} from "./visual-core";

type Lane0Kind = "mushroom" | "tree";
export interface FloraConfig {
  lane0: Lane0Kind;
  background: number; fogColor: number; fogDensity: number;
  skyTop: number; skyHorizon: number; skyGlow: number; glowDirection: [number, number, number];
  hues: [number, number, number]; groundHue: number; groundLightness: number;
  hemiSky: number; hemiGround: number; hemiIntensity: number;
  sunColor: number; sunIntensity: number; sunPosition: [number, number, number];
  glow: number; exposure: number; bloom: number; fireflies: number; stars: number;
}

interface Plant {
  group: THREE.Group; kind: string; lane: number; life: number; maxLife: number;
  grow: number; scale: number; phase: number; bloom?: THREE.Object3D; velocity: number;
}

const groundHeight = (x: number, z: number): number =>
  Math.sin(x * 0.08 + 1.3) * 1.3 + Math.cos(z * 0.07) * 1.1 + Math.sin((x + z) * 0.17) * 0.45 + Math.sin(x * 0.31) * Math.cos(z * 0.27) * 0.18;

/**
 * A semi-realistic nocturnal or dusk landscape grown by the music: lit terrain with
 * shadows, wind-driven blades, haze and procedurally modelled plants. Bass grows
 * giant mushrooms (forest) or trees (garden), pad grows fronds, lead grows flowers.
 */
export class FloraScene implements VisualScene {
  readonly root = new THREE.Group();
  readonly background: THREE.Color;
  readonly fog: THREE.FogExp2;
  readonly exposure: number;
  readonly bloom: number;
  private readonly config: FloraConfig;
  private readonly sky = createSkyDome(420);
  private readonly blades;
  private readonly fireflies;
  private readonly dust;
  private readonly burst = new BurstPool(1400);
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly pulseLight = new THREE.PointLight(0xffffff, 0, 26, 1.6);
  private readonly ground: THREE.Mesh;
  private readonly plants: Plant[] = [];
  private readonly shared = new Map<string, THREE.BufferGeometry[]>();
  private readonly materials: Record<string, THREE.MeshStandardMaterial | THREE.MeshBasicMaterial>;
  private readonly colour = new THREE.Color();
  private readonly scratch = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private paletteKey = "";
  private eventCount = 0;

  constructor(config: FloraConfig) {
    this.config = config;
    this.background = new THREE.Color(config.background);
    this.fog = new THREE.FogExp2(config.fogColor, config.fogDensity);
    this.exposure = config.exposure; this.bloom = config.bloom;

    // Sky and lights.
    this.sky.uniforms.uTop.value.set(config.skyTop);
    this.sky.uniforms.uHorizon.value.set(config.skyHorizon);
    this.sky.uniforms.uGlow.value.set(config.skyGlow);
    this.sky.uniforms.uGlowDir.value.set(...config.glowDirection).normalize();
    this.sky.uniforms.uStars.value = config.stars;
    this.root.add(this.sky.mesh);
    this.hemisphere = new THREE.HemisphereLight(config.hemiSky, config.hemiGround, config.hemiIntensity);
    this.sun = new THREE.DirectionalLight(config.sunColor, config.sunIntensity);
    this.sun.position.set(...config.sunPosition);
    this.sun.target.position.set(0, 0, -20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const shadow = this.sun.shadow.camera;
    shadow.left = -42; shadow.right = 42; shadow.top = 42; shadow.bottom = -42; shadow.near = 1; shadow.far = 120;
    this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.04;
    this.root.add(this.hemisphere, this.sun, this.sun.target, this.pulseLight);

    // Terrain with painted moss / soil variation.
    const terrain = new THREE.PlaneGeometry(240, 240, 150, 150);
    terrain.rotateX(-Math.PI / 2);
    const position = terrain.attributes.position, colours = new Float32Array(position.count * 3);
    const random = mulberry32(7), tone = new THREE.Color();
    for (let index = 0; index < position.count; index++) {
      const x = position.getX(index), z = position.getZ(index);
      const height = groundHeight(x, z) + (random() - 0.5) * 0.06;
      position.setY(index, height);
      const patch = 0.5 + 0.5 * Math.sin(x * 0.21) * Math.cos(z * 0.19);
      tone.setHSL(config.groundHue + patch * 0.06, 0.35 + patch * 0.2, config.groundLightness * (0.6 + patch * 0.8));
      colours.set([tone.r, tone.g, tone.b], index * 3);
    }
    terrain.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    terrain.computeVertexNormals();
    this.ground = new THREE.Mesh(terrain, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    this.ground.receiveShadow = true;
    this.root.add(this.ground);

    this.blades = createBladeField({
      count: 12000, radius: 70, minHeight: 0.35, maxHeight: 1.5, width: 0.09, heightAt: groundHeight,
      seed: 21, hole: 2, tipColor: new THREE.Color(0x40ffc0), glow: config.glow,
    });
    this.root.add(this.blades.mesh);

    this.fireflies = createParticleField(config.fireflies, new THREE.Vector3(70, 14, 60), 0.09, 5);
    this.fireflies.uniforms.uCenter.value.set(0, 6, -20);
    this.fireflies.uniforms.uDrift.value.set(0.012, 0.006, 0.008);
    this.fireflies.uniforms.uSway.value = 0.9;
    this.dust = createParticleField(900, new THREE.Vector3(80, 18, 70), 0.05, 9);
    this.dust.uniforms.uCenter.value.set(0, 7, -20);
    this.dust.uniforms.uDrift.value.set(0.01, 0.004, 0.006);
    this.dust.uniforms.uTwinkle.value = 0.3;
    this.root.add(this.fireflies.points, this.dust.points, this.burst.points);

    const lit = (hex: number, emissive: number, roughness: number, double = false) =>
      new THREE.MeshStandardMaterial({ color: hex, emissive, emissiveIntensity: 0, roughness, side: double ? THREE.DoubleSide : THREE.FrontSide });
    this.materials = {
      stem: lit(0xd9d4c4, 0x000000, 0.7), cap: lit(0xffffff, 0xffffff, 0.45, true), gill: new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
      bark: lit(0x3a2a20, 0x000000, 0.9), foliage: lit(0x2f6a3a, 0xffffff, 0.7, true),
      frond: lit(0x2f8a58, 0xffffff, 0.6, true), stalk: lit(0x3f7a48, 0x000000, 0.6),
      petal: lit(0xffffff, 0xffffff, 0.35, true),
    };
    this.buildGeometries();
  }

  /** Procedural meshes are built once per variant and reused by every plant. */
  private buildGeometries(): void {
    const mushrooms: THREE.BufferGeometry[] = [], trees: THREE.BufferGeometry[] = [], foliages: THREE.BufferGeometry[] = [];
    const fronds: THREE.BufferGeometry[] = [], stalks: THREE.BufferGeometry[] = [], petals: THREE.BufferGeometry[] = [];
    for (let variant = 0; variant < 4; variant++) {
      const random = mulberry32(100 + variant * 17);
      // Mushroom: lathe profile for stem + domed cap.
      const profile: THREE.Vector2[] = [];
      const stemHeight = 1.2 + random() * 0.8, capRadius = 1.1 + random() * 0.9;
      for (let step = 0; step <= 6; step++) {
        const t = step / 6;
        profile.push(new THREE.Vector2(0.14 + 0.07 * Math.pow(1 - t, 2) + Math.sin(t * Math.PI) * 0.03, t * stemHeight));
      }
      for (let step = 1; step <= 12; step++) {
        const a = step / 12 * Math.PI * 0.5;
        profile.push(new THREE.Vector2(Math.max(0.01, Math.sin(a) * capRadius), stemHeight + Math.cos(a) * capRadius * 0.55 - 0.1 + (1 - Math.cos(a)) * 0.1));
      }
      mushrooms.push(new THREE.LatheGeometry(profile, 28));
      // Tree: recursive tapered branches plus leaf clusters.
      const branches: THREE.BufferGeometry[] = [], leaves: THREE.BufferGeometry[] = [];
      const grow = (origin: THREE.Vector3, direction: THREE.Vector3, length: number, radius: number, depth: number): void => {
        const mid = origin.clone().addScaledVector(direction, length * 0.5).add(new THREE.Vector3((random() - 0.5) * length * 0.25, 0, (random() - 0.5) * length * 0.25));
        const end = origin.clone().addScaledVector(direction, length);
        branches.push(taperedTube([origin, mid, end], radius, radius * 0.62, 6, 6));
        if (depth === 0) {
          const leaf = new THREE.IcosahedronGeometry(0.55 + random() * 0.5, 1);
          leaf.scale(1, 0.75, 1); leaf.translate(end.x, end.y, end.z); leaves.push(leaf);
          return;
        }
        const count = depth > 2 ? 3 : 2;
        for (let child = 0; child < count; child++) {
          const swing = (child - (count - 1) / 2) * 0.9 + (random() - 0.5) * 0.5, twist = random() * Math.PI * 2;
          const next = direction.clone().applyAxisAngle(new THREE.Vector3(Math.cos(twist), 0, Math.sin(twist)), swing * 0.7)
            .add(new THREE.Vector3(0, 0.25, 0)).normalize();
          grow(end, next, length * (0.68 + random() * 0.1), radius * 0.62, depth - 1);
        }
      };
      grow(new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(0, 1, 0), 2.6, 0.32, 3);
      trees.push(mergeGeometries(branches)); foliages.push(mergeGeometries(leaves));
      // Frond: arched spine with a triangle leaflet fan.
      const frondParts: THREE.BufferGeometry[] = [];
      const blades = 4 + variant % 2;
      for (let blade = 0; blade < blades; blade++) {
        const positions: number[] = [];
        const length = 2.4 + random() * 1.2, curl = 0.7 + random() * 0.8, spread = 22;
        for (let leaflet = 1; leaflet < spread; leaflet++) {
          const t = leaflet / spread, next = t + 0.02;
          const spine = (u: number): THREE.Vector3 => new THREE.Vector3(u * u * curl * length * 0.5, u * length * (1 - u * 0.25), 0);
          const base = spine(t), forward = spine(next), reach = Math.pow(1 - t, 0.7) * 0.7 + 0.05;
          for (const side of [-1, 1]) {
            positions.push(base.x, base.y, base.z, base.x - side * 0.02, base.y - reach * 0.35, base.z + side * reach, forward.x, forward.y, forward.z);
          }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geometry.computeVertexNormals();
        geometry.rotateY(blade / blades * Math.PI * 2 + random() * 0.4);
        frondParts.push(geometry);
        frondParts.push(taperedTube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(curl * length * 0.12, length * 0.4, 0), new THREE.Vector3(curl * length * 0.37, length * 0.85, 0)], 0.035, 0.008, 4, 8)
          .rotateY(blade / blades * Math.PI * 2 + 0.0));
      }
      fronds.push(mergeGeometries(frondParts.map(part => part.index ? part.toNonIndexed() : part)));
      // Flower stalk with a swaying S-curve; petals are merged ellipsoids.
      const lean = (random() - 0.5) * 0.8;
      stalks.push(taperedTube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(lean * 0.4, 1.1, 0.1), new THREE.Vector3(-lean * 0.2, 2.2, -0.1), new THREE.Vector3(lean * 0.3, 3.3, 0)], 0.06, 0.025, 5, 14));
      const petalParts: THREE.BufferGeometry[] = [];
      const petalCount = 6 + variant * 2;
      for (let petal = 0; petal < petalCount; petal++) {
        const ring = petal < petalCount * 0.6 ? 1 : 0.55, a = petal / petalCount * Math.PI * 2 * (ring === 1 ? 1 : 1.3);
        const geometry = new THREE.SphereGeometry(1, 10, 6);
        geometry.scale(0.55 * ring, 0.07, 0.2 * ring);
        geometry.translate(0.5 * ring, 0, 0);
        geometry.rotateZ((ring === 1 ? 0.25 : 0.7) + random() * 0.15);
        geometry.rotateY(a);
        petalParts.push(geometry);
      }
      petals.push(mergeGeometries(petalParts));
    }
    this.shared.set("mushroom", mushrooms); this.shared.set("tree", trees); this.shared.set("foliage", foliages);
    this.shared.set("frond", fronds); this.shared.set("stalk", stalks); this.shared.set("petal", petals);
  }

  private makePlant(lane: number, variant: number): { group: THREE.Group; kind: string; bloom?: THREE.Object3D } {
    const group = new THREE.Group();
    const geometry = (name: string): THREE.BufferGeometry => this.shared.get(name)![variant % 4];
    const add = (name: string, material: THREE.Material): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry(name), material); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
    };
    if (lane === 0 && this.config.lane0 === "mushroom") {
      const profileCap = add("mushroom", this.materials.cap);
      profileCap.scale.setScalar(1);
      const gills = new THREE.Mesh(new THREE.CircleGeometry(1.0 + variant * 0.1, 28), this.materials.gill);
      gills.rotation.x = Math.PI / 2; gills.position.y = 1.2 + variant * 0.2;
      group.add(gills);
      return { group, kind: "mushroom" };
    }
    if (lane === 0) {
      add("tree", this.materials.bark); add("foliage", this.materials.foliage);
      return { group, kind: "tree" };
    }
    if (lane === 1) { add("frond", this.materials.frond); return { group, kind: "frond" }; }
    add("stalk", this.materials.stalk);
    const bloom = new THREE.Mesh(geometry("petal"), this.materials.petal);
    bloom.position.set(0.1 * (variant % 2 ? 1 : -1), 3.3, 0); bloom.rotation.x = 0.35; bloom.castShadow = true;
    group.add(bloom);
    return { group, kind: "stalk", bloom };
  }

  spawn(note: number, velocity: number, lane: number, ctx: SceneContext): void {
    this.eventCount++;
    const random = mulberry32(this.eventCount * 977 + note);
    const { group, kind, bloom } = this.makePlant(lane, this.eventCount + note);
    const x = pitchToUnit(note) * 24 + (random() - 0.5) * 4;
    const z = lane === 0 ? -22 - random() * 18 : lane === 1 ? -14 - random() * 16 : -9 - random() * 14;
    group.position.set(x, groundHeight(x, z) - 0.05, z);
    group.rotation.y = random() * Math.PI * 2;
    const unit = 0.55 + velocity / 127 * 0.9;
    const base = lane === 0 ? (kind === "tree" ? 2.2 : 1.35) : lane === 1 ? 1.3 : 1.15;
    group.scale.set(0.01, 0.01, 0.01);
    this.root.add(group);
    this.plants.push({ group, kind, lane, life: 0, maxLife: 14 + velocity / 14 + random() * 4, grow: 0,
      scale: base * unit, phase: random() * Math.PI * 2, bloom, velocity });
    if (this.plants.length > 34) this.plants[0].life = Math.max(this.plants[0].life, this.plants[0].maxLife - 2);

    const colour = laneColor(this.config.hues, lane, ctx.variant, ctx.tint, 0.85, 0.6, this.colour);
    this.pulseLight.color.copy(colour); this.pulseLight.position.set(x, groundHeight(x, z) + 2.5, z + 1.5);
    this.pulseLight.intensity = 3 + velocity / 20;
    const count = 8 + Math.round(velocity / 8);
    for (let index = 0; index < count; index++) {
      this.scratch.set(x + (random() - 0.5) * 1.5, groundHeight(x, z) + 0.4 + random() * 1.5, z + (random() - 0.5) * 1.5);
      this.velocity.set((random() - 0.5) * 1.4, 0.4 + random() * 1.8, (random() - 0.5) * 1.4);
      this.burst.emit(this.scratch, this.velocity, 3 + random() * 4, 0.05 + random() * 0.09, colour);
    }
  }

  private applyPalette(ctx: SceneContext): void {
    const key = `${ctx.variant}:${ctx.tint.getHexString()}`;
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    const h = this.config.hues, tint = ctx.tint, v = ctx.variant;
    const bass = laneColor(h, 0, v, tint, 0.7, 0.55), pad = laneColor(h, 1, v, tint, 0.75, 0.5), lead = laneColor(h, 2, v, tint, 0.9, 0.62);
    const cap = this.materials.cap as THREE.MeshStandardMaterial;
    cap.color.copy(bass).multiplyScalar(0.45); cap.emissive.copy(bass);
    (this.materials.gill as THREE.MeshBasicMaterial).color.copy(bass);
    (this.materials.foliage as THREE.MeshStandardMaterial).color.copy(pad).multiplyScalar(0.35);
    (this.materials.foliage as THREE.MeshStandardMaterial).emissive.copy(pad).multiplyScalar(0.25);
    const frond = this.materials.frond as THREE.MeshStandardMaterial;
    frond.color.copy(pad).multiplyScalar(0.45); frond.emissive.copy(pad);
    const petal = this.materials.petal as THREE.MeshStandardMaterial;
    petal.color.copy(lead).multiplyScalar(0.7); petal.emissive.copy(lead);
    (this.materials.stalk as THREE.MeshStandardMaterial).color.copy(pad).multiplyScalar(0.3);
    this.fireflies.uniforms.uColor.value.copy(lead); this.fireflies.uniforms.uColorB.value.copy(pad);
    this.dust.uniforms.uColor.value.copy(pad).lerp(new THREE.Color(1, 1, 1), 0.5);
    this.dust.uniforms.uColorB.value.copy(lead).lerp(new THREE.Color(1, 1, 1), 0.5);
    this.blades.uniforms.uTip.value.copy(pad);
    (this.sky.uniforms.uGlow.value as THREE.Color).set(this.config.skyGlow).lerp(pad, 0.22);
  }

  update(dt: number, ctx: SceneContext): void {
    this.applyPalette(ctx);
    const { controls } = ctx, open = controls.cutoff / 127, mod = controls.modulation / 127, breath = controls.breath / 127;
    const glow = this.config.glow * (0.5 + breath * 1.2 + ctx.energy * 0.8 + ctx.flash * 0.6);
    this.sky.uniforms.uTime.value = ctx.time;
    for (const uniforms of [this.fireflies.uniforms, this.dust.uniforms]) {
      uniforms.uTime.value = ctx.time; uniforms.uScale.value = ctx.pixelScale;
    }
    this.fireflies.uniforms.uGlow.value = 0.9 + breath * 1.6 + ctx.energy;
    this.dust.uniforms.uGlow.value = 0.4 + ctx.energy * 0.4;
    this.burst.uniforms.uScale.value = ctx.pixelScale; this.burst.uniforms.uGlow.value = 1.2 + breath;
    this.blades.uniforms.uTime.value = ctx.time; this.blades.uniforms.uWind.value = ctx.wind * 0.6;
    this.blades.uniforms.uMod.value = mod; this.blades.uniforms.uGlowAmount.value = this.config.glow * (0.4 + breath + ctx.energy);
    this.burst.update(dt, ctx.time, 0.35, 0.985, 0.9 + mod * 2);
    this.pulseLight.intensity *= Math.pow(0.9, dt * 60);
    this.fog.density = this.config.fogDensity * (1.1 - breath * 0.45);
    (this.materials.cap as THREE.MeshStandardMaterial).emissiveIntensity = glow * 0.55;
    (this.materials.gill as THREE.MeshBasicMaterial).opacity = clamp01(0.35 + glow * 0.4);
    (this.materials.foliage as THREE.MeshStandardMaterial).emissiveIntensity = glow * 0.3;
    (this.materials.frond as THREE.MeshStandardMaterial).emissiveIntensity = glow * 0.5;
    (this.materials.petal as THREE.MeshStandardMaterial).emissiveIntensity = glow * 1.1;

    for (let index = this.plants.length - 1; index >= 0; index--) {
      const plant = this.plants[index];
      plant.life += dt;
      const born = easeOutCubic(plant.life / (plant.lane === 0 ? 3.2 : 2.2));
      const dying = clamp01((plant.life - (plant.maxLife - 2.5)) / 2.5);
      const overshoot = 1 + Math.sin(clamp01(plant.life / 2.2) * Math.PI) * 0.06;
      const height = plant.scale * born * (1 - dying) * overshoot;
      const girth = plant.scale * lerp(0.3, 1, born) * (1 - dying * 0.6);
      plant.group.scale.set(girth, Math.max(0.001, height), girth);
      plant.group.rotation.z = (Math.sin(ctx.time * 0.8 + plant.phase) * 0.025 * (1 + mod * 3) + ctx.wind * 0.08) * (plant.kind === "mushroom" ? 0.3 : 1);
      plant.group.rotation.x = Math.cos(ctx.time * 0.6 + plant.phase) * 0.02 * (1 + mod * 2);
      if (plant.bloom) {
        const bud = clamp01((plant.life - 1.4) / 1.8);
        plant.bloom.scale.setScalar(lerp(0.15, 0.6 + open * 0.9, easeOutCubic(bud)));
        plant.bloom.rotation.y = ctx.time * 0.12 + plant.phase;
      }
      if (plant.life >= plant.maxLife) { this.root.remove(plant.group); this.plants.splice(index, 1); }
    }
  }

  camera(ctx: SceneContext, camera: THREE.PerspectiveCamera, look: THREE.Vector3): void {
    const t = ctx.time;
    camera.position.set(Math.sin(t * 0.045) * 7 + ctx.wind * 4, 2.3 + Math.sin(t * 0.07) * 0.7 + ctx.energy * 0.15, 11 - Math.sin(t * 0.03) * 4);
    look.set(Math.sin(t * 0.035 + 1) * 6 - ctx.wind * 3, 3.6 + Math.sin(t * 0.05) * 0.8, -22);
    camera.position.y = Math.max(camera.position.y, groundHeight(camera.position.x, camera.position.z) + 1.3);
  }

  clear(): void {
    this.plants.forEach(plant => this.root.remove(plant.group));
    this.plants.length = 0; this.burst.clear();
  }

  dispose(): void {
    this.clear();
    this.shared.forEach(list => list.forEach(geometry => geometry.dispose()));
    Object.values(this.materials).forEach(material => material.dispose());
    this.burst.dispose();
    disposeTree(this.root);
    this.sun.shadow.map?.dispose();
  }
}

export const forestConfig: FloraConfig = {
  lane0: "mushroom", background: 0x02060a, fogColor: 0x04121a, fogDensity: 0.028,
  skyTop: 0x01030a, skyHorizon: 0x07202a, skyGlow: 0x0b2c36, glowDirection: [-0.4, 0.18, -1],
  hues: [0.84, 0.47, 0.13], groundHue: 0.36, groundLightness: 0.16,
  hemiSky: 0x2a5a78, hemiGround: 0x0a1a12, hemiIntensity: 0.8,
  sunColor: 0x7ea8ff, sunIntensity: 0.9, sunPosition: [-22, 34, 8],
  glow: 1.0, exposure: 1.05, bloom: 0.9, fireflies: 650, stars: 0.9,
};

export const gardenConfig: FloraConfig = {
  lane0: "tree", background: 0x1a1522, fogColor: 0x8a6a66, fogDensity: 0.007,
  skyTop: 0x1d2a4a, skyHorizon: 0xe6a07a, skyGlow: 0x8a4a2a, glowDirection: [0.5, 0.12, -1],
  hues: [0.07, 0.3, 0.92], groundHue: 0.27, groundLightness: 0.2,
  hemiSky: 0xffc9a0, hemiGround: 0x2a3a22, hemiIntensity: 0.95,
  sunColor: 0xffb878, sunIntensity: 2.4, sunPosition: [32, 16, -30],
  glow: 0.35, exposure: 0.8, bloom: 0.4, fireflies: 260, stars: 0.15,
};
