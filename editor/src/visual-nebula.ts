import * as THREE from "three";
import {
  BurstPool, GLSL_NOISE, type SceneContext, type VisualScene, clamp01, createParticleField,
  disposeTree, laneColor, mulberry32, pitchToUnit,
} from "./visual-core";

const HUES = [0.02, 0.62, 0.8];
const TRAIL = 80;

interface Comet {
  line: THREE.Line; head: THREE.Vector3; velocity: THREE.Vector3; trail: Float32Array;
  life: number; maxLife: number; lane: number; seed: number; colour: THREE.Color; material: THREE.LineBasicMaterial;
}
interface Puff { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform>; age: number; life: number; size: number }

const gasVertex = "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }";

/**
 * Volumetric-looking nebula: domain-warped fractal gas, a deep star shell,
 * flowing ion filaments and expanding shock puffs. The camera drifts through
 * the cloud so layers parallax against each other.
 */
export class NebulaScene implements VisualScene {
  readonly root = new THREE.Group();
  readonly background = new THREE.Color(0x010103);
  readonly fog = null;
  readonly exposure = 1.0;
  readonly bloom = 0.8;
  private readonly layers: { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform>; drift: number }[] = [];
  private readonly stars: ReturnType<typeof createParticleField>;
  private readonly dust: ReturnType<typeof createParticleField>;
  private readonly burst = new BurstPool(1800);
  private readonly comets: Comet[] = [];
  private readonly puffs: Puff[] = [];
  private readonly puffGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly colour = new THREE.Color();
  private readonly scratch = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private paletteKey = "";
  private eventCount = 0;

