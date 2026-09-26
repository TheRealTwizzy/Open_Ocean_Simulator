// Three.js scene: the ocean surface, sky, camera and everything drawn in 3D.
// The wave sum itself runs in the vertex shader from the component texture
// that physics.js packs; this module never evaluates wave maths on its own.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { Sky } from '../vendor/Sky.js';
import { TEX_W, RIPPLE, QUALITY, rippleEta } from './physics.js';

export const PLANE = 3600;           // side of the displaced mesh, metres (stretched grid)
const GRID_LINEAR = 0.28;            // share of linear spacing in the stretch: centre ≈ 0.28·PLANE/segments
const FAR_PLANE = 40000;
const CAMERA_CLEARANCE = 2.5;        // metres the camera must keep above the surface

const smoothstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
const REDUCED_MOTION = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

const PRESETS = {
  orbit:   { position: [285, 170, 450], target: [0, 0, 0] },
  surface: { position: [-46, 7, 160], target: [0, 1.5, 0] },
};

const WAVE_VERT = /* glsl */`
uniform sampler2D uComps;
uniform int uCount;
uniform float uTime;
uniform float uRim;
uniform vec4 uRipples[${RIPPLE.MAX}];
attribute float spacing;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vH;
varying float vJ;
varying float vRip;

void main() {
  float x = position.x, y = position.z;
  float h = 0.0, rip = 0.0;
  vec2 disp = vec2(0.0);
  float Sxx = 0.0, Sxy = 0.0, Syy = 0.0, Shx = 0.0, Shy = 0.0;
#ifndef FLAT
  // amplitude fades over the outer rim so the mesh meets the flat far plane
  float rim = 1.0 - smoothstep(0.82 * uRim, uRim, max(abs(x), abs(y)));
  for (int i = 0; i < ${TEX_W}; i++) {
    if (i >= uCount) break;
    vec4 c0 = texelFetch(uComps, ivec2(i, 0), 0);   // a, k, dx, dy
    vec4 c1 = texelFetch(uComps, ivec2(i, 1), 0);   // phase(t), a·k, Q·a, Q·a·k
    // components too short for the local vertex spacing alias; fade them out
    float lod = rim * (1.0 - smoothstep(2.0, 4.2, c0.y * spacing));
    if (lod <= 0.0) continue;         // contributes exactly zero: skip its sin/cos
    c0.x *= lod; c1.yzw *= lod;
    float ph = c0.y * (c0.z * x + c0.w * y) + c1.x;
    float cs = cos(ph), sn = sin(ph);
    h += c0.x * cs;
    disp -= c1.z * c0.zw * sn;
    float qakc = c1.w * cs;
    Sxx += qakc * c0.z * c0.z;
    Sxy += qakc * c0.z * c0.w;
    Syy += qakc * c0.w * c0.w;
    Shx += c1.y * c0.z * sn;
    Shy += c1.y * c0.w * sn;
  }
  for (int r = 0; r < ${RIPPLE.MAX}; r++) {
    vec4 rp = uRipples[r];
    if (rp.w < 0.5) continue;
    float age = uTime - rp.z;
    if (age < 0.0 || age > ${RIPPLE.LIFE.toFixed(1)}) continue;
    vec2 dv = vec2(x, y) - rp.xy;
    float d = length(dv);
    float u = d - ${RIPPLE.SPEED.toFixed(1)} * age;
    float w2 = ${(RIPPLE.WIDTH * RIPPLE.WIDTH).toFixed(1)};
    float env = exp(-u * u / w2);
    float A = ${RIPPLE.AMP.toFixed(2)} * exp(-age / 3.5) / sqrt(1.0 + d / 25.0);
    float ck = cos(${RIPPLE.K.toFixed(5)} * u), sk = sin(${RIPPLE.K.toFixed(5)} * u);
    h += A * env * ck;
    float dr = A * env * (-2.0 * u / w2 * ck - ${RIPPLE.K.toFixed(5)} * sk);
    vec2 g = dr * dv / max(d, 0.5);
    Shx -= g.x;
    Shy -= g.y;
    rip += env * exp(-age / 2.5);
  }
#endif
  vec3 T = vec3(1.0 - Sxx, -Shx, -Sxy);
  vec3 B = vec3(-Sxy, -Shy, 1.0 - Syy);
  vNormal = normalize(cross(B, T));
  vJ = (1.0 - Sxx) * (1.0 - Syy) - Sxy * Sxy;
  vH = h;
  vRip = rip;
  vec3 wp = vec3(x + disp.x, h, y + disp.y);
  vWorld = wp;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
}`;

