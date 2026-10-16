import * as THREE from "three";
import {
  BurstPool, GLSL_NOISE, type SceneContext, type VisualScene, clamp01, createBladeField, createParticleField, createSkyDome,
  disposeTree, easeOutCubic, laneColor, lerp, mulberry32, pitchToUnit,
} from "./visual-core";

interface Jelly {
  group: THREE.Group; bell: THREE.Mesh; core: THREE.Mesh; tentacles: THREE.Line[];
  size: number; life: number; maxLife: number; phase: number; speed: number;
  drift: THREE.Vector3; origin: THREE.Vector3; lane: number; rate: number;
  bellMaterial: THREE.MeshPhysicalMaterial; coreMaterial: THREE.MeshBasicMaterial;
  tentacleMaterial: THREE.LineBasicMaterial;
}

const HUES = [0.72, 0.52, 0.9];
const TENTACLES = 12, TENTACLE_POINTS = 18;
const floorHeight = (x: number, z: number): number =>
  -12 + Math.sin(x * 0.07) * 1.6 + Math.cos(z * 0.06 + 1) * 1.4 + Math.sin((x - z) * 0.2) * 0.35;

/**
 * Deep-water scene: caustics on a sand floor, slanting light shafts, drifting
 * marine snow, kelp and bioluminescent jellyfish. Bass releases large slow
 * medusae, pad medium ones, lead small quick schools.
 */