  constructor() {
    const random = mulberry32(88);
    const gasFragment = `${GLSL_NOISE}
      uniform float uTime,uEnergy,uCut,uSeed,uDensity; uniform vec3 uColA,uColB,uColC; varying vec2 vUv;
      void main(){
        vec2 p=(vUv-.5)*2.; float r=length(p); float edge=smoothstep(1.,.15,r);
        vec3 q=vec3(p*1.7,uSeed+uTime*.02);
        vec3 w=vec3(fbm(q+vec3(0.,0.,uTime*.03)),fbm(q+vec3(5.2,1.3,uTime*.02)),0.);
        float d=fbm(q*1.2+w*2.2);
        float d2=fbm(q*2.6-w*1.6+7.);
        float cloud=smoothstep(.32,.85,d*.9+d2*.35)*edge;
        float filament=pow(smoothstep(.45,.5,abs(d2-.5)+.35),4.)*edge*.0;
        vec3 c=mix(uColA,uColB,smoothstep(.3,.8,d));
        c=mix(c,uColC,smoothstep(.55,.95,d2)*(.4+uCut*.6));
        float a=cloud*uDensity*(.6+uEnergy*.7);
        gl_FragColor=vec4(c*a,a);
      }`;
    for (let index = 0; index < 7; index++) {
      const uniforms: Record<string, THREE.IUniform> = {
        uTime: { value: 0 }, uEnergy: { value: 0 }, uCut: { value: 0.5 }, uSeed: { value: random() * 40 }, uDensity: { value: 0.5 },
        uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() }, uColC: { value: new THREE.Color() },
      };
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
        uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
        vertexShader: gasVertex, fragmentShader: gasFragment,
      }));
      const scale = 120 + random() * 120;
      mesh.scale.setScalar(scale);
      mesh.position.set((random() - 0.5) * 120, (random() - 0.5) * 60, -40 - index * 28 - random() * 20);
      mesh.rotation.z = random() * Math.PI * 2;
      this.root.add(mesh); this.layers.push({ mesh, uniforms, drift: (random() - 0.5) * 0.01 });
    }
    this.stars = createParticleField(6000, new THREE.Vector3(360, 220, 360), 0.16, 12);
    this.stars.uniforms.uCenter.value.set(0, 0, -60); this.stars.uniforms.uDrift.value.set(0, 0, 0.0008);
    this.stars.uniforms.uSway.value = 0; this.stars.uniforms.uColor.value.set(0xcfe0ff); this.stars.uniforms.uColorB.value.set(0xffd9b0);
    this.dust = createParticleField(900, new THREE.Vector3(80, 50, 90), 0.1, 14);
    this.dust.uniforms.uCenter.value.set(0, 0, -30); this.dust.uniforms.uDrift.value.set(0.004, 0.002, 0.012);
    this.dust.uniforms.uTwinkle.value = 0.4;
    this.root.add(this.stars.points, this.dust.points, this.burst.points);
  }

  /** Cheap divergence-free-looking flow used to steer comets. */
  private flow(position: THREE.Vector3, time: number, out: THREE.Vector3): THREE.Vector3 {
    const s = 0.11;
    return out.set(
      Math.sin(position.y * s + time * 0.3) + Math.cos(position.z * s * 1.3 - time * 0.2),
      Math.sin(position.z * s - time * 0.25) + Math.cos(position.x * s * 1.1 + time * 0.35),
      Math.sin(position.x * s + time * 0.2) + Math.cos(position.y * s * 0.9 - time * 0.3));
  }

  spawn(note: number, velocity: number, lane: number, ctx: SceneContext): void {
    this.eventCount++;
    const random = mulberry32(this.eventCount * 6151 + note);
    const colour = laneColor(HUES, lane, ctx.variant, ctx.tint, 0.9, 0.6, this.colour).clone();
    const origin = new THREE.Vector3(pitchToUnit(note) * 30 + (random() - 0.5) * 8, (random() - 0.5) * 22 + (lane - 1) * 5, -14 - random() * 40);
    // Shock puff.
    const uniforms: Record<string, THREE.IUniform> = {
      uAge: { value: 0 }, uColor: { value: colour.clone() }, uSeed: { value: random() * 30 },
    };
    const puff = new THREE.Mesh(this.puffGeometry, new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      vertexShader: gasVertex,
      fragmentShader: `${GLSL_NOISE}
        uniform float uAge,uSeed; uniform vec3 uColor; varying vec2 vUv;
        void main(){
          vec2 p=(vUv-.5)*2.; float r=length(p);
          float ring=smoothstep(.12,0.,abs(r-uAge*.85)) * (1.-uAge);
          float body=smoothstep(1.,0.,r/(.25+uAge*.75))*(1.-uAge)*fbm(vec3(p*3.,uSeed+uAge*1.5));
          float a=(ring*.9+body*.9);
          gl_FragColor=vec4(uColor*a,a);
        }`,
    }));
    const size = 10 + velocity / 127 * 26 + lane * 3;
    puff.position.copy(origin); puff.scale.setScalar(size);
    this.root.add(puff); this.puffs.push({ mesh: puff, uniforms, age: 0, life: 3.5 + random() * 2, size });
    // Ion comet: a luminous head dragging a fading trail through the flow field.
    const trail = new Float32Array(TRAIL * 3);
    for (let index = 0; index < TRAIL; index++) trail.set([origin.x, origin.y, origin.z], index * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(trail, 3).setUsage(THREE.DynamicDrawUsage));
    const shades = new Float32Array(TRAIL * 3);
    for (let index = 0; index < TRAIL; index++) {
      const fade = Math.pow(1 - index / (TRAIL - 1), 1.6);
      shades.set([colour.r * fade, colour.g * fade, colour.b * fade], index * 3);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(shades, 3));
    const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 1 });
    const line = new THREE.Line(geometry, material); line.frustumCulled = false;
    this.root.add(line);
    const speed = 5 + velocity / 127 * 10;
    this.comets.push({
      line, head: origin.clone(), velocity: new THREE.Vector3((random() - 0.5), (random() - 0.5), -0.3 - random()).normalize().multiplyScalar(speed),
      trail, life: 0, maxLife: 6 + random() * 5, lane, seed: random() * 100, colour, material,
    });
    const count = 18 + Math.round(velocity / 4);
    for (let index = 0; index < count; index++) {
      this.scratch.copy(origin);
      this.velocity.set(random() - 0.5, random() - 0.5, random() - 0.5).normalize().multiplyScalar(2 + random() * (4 + velocity / 20));
      this.burst.emit(this.scratch, this.velocity, 2 + random() * 3, 0.1 + random() * 0.15, colour);
    }
    while (this.comets.length > 28) this.removeComet(0);
    while (this.puffs.length > 24) this.removePuff(0);
  }

  private removeComet(index: number): void {
    const [comet] = this.comets.splice(index, 1);
    this.root.remove(comet.line); comet.line.geometry.dispose(); comet.material.dispose();
  }

  private removePuff(index: number): void {
    const [puff] = this.puffs.splice(index, 1);
    this.root.remove(puff.mesh); (puff.mesh.material as THREE.Material).dispose();
  }

  update(dt: number, ctx: SceneContext): void {
    const { controls } = ctx, open = controls.cutoff / 127, mod = controls.modulation / 127, breath = controls.breath / 127;
    const key = `${ctx.variant}:${ctx.tint.getHexString()}`;
    if (key !== this.paletteKey) {
      this.paletteKey = key;
      this.layers.forEach((layer, index) => {
        layer.uniforms.uColA.value.copy(laneColor(HUES, index, ctx.variant, ctx.tint, 0.85, 0.2));
        layer.uniforms.uColB.value.copy(laneColor(HUES, index + 1, ctx.variant, ctx.tint, 0.8, 0.32));
        layer.uniforms.uColC.value.copy(laneColor(HUES, index + 2, ctx.variant, ctx.tint, 0.7, 0.55));
      });
    }
    this.layers.forEach((layer, index) => {
      layer.uniforms.uTime.value = ctx.time * (0.6 + mod * 1.8);
      layer.uniforms.uEnergy.value = ctx.energy + ctx.flash * 0.5;
      layer.uniforms.uCut.value = open;
      layer.uniforms.uDensity.value = 0.24 + breath * 0.3;
      layer.mesh.quaternion.copy(ctx.cameraQuaternion);
      layer.mesh.rotateZ(ctx.time * layer.drift + index);
    });
    this.stars.uniforms.uTime.value = ctx.time; this.stars.uniforms.uScale.value = ctx.pixelScale;
    this.stars.uniforms.uGlow.value = 0.9 + ctx.energy * 0.8;
    this.dust.uniforms.uTime.value = ctx.time; this.dust.uniforms.uScale.value = ctx.pixelScale;
    this.dust.uniforms.uColor.value.copy(laneColor(HUES, 1, ctx.variant, ctx.tint, 0.5, 0.7));
    this.dust.uniforms.uColorB.value.copy(laneColor(HUES, 2, ctx.variant, ctx.tint, 0.5, 0.7));
    this.dust.uniforms.uGlow.value = 0.6 + breath;
    this.burst.uniforms.uScale.value = ctx.pixelScale; this.burst.uniforms.uGlow.value = 1.3 + breath;
    this.burst.update(dt, ctx.time, 0, 0.985, 1.5 + mod * 3);

    for (let index = this.puffs.length - 1; index >= 0; index--) {
      const puff = this.puffs[index];
      puff.age += dt; puff.uniforms.uAge.value = clamp01(puff.age / puff.life);
      puff.mesh.quaternion.copy(ctx.cameraQuaternion);
      if (puff.age >= puff.life) this.removePuff(index);
    }
    const flow = new THREE.Vector3();
    for (let index = this.comets.length - 1; index >= 0; index--) {
      const comet = this.comets[index];
      comet.life += dt;
      this.flow(comet.head, ctx.time + comet.seed, flow);
      comet.velocity.addScaledVector(flow, dt * (3 + mod * 8)).clampLength(2, 16 + resonanceBoost(controls.resonance));
      comet.velocity.x += ctx.wind * dt * 6;
      comet.head.addScaledVector(comet.velocity, dt);
      comet.trail.copyWithin(3, 0, (TRAIL - 1) * 3);
      comet.trail.set([comet.head.x, comet.head.y, comet.head.z], 0);
      comet.line.geometry.attributes.position.needsUpdate = true;
      comet.material.opacity = clamp01(Math.min(comet.life * 3, (comet.maxLife - comet.life) / 1.5));
      if (comet.life >= comet.maxLife) this.removeComet(index);
    }
  }

  camera(ctx: SceneContext, camera: THREE.PerspectiveCamera, look: THREE.Vector3): void {
    const t = ctx.time;
    camera.position.set(Math.sin(t * 0.05) * 14 + ctx.wind * 8, Math.cos(t * 0.04) * 6, 30 + Math.sin(t * 0.021) * 14);
    look.set(Math.sin(t * 0.03 + 1.2) * 12, Math.cos(t * 0.025) * 5, -50);
  }

  clear(): void {
    while (this.comets.length) this.removeComet(0);
    while (this.puffs.length) this.removePuff(0);
    this.burst.clear();
  }

  dispose(): void {
    this.clear();
    this.layers.forEach(layer => { layer.mesh.geometry.dispose(); (layer.mesh.material as THREE.Material).dispose(); });
    this.puffGeometry.dispose(); this.burst.dispose();
    disposeTree(this.root);
  }
}

const resonanceBoost = (resonance: number): number => resonance / 127 * 14;
