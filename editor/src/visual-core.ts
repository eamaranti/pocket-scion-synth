import * as THREE from "three";

/** Live MIDI controller state shared with every scene (same ranges as the editor). */
export interface VisualControls { cutoff: number; resonance: number; modulation: number; breath: number; bend: number }

export interface SceneContext {
  controls: VisualControls;
  /** Seconds since the engine started. */
  time: number;
  /** Smoothed note activity, 0–1. */
  energy: number;
  /** Short transient used for ratchets, 0–1. */
  flash: number;
  /** Bank LED colour supplied by the instrument. */
  tint: THREE.Color;
  /** Instrument position 0–15, used to rotate palettes and layouts. */
  variant: number;
  /** Pitch bend, −1…1. */
  wind: number;
  /** Viewport height in device pixels divided by 2·tan(fov/2), for point sizing. */
  pixelScale: number;
  /** Camera orientation after the previous frame, for billboards. */
  cameraQuaternion: THREE.Quaternion;
}

export interface VisualScene {
  readonly root: THREE.Group;
  readonly background: THREE.Color;
  readonly fog: THREE.FogExp2 | null;
  readonly exposure: number;
  readonly bloom: number;
  update(dt: number, ctx: SceneContext): void;
  spawn(note: number, velocity: number, lane: number, ctx: SceneContext): void;
  camera(ctx: SceneContext, camera: THREE.PerspectiveCamera, look: THREE.Vector3): void;
  clear(): void;
  dispose(): void;
}

/** Deterministic pseudo-random generator so a given seed always grows the same organism. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
export const easeOutCubic = (value: number): number => 1 - Math.pow(1 - clamp01(value), 3);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Maps a MIDI note to a position in −1…1 (low notes left). */
export const pitchToUnit = (note: number): number => clamp01((note - 24) / 72) * 2 - 1;

/**
 * Lane colour from a scene's base hues. The instrument position rotates the
 * hue and the bank LED colour is mixed in lightly, so patch changes visibly
 * change the world without losing each scene's identity.
 */
export function laneColor(hues: readonly number[], lane: number, variant: number, tint: THREE.Color,
  saturation: number, lightness: number, target = new THREE.Color()): THREE.Color {
  const hue = (hues[lane % hues.length] + variant * 0.037) % 1;
  target.setHSL(hue, saturation, lightness);
  return target.lerp(tint, 0.14);
}

export const GLSL_NOISE = /* glsl */ `
float hash11(float p){ p=fract(p*.1031); p*=p+33.33; p*=p+p; return fract(p); }
float hash31(vec3 p){ p=fract(p*.1031); p+=dot(p,p.zyx+31.32); return fract((p.x+p.y)*p.z); }
float vnoise(vec3 x){
  vec3 i=floor(x), f=fract(x); f=f*f*(3.-2.*f);
  return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x), mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x), mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y), f.z);
}
float fbm(vec3 p){ float a=.5, s=0.; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=.5; } return s; }
`;