const WAVE_FRAG = /* glsl */`
precision highp float;
uniform samplerCube uSky;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSSS;
uniform float uHs;
uniform vec2 uFoamJ;
uniform float uRogueTint;
uniform float uTime;
uniform float uFogNear;
uniform float uFogFar;
uniform float uRim;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vH;
varying float vJ;
varying float vRip;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { return 0.5 * vnoise(p) + 0.25 * vnoise(p * 2.1 + 3.7) + 0.125 * vnoise(p * 4.3 + 1.3); }

void main() {
#ifdef FLAT
  // the far plane only fills beyond the displaced mesh; inside it would poke through troughs
  if (max(abs(vWorld.x), abs(vWorld.z)) < uRim * 0.995) discard;
#endif
  vec3 N = normalize(vNormal);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-3);
  // fine ripple detail the mesh cannot carry, fading with distance. Zero-weight noise is
  // branched around, which only saves work on GPUs that skip a branch all lanes agree on
  // (SwiftShader masks both sides: ~5-15% slower). FLAT keeps these two unbranched, as its
  // discarded lanes still feed textureCube's derivatives.
  vec2 dn = vec2(0.0);
#ifndef FLAT
  if (dist < 420.0)
#endif
  {
    float detail = (1.0 - smoothstep(40.0, 420.0, dist)) * 0.22;
    dn = vec2(fbm(vWorld.xz * 0.14 + uTime * 0.05) - 0.5, fbm(vWorld.zx * 0.14 - uTime * 0.04) - 0.5) * detail;
  }
#ifndef FLAT
  if (dist < 140.0)
#endif
  {
    float fine = (1.0 - smoothstep(10.0, 140.0, dist)) * 0.14;
    dn += vec2(fbm(vWorld.xz * 0.6 + uTime * 0.13) - 0.5, fbm(vWorld.zx * 0.6 - uTime * 0.1) - 0.5) * fine;
  }
  N = normalize(N + vec3(dn.x, 0.0, dn.y));

  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.015);
  vec3 sky = textureCube(uSky, R).rgb;

  float RdL = max(dot(R, uSunDir), 0.0);
  float glint = pow(RdL, 1400.0) * 14.0 + pow(RdL, 120.0) * 0.5;
  float sparkle = dist < 900.0 ? mix(1.0, 0.4 + 1.2 * fbm(vWorld.xz * 0.3 + uTime * 0.09), 1.0 - smoothstep(150.0, 900.0, dist)) : 1.0;
  glint *= sparkle;

  float hN = vH / max(uHs, 0.2);
  float NdL = max(dot(N, uSunDir), 0.0);
  vec3 body = mix(uDeep, uShallow, clamp(hN * 0.3 + 0.35, 0.0, 1.0)) * (0.5 + 0.7 * NdL);
  float back = pow(max(dot(V, -uSunDir), 0.0), 3.0);
  float sss = back * clamp(hN * 0.9 + 0.15, 0.0, 1.6) * pow(1.0 - NdV, 1.2);
  vec3 col = mix(body, sky, fres) + sss * uSSS + glint * uSunColor * (0.3 + 0.7 * fres);

  float fold = clamp(1.0 - vJ, 0.0, 1.0);
  float foamDrive = smoothstep(uFoamJ.x, uFoamJ.y, fold) + smoothstep(1.0, 1.5, hN) * 0.7 + vRip * 0.8;
  // foamDrive is 0 on the whole flat far plane (vJ = 1, vH = 0, vRip = 0)
  float n1 = foamDrive > 0.0 ? fbm(vWorld.xz * 0.11 + vec2(uTime * 0.025, 0.0)) : 0.0;
  float foam = clamp(foamDrive * smoothstep(0.32, 0.72, n1) * 1.5, 0.0, 1.0);
  col = mix(col, vec3(0.86, 0.92, 0.97) * (0.55 + 0.55 * NdL), foam);

  float rz = smoothstep(0.65, 1.0, hN) * uRogueTint;
  col = mix(col, col * vec3(2.4, 0.95, 0.55) + vec3(0.32, 0.09, 0.02), rz * 0.65);

  vec3 hz = normalize(vec3(-V.x, 0.0, -V.z) + vec3(0.0, 0.03, 0.0));
  vec3 haze = textureCube(uSky, hz).rgb;
  float fog = smoothstep(uFogNear, uFogFar, dist);
  col = mix(col, haze, fog);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Grid with vertex density concentrated at the centre: u ∈ [-1, 1] maps to
// x = R·(a·u + (1−a)·u³), so spacing grows ~8× from the middle to the rim.
function gridGeometry(size, segments, stretch = false) {
  const n = segments + 1;
  const R = size / 2, a = stretch ? GRID_LINEAR : 1;
  const map = u => R * (a * u + (1 - a) * u * u * u);
  const coords = new Float64Array(n);
  for (let i = 0; i < n; i++) coords[i] = map(i / segments * 2 - 1);
  const pos = new Float32Array(n * n * 3);
  const spacing = new Float32Array(n * n);
  let p = 0, v = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    pos[p++] = coords[i];
    pos[p++] = 0;
    pos[p++] = coords[j];
    const di = i < segments ? coords[i + 1] - coords[i] : coords[i] - coords[i - 1];
    const dj = j < segments ? coords[j + 1] - coords[j] : coords[j] - coords[j - 1];
    spacing[v++] = Math.max(di, dj);
  }
  const idx = new Uint32Array(segments * segments * 6);
  let q = 0;
  for (let j = 0; j < segments; j++) for (let i = 0; i < segments; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b;
    idx[q++] = b; idx[q++] = c; idx[q++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('spacing', new THREE.BufferAttribute(spacing, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), size);
  g.parameters = { size, segments };
  return g;
}

export class Ocean {
  constructor(canvas, sea, quality = 'med') {
    this.canvas = canvas;
    this.sea = sea;
    this.quality = quality;
    this.simTime = 0;
    this.ripples = [];
    this.buoy = null;
    this.frameTimes = [];
    this.transition = null;
    this._tmpV = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._pt = {};

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.32;
    renderer.setClearColor(0x0a1a2b, 1);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 60000);

    const controls = new OrbitControls(this.camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.7;
    controls.minDistance = 12;
    controls.maxDistance = 1500;
    controls.maxPolarAngle = Math.PI / 2 - 0.035;
    this.controls = controls;

    // sun + sky dome; the dome is also baked into a cube map for reflections
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - 12 * Math.PI / 180, 215 * Math.PI / 180);
    const sky = new Sky();
    sky.scale.setScalar(45000);
    const su = sky.material.uniforms;
    su.turbidity.value = 3;
    su.rayleigh.value = 1.8;
    su.mieCoefficient.value = 0.004;
    su.mieDirectionalG.value = 0.82;
    su.sunPosition.value.copy(this.sunDir);
    this.sky = sky;

    const hdr = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    this.skyTarget = new THREE.WebGLCubeRenderTarget(256, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    });
    this.skyCamera = new THREE.CubeCamera(1, 100000, this.skyTarget);
    this.bakeScene = new THREE.Scene();
    this.rebakeSky();
    // three rebuilds programs and textures after a context restore, but the
    // baked cube map is a render target whose contents are simply gone
    this.needsRebake = false;
    canvas.addEventListener('webglcontextrestored', () => { this.needsRebake = true; });
    // three re-creates its geometry bookkeeping on restore but leaves the old
    // one's dispose listener on the geometry, so setQuality's dispose() would
    // delete buffers of the dead context. Disposing while lost detaches it (the
    // deletes are no-ops then); the restored context re-uploads the grid.
    canvas.addEventListener('webglcontextlost', () => this.mesh.geometry.dispose());

    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.position.copy(this.sunDir).multiplyScalar(1000);
    this.scene.add(sun, new THREE.HemisphereLight(0x9fc8ff, 0x0a2238, 1.1));

    // component texture: row 0 static per compile, row 1 phases per frame
    this.texData = new Float32Array(TEX_W * 2 * 4);
    const tex = new THREE.DataTexture(this.texData, TEX_W, 2, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.compTex = tex;

    this.uniforms = {
      uComps: { value: tex },
      uCount: { value: 0 },
      uTime: { value: 0 },
      uRim: { value: PLANE / 2 },
      uRipples: { value: Array.from({ length: RIPPLE.MAX }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uSky: { value: this.skyTarget.texture },
      uSunDir: { value: this.sunDir },
      uSunColor: { value: new THREE.Color(1.0, 0.93, 0.8) },
      uDeep: { value: new THREE.Color(0.010, 0.055, 0.135) },
      uShallow: { value: new THREE.Color(0.05, 0.32, 0.48) },
      uSSS: { value: new THREE.Color(0.10, 0.85, 0.80) },
      uHs: { value: 1 },
      uFoamJ: { value: new THREE.Vector2(0.3, 0.5) },
      uRogueTint: { value: 1 },
      uFogNear: { value: 600 },
      uFogFar: { value: 4200 },
    };
    const material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: WAVE_VERT, fragmentShader: WAVE_FRAG });
    this.mesh = new THREE.Mesh(gridGeometry(PLANE, QUALITY[quality].segments, true), material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    const farMat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: WAVE_VERT, fragmentShader: WAVE_FRAG, defines: { FLAT: 1 } });
    const far = new THREE.Mesh(gridGeometry(FAR_PLANE, 2), farMat);
    far.position.y = -0.15;
    far.frustumCulled = false;
    this.scene.add(far);
    this.farMesh = far;

    this.buoyMesh = this.makeBuoy();
    this.buoyMesh.visible = false;
    this.scene.add(this.buoyMesh);

    this.raycaster = new THREE.Raycaster();
    this.seaPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.setPreset('orbit', false);
    this.setQuality(quality);
    this.resize();
  }

  // Re-render the sky dome into the reflection cube map (after sun/sky changes).
  rebakeSky() {
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    this.bakeScene.add(this.sky);
    this.skyCamera.update(this.renderer, this.bakeScene);
    this.scene.add(this.sky);
  }

  makeBuoy() {
    const g = new THREE.Group();
    const orange = new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.55, metalness: 0.1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.7 });
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.0, 1.6, 20), orange);
    hull.position.y = 0.3;
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 0.18, 20), dark);
    deck.position.y = 1.15;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 3.2, 8), dark);
    mast.position.y = 2.7;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.32, 14, 10), new THREE.MeshStandardMaterial({ color: 0xfde68a, emissive: 0xfbbf24, emissiveIntensity: 2.5, roughness: 0.3 }));
    lamp.position.y = 4.4;
    g.add(hull, deck, mast, lamp);
    return g;
  }

  setQuality(q) {
    const preset = QUALITY[q] || QUALITY.med;
    this.quality = QUALITY[q] ? q : 'med';
    if (this.mesh.geometry.parameters.segments !== preset.segments) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = gridGeometry(PLANE, preset.segments, true);
    }
    this.resize();
  }

  // Local vertex spacing of the stretched grid at sea-plane (x, y): invert
  // x = R·(a·u + (1−a)·u³) for u, then differentiate.
  gridSpacingAt(x, y) {
    const segments = this.mesh.geometry.parameters.segments, R = PLANE / 2, a = GRID_LINEAR;
    const sp = v => {
      const target = Math.min(Math.abs(v), R) / R;
      let u = target;
      for (let i = 0; i < 6; i++) u -= (a * u + (1 - a) * u * u * u - target) / (a + 3 * (1 - a) * u * u);
      return (2 / segments) * R * (a + 3 * (1 - a) * u * u);
    };
    return Math.max(sp(x), sp(y));
  }

  rimAt(x, y) { return 1 - smoothstep(0.82 * PLANE / 2, PLANE / 2, Math.max(Math.abs(x), Math.abs(y))); }

  // After sea.compile(): refresh everything that only changes with the spectrum.
  syncSea() {
    const sea = this.sea;
    sea.packStatic(this.texData);
    this.uniforms.uCount.value = sea.n;
    this.uniforms.uHs.value = sea.Hs;
    // smoothstep is undefined when its edges coincide, so keep them apart at steepness 0
    this.uniforms.uFoamJ.value.set(Math.max(0.72 * sea.steepness, 0.02), Math.max(sea.steepness, 0.05));
    this.compTex.needsUpdate = true;
  }

  setRogueTint(on) { this.uniforms.uRogueTint.value = on ? 1 : 0; }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[this.quality].pixelRatio));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setPreset(name, animate = true) {
    const p = PRESETS[name] || PRESETS.orbit;
    this.preset = name;
    if (!animate || REDUCED_MOTION()) {
      this.camera.position.set(...p.position);
      this.controls.target.set(...p.target);
      this.controls.update();
      return;
    }
    this.transition = {
      t: 0,
      fromP: this.camera.position.clone(), fromT: this.controls.target.clone(),
      toP: new THREE.Vector3(...p.position), toT: new THREE.Vector3(...p.target),
    };
    this.controls.enabled = false;
  }

  // Screen-space (CSS px) coordinates of a world point, or null when it is
  // behind the camera.
  project(x, h, y) {
    const v = this._tmpV.set(x, h, y).project(this.camera);
    if (v.z > 1) return null;
    return { sx: (v.x + 1) / 2 * this.canvas.clientWidth, sy: (1 - v.y) / 2 * this.canvas.clientHeight };
  }

  // Sea-plane coordinates under a pointer position, refined onto the surface.
  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    let level = 0;
    for (let i = 0; i < 3; i++) {
      this.seaPlane.constant = -level;
      if (!this.raycaster.ray.intersectPlane(this.seaPlane, hit)) return null;
      level = this.sea.eta(hit.x, hit.z, this.simTime);
    }
    if (Math.abs(hit.x) > PLANE * 0.4 || Math.abs(hit.z) > PLANE * 0.4) return null;
    return { x: hit.x, y: hit.z };
  }

  addRipple(x, y, t) {
    this.ripples.push({ x, y, t0: t });
    if (this.ripples.length > RIPPLE.MAX) this.ripples.shift();
  }

  setBuoy(x, y) {
    this.buoy = { x, y };
    this.buoyMesh.visible = true;
  }

  clearBuoy() {
    this.buoy = null;
    this.buoyMesh.visible = false;
  }

  // Where the material point at sea-plane (x, y) is drawn: renderer axes
  // (x, h, z) on the rendered mesh (Gerstner displacement with the shader's
  // spacing/rim fades, plus ripples) and its normal (ripples left out).
  surfacePoint(x, y, t) {
    const p = this.sea.displaced(x, y, t, this._pt, this.gridSpacingAt(x, y), this.rimAt(x, y));
    return { x: p.x, h: p.h + rippleEta(this.ripples, x, y, t), z: p.y, nx: p.nx, ny: p.ny, nz: p.nz };
  }

  // Surface point and elevation at the buoy.
  buoyState(t) {
    if (!this.buoy) return null;
    const s = this.surfacePoint(this.buoy.x, this.buoy.y, t);
    s.eta = s.h;
    return s;
  }

  frame(simTime, wallDt) {
    this.simTime = simTime;
    if (this.needsRebake) { this.needsRebake = false; this.rebakeSky(); }
    const sea = this.sea, u = this.uniforms;
    sea.packPhases(this.texData, simTime);
    this.compTex.needsUpdate = true;
    u.uTime.value = simTime;

    this.ripples = this.ripples.filter(r => simTime - r.t0 <= RIPPLE.LIFE && simTime >= r.t0);
    for (let i = 0; i < RIPPLE.MAX; i++) {
      const r = this.ripples[i];
      if (r) u.uRipples.value[i].set(r.x, r.y, r.t0, 1); else u.uRipples.value[i].set(0, 0, 0, 0);
    }

    if (this.transition) {
      const tr = this.transition;
      tr.t = Math.min(1, tr.t + wallDt / 0.9);
      const e = tr.t < 0.5 ? 2 * tr.t * tr.t : 1 - Math.pow(-2 * tr.t + 2, 2) / 2;
      this.camera.position.lerpVectors(tr.fromP, tr.toP, e);
      this.controls.target.lerpVectors(tr.fromT, tr.toT, e);
      if (tr.t >= 1) { this.transition = null; this.controls.enabled = true; }
    }
    this.controls.update();
    // lift the camera clear of crests for this render only; OrbitControls
    // re-derives its orbit from the position, so a lasting write would ratchet
    const cam = this.camera.position;
    const camY = cam.y;
    const minY = sea.eta(cam.x, cam.z, simTime) + rippleEta(this.ripples, cam.x, cam.z, simTime) + CAMERA_CLEARANCE;
    if (cam.y < minY) cam.y = minY;

    const b = this.buoyState(simTime);
    if (b) {
      const m = this.buoyMesh;
      m.position.set(b.x, b.h - 0.5, b.z);
      this._tmpQ.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this._tmpV.set(b.nx, b.ny, b.nz).normalize());
      m.quaternion.slerp(this._tmpQ, 0.25);
      const s = 1 + Math.max(0, this.camera.position.distanceTo(m.position) - 150) / 220;
      m.scale.setScalar(s);
    }

    this.renderer.render(this.scene, this.camera);
    cam.y = camY;
    this.frameTimes.push(wallDt);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
  }

  // Mean frame time over the last ~1.5 s, once enough frames exist.
  meanFrameTime() {
    if (this.frameTimes.length < 60) return 0;
    return this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
  }
}
