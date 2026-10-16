import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { AfterimagePass } from "three/examples/jsm/postprocessing/AfterimagePass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { FloraScene, gardenConfig } from "./visual-flora";
import { MyceliumScene } from "./visual-mycelium";
import { OceanScene } from "./visual-ocean";
import { NebulaScene } from "./visual-nebula";
import type { SceneName } from "./visual-names";
import { type SceneContext, type VisualControls, type VisualScene, clamp01, lerp } from "./visual-core";

export type { SceneName } from "./visual-names";
export interface VisualEngine {
  setScene(name: SceneName): void;
  noteOn(note: number, velocity: number, lane: number): void;
  pulse(amount: number): void;
  phrase(words: string[]): void;
  setControls(controls: VisualControls): void;
  setTint(red: number, green: number, blue: number): void;
  setInstrument(program: number): void;
  setPersistence(value: number): void;
  resize(width: number, height: number): void;
  render(timeMs: number): void;
  clear(): void;
  dispose(): void;
}

interface WordSprite { sprite: THREE.Sprite; life: number; maxLife: number; velocity: THREE.Vector3; material: THREE.SpriteMaterial }

const FINISH_SHADER = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uEnergy: { value: 0 }, uFlash: { value: 0 }, uFade: { value: 1 } },
  vertexShader: "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }",
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime,uEnergy,uFlash,uFade; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
    void main(){
      vec2 c=vUv-.5; float r=dot(c,c);
      // Chromatic aberration grows toward the edges and with note energy / ratchets.
      float ca=(.0004+uEnergy*.0009+uFlash*.0016)*(.4+r*4.);
      vec2 dir=normalize(c+1e-5);
      // Rare horizontal slice shift on ratchets keeps the machine feel without a hard glitch.
      float slice=step(.992,h(vec2(floor(vUv.y*48.),floor(uTime*18.))))*step(.6,uFlash)*uFlash;
      vec2 uv=vUv+vec2(slice*.02,0.);
      vec3 col=vec3(texture2D(tDiffuse,uv+dir*ca).r,texture2D(tDiffuse,uv).g,texture2D(tDiffuse,uv-dir*ca).b);
      col*=1.-smoothstep(.15,.62,r)*.62;
      col+=(h(vUv*vec2(1920.,1080.)+uTime)-.5)*.035;
      gl_FragColor=vec4(col*uFade,1.);
    }`,
};

export function createVisualEngine(canvas: HTMLCanvasElement, initial: SceneName): VisualEngine {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 900);
  const look = new THREE.Vector3(0, 0, -20);
  const smoothLook = new THREE.Vector3(0, 0, -20);
  const cameraTarget = new THREE.PerspectiveCamera();
  const world = new THREE.Scene();

  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(world, camera);
  const afterimage = new AfterimagePass(0.0);
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.5, 0.6, 0.9);
  const finish = new ShaderPass(FINISH_SHADER);
  composer.addPass(renderPass); composer.addPass(afterimage); composer.addPass(bloom);
  composer.addPass(new OutputPass()); composer.addPass(finish);

  const controls: VisualControls = { cutoff: 64, resonance: 32, modulation: 0, breath: 0, bend: 8192 };
  const tint = new THREE.Color(0.3, 0.35, 0.2);
  const context: SceneContext = {
    controls, time: 0, energy: 0, flash: 0, tint, variant: 0, wind: 0, pixelScale: 500,
    cameraQuaternion: new THREE.Quaternion(),
  };
  let scene: VisualScene | undefined;
  let pending: SceneName | undefined = initial;
  let sceneName: SceneName | undefined;
  let fade = 0, lastTime = 0, lastNoteAt = -10, persistence = 10;
  let wind = 0, width = 800, height = 500, snapCamera = true;
  const words: WordSprite[] = [];
  const wordTextures = new Map<string, THREE.CanvasTexture>();

  const build = (name: SceneName): VisualScene => {
    if (name === "ocean") return new OceanScene();
    if (name === "nebula") return new NebulaScene();
    if (name === "forest") return new MyceliumScene();
    return new FloraScene(gardenConfig);
  };
  const installScene = (name: SceneName): void => {
    if (scene) { world.remove(scene.root); scene.dispose(); }
    scene = build(name); sceneName = name;
    world.add(scene.root);
    world.background = scene.background; world.fog = scene.fog;
    renderer.toneMappingExposure = scene.exposure;
    snapCamera = true;
  };

  const wordTexture = (text: string): THREE.CanvasTexture => {
    let texture = wordTextures.get(text);
    if (texture) return texture;
    const surface = document.createElement("canvas"); surface.width = 512; surface.height = 160;
    const draw = surface.getContext("2d")!;
    draw.font = "600 96px Inter, system-ui, sans-serif"; draw.textAlign = "center"; draw.textBaseline = "middle";
    draw.shadowColor = "rgba(255,244,214,.9)"; draw.shadowBlur = 28; draw.fillStyle = "rgba(255,248,228,1)";
    draw.fillText(text, 256, 84);
    texture = new THREE.CanvasTexture(surface); texture.colorSpace = THREE.SRGBColorSpace;
    wordTextures.set(text, texture);
    if (wordTextures.size > 80) {
      const oldest = wordTextures.keys().next().value as string;
      wordTextures.get(oldest)?.dispose(); wordTextures.delete(oldest);
    }
    return texture;
  };

  return {
    setScene(name) { if (name !== sceneName) pending = name; },
    noteOn(note, velocity, lane) {
      scene?.spawn(note, velocity, lane, context);
      const now = performance.now() / 1000, ratchet = now - lastNoteAt < 0.145;
      lastNoteAt = now;
      context.energy = Math.min(1, context.energy + velocity / 150);
      context.flash = Math.min(1, context.flash + velocity / (ratchet ? 100 : 260));
    },
    pulse(amount) { context.energy = Math.min(1, context.energy + amount); },
    phrase(list) {
      list.forEach((text, index) => {
        const material = new THREE.SpriteMaterial({ map: wordTexture(text), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, opacity: 0 });
        const sprite = new THREE.Sprite(material);
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const distance = 16 + Math.random() * 6;
        sprite.position.copy(camera.position).addScaledVector(forward, distance)
          .addScaledVector(right, (Math.random() - 0.5) * 10).add(new THREE.Vector3(0, (Math.random() - 0.5) * 4, 0));
        const scale = Math.min(9, 3.2 + text.length * 0.55);
        sprite.scale.set(scale, scale * 0.3125, 1);
        world.add(sprite);
        words.push({ sprite, material, life: -index * 0.28, maxLife: 5 + Math.random() * 2,
          velocity: forward.clone().multiplyScalar(-0.5).add(new THREE.Vector3(0, 0.25, 0)) });
      });
      while (words.length > 32) { const old = words.shift()!; world.remove(old.sprite); old.material.dispose(); }
    },
    setControls(next) { Object.assign(controls, next); },
    setTint(red, green, blue) { tint.setRGB(red / 255, green / 255, blue / 255, THREE.SRGBColorSpace); },
    setInstrument(program) { context.variant = program; context.flash = Math.max(context.flash, 0.3); },
    setPersistence(value) { persistence = value; },
    resize(nextWidth, nextHeight) {
      width = Math.max(320, Math.floor(nextWidth)); height = Math.max(320, Math.floor(nextHeight));
      renderer.setSize(width, height, false); composer.setSize(width, height);
      camera.aspect = width / height; camera.updateProjectionMatrix();
    },
    render(timeMs) {
      const time = timeMs / 1000, dt = Math.min(0.1, Math.max(0.001, time - lastTime)); lastTime = time;
      context.time = time;
      // Scene swaps fade through black so heavy geometry builds never pop on screen.
      if (pending) {
        fade = Math.max(0, fade - dt * 5);
        if (fade <= 0) { installScene(pending); pending = undefined; }
      } else fade = Math.min(1, fade + dt * 2.5);

      const targetWind = (controls.bend - 8192) / 8192;
      wind = lerp(wind, targetWind, 1 - Math.pow(0.001, dt));
      context.wind = wind;
      context.pixelScale = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));

      if (scene) {
        scene.update(dt, context);
        scene.camera(context, cameraTarget, look);
        if (snapCamera) { camera.position.copy(cameraTarget.position); smoothLook.copy(look); snapCamera = false; }
        camera.position.lerp(cameraTarget.position, 1 - Math.pow(0.02, dt));
        smoothLook.lerp(look, 1 - Math.pow(0.05, dt));
        camera.lookAt(smoothLook);
        camera.fov = 58 + context.energy * 3 + (controls.breath / 127) * 4;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        context.cameraQuaternion.copy(camera.quaternion);
      }

      for (let index = words.length - 1; index >= 0; index--) {
        const word = words[index];
        word.life += dt;
        if (word.life <= 0) continue;
        const progress = word.life / word.maxLife;
        word.material.opacity = clamp01(Math.min(word.life * 2.5, (1 - progress) * 2.5)) * 0.9;
        word.sprite.position.addScaledVector(word.velocity, dt);
        if (word.life >= word.maxLife) { world.remove(word.sprite); word.material.dispose(); words.splice(index, 1); }
      }

      const resonance = controls.resonance / 127;
      bloom.strength = (scene?.bloom ?? 1) * (0.22 + resonance * 0.3 + context.energy * 0.28 + context.flash * 0.35);
      bloom.radius = 0.55 + resonance * 0.4;
      afterimage.uniforms.damp.value = persistence <= 4 ? 0 : 0.35 + persistence / 20 * 0.5;
      finish.uniforms.uTime.value = time; finish.uniforms.uEnergy.value = context.energy;
      finish.uniforms.uFlash.value = context.flash; finish.uniforms.uFade.value = fade * fade * (3 - 2 * fade);
      composer.render(dt);

      context.energy *= Math.pow(0.985, dt * 60);
      context.flash *= Math.pow(0.82, dt * 60);
    },
    clear() { scene?.clear(); words.splice(0).forEach(word => { world.remove(word.sprite); word.material.dispose(); }); },
    dispose() {
      words.splice(0).forEach(word => { world.remove(word.sprite); word.material.dispose(); });
      wordTextures.forEach(texture => texture.dispose()); wordTextures.clear();
      if (scene) { world.remove(scene.root); scene.dispose(); scene = undefined; }
      composer.dispose(); bloom.dispose(); afterimage.dispose();
      renderer.dispose(); renderer.forceContextLoss();
    },
  };
}