/** Sky / water-column backdrop: vertical gradient plus a soft glow around a direction. */
export function createSkyDome(radius: number): { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform> } {
  const uniforms: Record<string, THREE.IUniform> = {
    uTop: { value: new THREE.Color(0x02040a) }, uHorizon: { value: new THREE.Color(0x0a1a22) },
    uGlow: { value: new THREE.Color(0x335566) }, uGlowDir: { value: new THREE.Vector3(0.3, 0.25, -1).normalize() },
    uGlowSize: { value: 0.35 }, uTime: { value: 0 }, uStars: { value: 0.5 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `${GLSL_NOISE}
      uniform vec3 uTop,uHorizon,uGlow,uGlowDir; uniform float uGlowSize,uTime,uStars; varying vec3 vDir;
      void main(){
        float h=clamp(vDir.y*.5+.5,0.,1.);
        vec3 c=mix(uHorizon,uTop,pow(smoothstep(.45,1.,h),.8));
        float g=max(dot(normalize(vDir),uGlowDir),0.);
        c+=uGlow*(pow(g,3.)*.35+pow(g,1.5)*.2)/max(.15,uGlowSize);
        float cloud=fbm(vDir*3.+vec3(uTime*.01,0.,0.));
        c+=uGlow*.08*smoothstep(.4,.8,cloud)*smoothstep(.45,.6,h);
        vec3 sc=vDir*140.; vec3 sp=floor(sc); float s=step(.992,hash31(sp))*smoothstep(.4,.0,length(fract(sc)-.5));
        c+=vec3(s)*uStars*smoothstep(.55,.8,h)*(.6+.4*sin(uTime*2.+hash31(sp)*40.));
        gl_FragColor=vec4(c,1.);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
  mesh.frustumCulled = false; mesh.renderOrder = -10;
  return { mesh, uniforms };
}

/** Always-on drifting particle volume (dust, marine snow, fireflies). Motion is computed on the GPU. */
export function createParticleField(count: number, box: THREE.Vector3, size: number, seed: number): {
  points: THREE.Points; uniforms: Record<string, THREE.IUniform>;
} {
  const random = mulberry32(seed);
  const seeds = new Float32Array(count * 4), positions = new Float32Array(count * 3);
  for (let index = 0; index < count * 4; index++) seeds[index] = random();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 }, uBox: { value: box }, uCenter: { value: new THREE.Vector3() },
    uDrift: { value: new THREE.Vector3(0.02, 0.01, 0.0) }, uSize: { value: size }, uScale: { value: 500 },
    uColor: { value: new THREE.Color(0xffffff) }, uColorB: { value: new THREE.Color(0xffffff) },
    uGlow: { value: 1 }, uSway: { value: 0.4 }, uTwinkle: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    vertexShader: `
      attribute vec4 aSeed; uniform float uTime,uSize,uScale,uSway,uTwinkle; uniform vec3 uBox,uCenter,uDrift;
      varying float vAlpha; varying float vMix;
      void main(){
        vec3 p=fract(aSeed.xyz+uDrift*uTime*(.4+aSeed.w))-.5;
        vec3 world=uCenter+p*uBox;
        world.x+=sin(uTime*.5+aSeed.y*30.)*uSway; world.y+=cos(uTime*.4+aSeed.x*25.)*uSway*.7; world.z+=sin(uTime*.3+aSeed.z*20.)*uSway;
        vec4 mv=viewMatrix*vec4(world,1.);
        gl_Position=projectionMatrix*mv;
        float edge=smoothstep(.5,.38,abs(p.x))*smoothstep(.5,.38,abs(p.y))*smoothstep(.5,.38,abs(p.z));
        float tw=mix(1.,.5+.5*sin(uTime*(1.+aSeed.w*3.)+aSeed.x*60.),uTwinkle);
        vAlpha=edge*tw*(.35+.65*aSeed.w); vMix=aSeed.z;
        gl_PointSize=max(1.,uSize*uScale*(.4+aSeed.w)/max(.5,-mv.z));
      }`,
    fragmentShader: `
      uniform vec3 uColor,uColorB; uniform float uGlow; varying float vAlpha; varying float vMix;
      void main(){
        vec2 d=gl_PointCoord-.5; float r=length(d)*2.; if(r>1.) discard;
        float a=pow(1.-r,2.2)*vAlpha*uGlow;
        gl_FragColor=vec4(mix(uColor,uColorB,vMix)*a,a);
      }`,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, uniforms };
}

/** CPU-simulated burst particles: spores, bubbles, stardust released by each note. */
export class BurstPool {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private readonly position: Float32Array;
  private readonly color: Float32Array;
  private readonly size: Float32Array;
  private readonly velocity: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private cursor = 0;
  readonly uniforms: Record<string, THREE.IUniform> = { uScale: { value: 500 }, uGlow: { value: 1 } };

  constructor(capacity: number) {
    this.capacity = capacity;
    this.position = new Float32Array(capacity * 3); this.color = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity); this.velocity = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity); this.maxLife = new Float32Array(capacity).fill(1);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aColor", new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      vertexShader: `
        attribute vec3 aColor; attribute float aSize; uniform float uScale; varying vec3 vColor;
        void main(){ vColor=aColor; vec4 mv=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*mv;
          gl_PointSize=aSize>0.?max(1.,aSize*uScale/max(.5,-mv.z)):0.; }`,
      fragmentShader: `
        uniform float uGlow; varying vec3 vColor;
        void main(){ vec2 d=gl_PointCoord-.5; float r=length(d)*2.; if(r>1.) discard;
          float a=pow(1.-r,2.);
          gl_FragColor=vec4(vColor*a*uGlow,a); }`,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
  }

  emit(position: THREE.Vector3, velocity: THREE.Vector3, life: number, size: number, color: THREE.Color): void {
    const index = this.cursor; this.cursor = (this.cursor + 1) % this.capacity;
    this.position.set([position.x, position.y, position.z], index * 3);
    this.velocity.set([velocity.x, velocity.y, velocity.z], index * 3);
    this.color.set([color.r, color.g, color.b], index * 3);
    this.life[index] = life; this.maxLife[index] = life; this.size[index] = size;
  }

  /** `buoyancy` is vertical acceleration (negative falls), `turbulence` is a flow-noise strength. */
  update(dt: number, time: number, buoyancy: number, drag: number, turbulence: number): void {
    const damping = Math.pow(drag, dt * 60);
    for (let index = 0; index < this.capacity; index++) {
      if (this.life[index] <= 0) { this.size[index] = 0; continue; }
      this.life[index] -= dt;
      const base = index * 3;
      const x = this.position[base], y = this.position[base + 1], z = this.position[base + 2];
      this.velocity[base] = this.velocity[base] * damping + Math.sin(y * 0.9 + time * 1.1 + index) * turbulence * dt;
      this.velocity[base + 1] = this.velocity[base + 1] * damping + buoyancy * dt;
      this.velocity[base + 2] = this.velocity[base + 2] * damping + Math.cos(x * 0.8 + time * 0.9 + index) * turbulence * dt;
      this.position[base] = x + this.velocity[base] * dt;
      this.position[base + 1] = y + this.velocity[base + 1] * dt;
      this.position[base + 2] = z + this.velocity[base + 2] * dt;
      const fade = clamp01(this.life[index] / this.maxLife[index]);
      this.size[index] = Math.max(0.0001, this.size[index] * (fade < 0.25 ? 0.96 : 1));
    }
    const geometry = this.points.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aColor.needsUpdate = true;
    geometry.attributes.aSize.needsUpdate = true;
  }

  clear(): void { this.life.fill(0); this.size.fill(0); this.points.geometry.attributes.aSize.needsUpdate = true; }

  dispose(): void { this.points.geometry.dispose(); (this.points.material as THREE.Material).dispose(); }
}

/** Tube with a linear radius taper. Returns position + normal + index only, so results can be merged. */
export function taperedTube(points: THREE.Vector3[], radiusStart: number, radiusEnd: number,
  radial = 6, segments = 12): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points);
  const frames = curve.computeFrenetFrames(segments, false);
  const positions: number[] = [], indices: number[] = [];
  for (let ring = 0; ring <= segments; ring++) {
    const u = ring / segments, center = curve.getPointAt(u);
    const radius = lerp(radiusStart, radiusEnd, u);
    const normal = frames.normals[ring], binormal = frames.binormals[ring];
    for (let side = 0; side < radial; side++) {
      const angle = side / radial * Math.PI * 2;
      positions.push(
        center.x + (Math.cos(angle) * normal.x + Math.sin(angle) * binormal.x) * radius,
        center.y + (Math.cos(angle) * normal.y + Math.sin(angle) * binormal.y) * radius,
        center.z + (Math.cos(angle) * normal.z + Math.sin(angle) * binormal.z) * radius);
    }
  }
  for (let ring = 0; ring < segments; ring++) {
    for (let side = 0; side < radial; side++) {
      const a = ring * radial + side, b = ring * radial + (side + 1) % radial;
      const c = (ring + 1) * radial + side, d = (ring + 1) * radial + (side + 1) % radial;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

/** Wind-swayed instanced blades (grass, kelp). Per-blade colour comes from instanceColor. */
export function createBladeField(options: {
  count: number; radius: number; minHeight: number; maxHeight: number; width: number;
  heightAt: (x: number, z: number) => number; seed: number; segments?: number; hole?: number;
  tipColor: THREE.Color; glow: number;
}): { mesh: THREE.InstancedMesh; uniforms: Record<string, THREE.IUniform> } {
  const rows = options.segments ?? 4;
  const positions: number[] = [], heights: number[] = [], indices: number[] = [];
  for (let row = 0; row <= rows; row++) {
    const h = row / rows, half = options.width * (1 - h * 0.92) * 0.5;
    positions.push(-half, h, 0, half, h, 0); heights.push(h, h);
    if (row < rows) { const a = row * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aH", new THREE.Float32BufferAttribute(heights, 1));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 }, uWind: { value: 0 }, uMod: { value: 0 },
    uTip: { value: options.tipColor.clone() }, uGlowAmount: { value: options.glow },
  };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide, vertexColors: false });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float aH; uniform float uTime,uWind,uMod; varying float vH;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vH=aH;
        vec4 iw=instanceMatrix*vec4(0.,0.,0.,1.);
        float sw=sin(uTime*1.6+iw.x*.35+iw.z*.27)*(.12+uMod*.5)+sin(uTime*.7+iw.z*.5)*.08+uWind*.55;
        transformed.x+=sw*aH*aH; transformed.z+=cos(uTime*1.1+iw.x*.4)*.08*aH*aH*(1.+uMod*3.);`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform vec3 uTip; uniform float uGlowAmount; varying float vH;`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        totalEmissiveRadiance+=uTip*pow(vH,3.)*uGlowAmount;`);
  };
  const mesh = new THREE.InstancedMesh(geometry, material, options.count);
  const random = mulberry32(options.seed);
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion(), position = new THREE.Vector3();
  const scale = new THREE.Vector3(), euler = new THREE.Euler(), color = new THREE.Color();
  for (let index = 0; index < options.count; index++) {
    const angle = random() * Math.PI * 2, distance = Math.sqrt(random()) * options.radius;
    const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance - options.radius * 0.3;
    if (options.hole && Math.hypot(x, z + options.radius * 0.3) < options.hole && random() < 0.85) { index--; continue; }
    position.set(x, options.heightAt(x, z), z);
    euler.set((random() - 0.5) * 0.25, random() * Math.PI * 2, (random() - 0.5) * 0.25);
    quaternion.setFromEuler(euler);
    const height = lerp(options.minHeight, options.maxHeight, Math.pow(random(), 1.6));
    scale.set(0.7 + random() * 0.8, height, 1);
    matrix.compose(position, quaternion, scale); mesh.setMatrixAt(index, matrix);
    color.setHSL(0.28 + random() * 0.1, 0.45 + random() * 0.3, 0.12 + random() * 0.1);
    mesh.setColorAt(index, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false; mesh.receiveShadow = true;
  return { mesh, uniforms };
}

/** Releases geometry, materials and textures below an object. */
export function disposeTree(object: THREE.Object3D): void {
  object.traverse(child => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach(entry => entry.dispose()); else material?.dispose();
  });
}