export class OceanScene implements VisualScene {
  readonly root = new THREE.Group();
  readonly background = new THREE.Color(0x01070f);
  readonly fog = new THREE.FogExp2(0x03212e, 0.032);
  readonly exposure = 1.1;
  readonly bloom = 1.0;
  private readonly water = createSkyDome(420);
  private readonly floor: THREE.Mesh;
  private readonly floorUniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 }, uCaustic: { value: new THREE.Color(0x7fe8ff) }, uLight: { value: 1 },
  };
  private readonly rays: THREE.Mesh[] = [];
  private readonly rayUniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 }, uColor: { value: new THREE.Color(0x66ccee) }, uIntensity: { value: 0.4 },
  };
  private readonly snow = createParticleField(3200, new THREE.Vector3(90, 40, 80), 0.07, 3);
  private readonly kelp;
  private readonly burst = new BurstPool(1200);
  private readonly hemisphere = new THREE.HemisphereLight(0x3aa0c8, 0x061a24, 0.8);
  private readonly sun = new THREE.DirectionalLight(0x9fe4ff, 1.4);
  private readonly pulseLight = new THREE.PointLight(0xffffff, 0, 30, 1.5);
  private readonly jellies: Jelly[] = [];
  private readonly bellGeometry = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.55);
  private readonly coreGeometry = new THREE.SphereGeometry(0.55, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
  private readonly colour = new THREE.Color();
  private readonly scratch = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private paletteKey = "";
  private eventCount = 0;

  constructor() {
    // The water column: bright teal overhead fading to deep blue-black, no stars.
    this.water.uniforms.uTop.value.set(0x0a6a88); this.water.uniforms.uHorizon.value.set(0x03212e);
    this.water.uniforms.uGlow.value.set(0x4fc8e8); this.water.uniforms.uGlowDir.value.set(-0.2, 1, -0.3).normalize();
    this.water.uniforms.uStars.value = 0; this.water.uniforms.uGlowSize.value = 0.5;
    this.root.add(this.water.mesh);
    this.sun.position.set(-10, 40, 10); this.sun.target.position.set(0, -10, -20);
    this.root.add(this.hemisphere, this.sun, this.sun.target, this.pulseLight);

    // Sand floor with a caustic network projected by the surface above.
    const geometry = new THREE.PlaneGeometry(260, 260, 140, 140);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.attributes.position, colours = new Float32Array(position.count * 3), tone = new THREE.Color();
    for (let index = 0; index < position.count; index++) {
      const x = position.getX(index), z = position.getZ(index);
      position.setY(index, floorHeight(x, z));
      tone.setHSL(0.1 + Math.sin(x * 0.1) * 0.02, 0.25, 0.1 + 0.05 * Math.sin(z * 0.2 + x * 0.1));
      colours.set([tone.r, tone.g, tone.b], index * 3);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.floorUniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWP;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWP=(modelMatrix*vec4(transformed,1.)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying vec3 vWP; uniform float uTime,uLight; uniform vec3 uCaustic;
          float caustic(vec2 uv,float t){
            vec2 p=mod(uv*6.28318,6.28318)-250.; vec2 i=p; float c=1.; float inten=.005;
            for(int n=0;n<4;n++){ float tt=t*(1.-(3.5/float(n+1)));
              i=p+vec2(cos(tt-i.x)+sin(tt+i.y), sin(tt-i.y)+cos(tt+i.x));
              c+=1./length(vec2(p.x/(sin(i.x+tt)/inten), p.y/(cos(i.y+tt)/inten))); }
            c/=4.; c=1.17-pow(c,1.4); return pow(abs(c),8.); }`)
        .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
          totalEmissiveRadiance+=uCaustic*caustic(vWP.xz*.045,uTime*.5)*uLight*.5;`);
    };
    this.floor = new THREE.Mesh(geometry, material);
    this.root.add(this.floor);

    // Slanted god rays: tall additive strips with drifting noise.
    const rayMaterial = new THREE.ShaderMaterial({
      uniforms: this.rayUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      vertexShader: "varying vec2 vUv; varying vec3 vP; void main(){ vUv=uv; vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }",
      fragmentShader: `${GLSL_NOISE}
        uniform float uTime,uIntensity; uniform vec3 uColor; varying vec2 vUv; varying vec3 vP;
        void main(){
          float across=smoothstep(0.,.5,vUv.x)*smoothstep(1.,.5,vUv.x);
          float n=fbm(vec3(vUv.x*5.,vUv.y*1.5-uTime*.12,uTime*.05));
          float down=smoothstep(0.,.9,vUv.y);
          float a=across*across*n*down*uIntensity;
          gl_FragColor=vec4(uColor*a,a);
        }`,
    });
    const random = mulberry32(31);
    for (let index = 0; index < 9; index++) {
      const ray = new THREE.Mesh(new THREE.PlaneGeometry(5 + random() * 7, 70), rayMaterial);
      ray.position.set((index - 4) * 11 + random() * 4, 14, -22 - random() * 30);
      ray.rotation.set(0, random() * 0.6 - 0.3, 0.32 + random() * 0.12);
      this.root.add(ray); this.rays.push(ray);
    }

    this.kelp = createBladeField({
      count: 1500, radius: 55, minHeight: 4, maxHeight: 11, width: 0.3, heightAt: floorHeight, seed: 43, segments: 8,
      tipColor: new THREE.Color(0x40ffd0), glow: 0.5,
    });
    this.snow.uniforms.uCenter.value.set(0, -2, -20);
    this.snow.uniforms.uDrift.value.set(0.004, -0.012, 0.003);
    this.snow.uniforms.uSway.value = 0.5; this.snow.uniforms.uTwinkle.value = 0;
    this.snow.uniforms.uColor.value.set(0xbfeaff); this.snow.uniforms.uColorB.value.set(0x8fd0e0);
    this.root.add(this.kelp.mesh, this.snow.points, this.burst.points);
  }

  private buildJelly(lane: number, velocity: number, ctx: SceneContext, random: () => number): Jelly {
    const colour = laneColor(HUES, lane, ctx.variant, ctx.tint, 0.85, 0.55, this.colour);
    const size = (lane === 0 ? 2.6 : lane === 1 ? 1.5 : 0.7) * (0.7 + velocity / 127 * 0.7);
    const bellMaterial = new THREE.MeshPhysicalMaterial({
      color: colour.clone().multiplyScalar(0.4), emissive: colour.clone(), emissiveIntensity: 0.5, roughness: 0.15,
      transmission: 0, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, clearcoat: 1, clearcoatRoughness: 0.2,
    });
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: colour.clone().lerp(new THREE.Color(1, 1, 1), 0.4), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const tentacleMaterial = new THREE.LineBasicMaterial({
      color: colour.clone().lerp(new THREE.Color(1, 1, 1), 0.2), transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const group = new THREE.Group();
    const bell = new THREE.Mesh(this.bellGeometry, bellMaterial);
    const core = new THREE.Mesh(this.coreGeometry, coreMaterial);
    core.position.y = 0.05; bell.add(core);
    group.add(bell);
    const tentacles: THREE.Line[] = [];
    for (let index = 0; index < TENTACLES; index++) {
      const line = new THREE.Line(new THREE.BufferGeometry().setAttribute(
        "position", new THREE.BufferAttribute(new Float32Array(TENTACLE_POINTS * 3), 3)), tentacleMaterial);
      line.frustumCulled = false; group.add(line); tentacles.push(line);
    }
    group.scale.setScalar(0.01);
    return {
      group, bell, core, tentacles, size, life: 0, maxLife: 20 + random() * 10, phase: random() * Math.PI * 2,
      speed: lane === 0 ? 0.35 : lane === 1 ? 0.6 : 1.0, drift: new THREE.Vector3((random() - 0.5) * 0.4, 0, (random() - 0.5) * 0.4),
      origin: new THREE.Vector3(), lane, rate: 0.8 + velocity / 127 * 0.9, bellMaterial, coreMaterial, tentacleMaterial,
    };
  }

  spawn(note: number, velocity: number, lane: number, ctx: SceneContext): void {
    this.eventCount++;
    const random = mulberry32(this.eventCount * 733 + note);
    const count = lane === 2 && velocity > 60 ? 3 : 1;
    for (let index = 0; index < count; index++) {
      const jelly = this.buildJelly(lane, velocity, ctx, random);
      const x = pitchToUnit(note) * 22 + (random() - 0.5) * 6;
      const z = -7 - random() * 28 - lane * 2;
      jelly.origin.set(x, floorHeight(x, z) + 1.5 + random() * 3, z);
      jelly.group.position.copy(jelly.origin);
      this.root.add(jelly.group); this.jellies.push(jelly);
      this.pulseLight.color.copy(jelly.bellMaterial.emissive);
      this.pulseLight.position.copy(jelly.origin).add(new THREE.Vector3(0, 2, 2));
      this.pulseLight.intensity = 4 + velocity / 16;
      for (let bubble = 0; bubble < 8; bubble++) {
        this.scratch.copy(jelly.origin).add(new THREE.Vector3((random() - 0.5) * 2, random() * 1.5, (random() - 0.5) * 2));
        this.velocity.set((random() - 0.5) * 0.5, 0.8 + random() * 1.5, (random() - 0.5) * 0.5);
        this.burst.emit(this.scratch, this.velocity, 4 + random() * 4, 0.06 + random() * 0.09, jelly.coreMaterial.color);
      }
    }
    while (this.jellies.length > 26) this.removeJelly(0);
  }

  private removeJelly(index: number): void {
    const [jelly] = this.jellies.splice(index, 1);
    this.root.remove(jelly.group);
    jelly.tentacles.forEach(line => line.geometry.dispose());
    jelly.bellMaterial.dispose(); jelly.coreMaterial.dispose(); jelly.tentacleMaterial.dispose();
  }

  update(dt: number, ctx: SceneContext): void {
    const { controls } = ctx, open = controls.cutoff / 127, mod = controls.modulation / 127, breath = controls.breath / 127;
    this.water.uniforms.uTime.value = ctx.time;
    const key = `${ctx.variant}:${ctx.tint.getHexString()}`;
    if (key !== this.paletteKey) {
      this.paletteKey = key;
      this.rayUniforms.uColor.value.copy(laneColor(HUES, 1, ctx.variant, ctx.tint, 0.6, 0.55));
      this.floorUniforms.uCaustic.value.copy(laneColor(HUES, 1, ctx.variant, ctx.tint, 0.7, 0.65));
      this.kelp.uniforms.uTip.value.copy(laneColor(HUES, 0, ctx.variant, ctx.tint, 0.8, 0.6));
    }
    this.floorUniforms.uTime.value = ctx.time; this.floorUniforms.uLight.value = 0.7 + open * 1.2 + ctx.flash;
    this.rayUniforms.uTime.value = ctx.time; this.rayUniforms.uIntensity.value = 0.25 + open * 0.45 + ctx.energy * 0.25;
    this.snow.uniforms.uTime.value = ctx.time; this.snow.uniforms.uScale.value = ctx.pixelScale;
    this.snow.uniforms.uGlow.value = 0.7 + breath;
    this.burst.uniforms.uScale.value = ctx.pixelScale; this.burst.uniforms.uGlow.value = 1.2 + breath;
    this.kelp.uniforms.uTime.value = ctx.time; this.kelp.uniforms.uWind.value = ctx.wind * 0.5; this.kelp.uniforms.uMod.value = mod;
    this.kelp.uniforms.uGlowAmount.value = 0.3 + breath * 0.9 + ctx.energy;
    this.burst.update(dt, ctx.time, 0.9, 0.98, 0.5 + mod * 1.5);
    this.pulseLight.intensity *= Math.pow(0.9, dt * 60);
    this.fog.density = 0.032 * (1.15 - breath * 0.5);
    this.hemisphere.intensity = 0.55 + open * 0.5;

    for (let index = this.jellies.length - 1; index >= 0; index--) {
      const jelly = this.jellies[index];
      jelly.life += dt;
      const born = easeOutCubic(jelly.life / 2.5), dying = clamp01((jelly.life - (jelly.maxLife - 3)) / 3);
      const fade = born * (1 - dying);
      // Pulse: quick contraction, slow recovery, rate follows velocity and modulation.
      const beat = (jelly.life * jelly.rate * (0.7 + mod * 0.9) + jelly.phase / Math.PI) % 1;
      const squeeze = Math.pow(Math.max(0, Math.sin(beat * Math.PI * 2)), 3) * 0.3;
      const thrust = Math.pow(Math.max(0, Math.sin(beat * Math.PI * 2 - 0.6)), 2);
      jelly.bell.scale.set(1 - squeeze * 0.9, 0.85 + squeeze * 0.9, 1 - squeeze * 0.9);
      jelly.group.scale.setScalar(Math.max(0.001, jelly.size * fade));
      jelly.origin.y += (jelly.speed * 0.25 + thrust * jelly.speed * 0.9) * dt;
      jelly.origin.x += jelly.drift.x * dt + Math.sin(ctx.time * 0.3 + jelly.phase) * 0.15 * dt + ctx.wind * dt * 1.2;
      jelly.origin.z += jelly.drift.z * dt;
      jelly.group.position.copy(jelly.origin);
      jelly.group.rotation.z = Math.sin(ctx.time * 0.4 + jelly.phase) * 0.18 + ctx.wind * 0.2;
      jelly.group.rotation.x = Math.cos(ctx.time * 0.35 + jelly.phase) * 0.12;
      jelly.bellMaterial.opacity = 0.55 * fade; jelly.coreMaterial.opacity = 0.7 * fade * (0.5 + open);
      jelly.tentacleMaterial.opacity = 0.65 * fade;
      jelly.bellMaterial.emissiveIntensity = 0.35 + breath * 1.3 + squeeze * 1.2 + ctx.flash * 0.8;
      const length = 3.2 + jelly.lane * -0.4 + open * 1.2;
      jelly.tentacles.forEach((line, tentacle) => {
        const positions = line.geometry.attributes.position as THREE.BufferAttribute;
        const angle = tentacle / TENTACLES * Math.PI * 2, ring = 0.82;
        for (let point = 0; point < TENTACLE_POINTS; point++) {
          const s = point / (TENTACLE_POINTS - 1);
          const lag = Math.sin(ctx.time * 1.3 - s * 3 + jelly.phase + tentacle) * s * 0.35 * (1 + mod) + squeeze * s * 0.5;
          positions.setXYZ(point, Math.cos(angle) * ring * (1 - s * 0.35) + lag, -s * length * (1 - thrust * 0.15) + 0.1,
            Math.sin(angle) * ring * (1 - s * 0.35) + Math.cos(ctx.time * 1.1 - s * 2.5 + tentacle) * s * 0.3);
        }
        positions.needsUpdate = true;
      });
      if (jelly.life >= jelly.maxLife || jelly.origin.y > 22) this.removeJelly(index);
    }
  }

  camera(ctx: SceneContext, camera: THREE.PerspectiveCamera, look: THREE.Vector3): void {
    const t = ctx.time;
    camera.position.set(Math.sin(t * 0.04) * 8 + ctx.wind * 5, -3.5 + Math.sin(t * 0.06) * 2.2 + ctx.energy * 0.3, 10 - Math.cos(t * 0.03) * 3);
    look.set(Math.sin(t * 0.03 + 2) * 6, -1 + Math.sin(t * 0.05) * 2, -24);
  }

  clear(): void {
    while (this.jellies.length) this.removeJelly(0);
    this.burst.clear();
  }

  dispose(): void {
    this.clear();
    this.bellGeometry.dispose(); this.coreGeometry.dispose(); this.burst.dispose();
    disposeTree(this.root);
  }
}
