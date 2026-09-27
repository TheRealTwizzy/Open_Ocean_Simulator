// Wave physics: component synthesis, surface evaluation and rogue detection.
// Pure math — no DOM, no Three.js — so it runs unchanged in Node for checks.
//
// Every wave component, whether it belongs to a user train or to the ambient
// wind sea, has the same form:
//     η_i(x, y, t) = a_i · cos( k_i (dx_i·x + dy_i·y) − ω_i·t + φ_i )
// Horizontal axes (x, y) are the sea plane; the renderer maps y onto its z.

export const G = 9.81;
export const TWO_PI = Math.PI * 2;
export const DEG = Math.PI / 180;

export const N_COMP = 7;                                   // components per user train
export const MAX_TRAINS = 6;
export const MAX_AMBIENT = 144;
export const MAX_COMPS = MAX_TRAINS * N_COMP + MAX_AMBIENT; // 186
export const TEX_W = 192;                                  // texel columns of the component texture
export const DETAIL_N = 40;                                // short-wave detail components (shader normals only)
export const LAB = { W: 600, D: 320 };                     // detection region, centred on the origin
export const ROGUE_RATIO = 2.0;                            // H_max / H_s threshold
export const FETCH_M = 60e3;                               // wind fetch used by the JONSWAP fit

export const TRAIN_COLORS = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185', '#e879f9'];

export const RIPPLE = { MAX: 4, LIFE: 8, SPEED: 9, WIDTH: 14, K: TWO_PI / 16, AMP: 1.6 };

// The ambient spectrum is truncated (and tapered) at F_MAX so its shortest
// waves (~16 m) still resolve on the mesh; presets change only how many
// components realise the same spectrum, so H_s does not depend on quality.
export const F_MAX = 0.31;
export const QUALITY = {
  low:  { segments: 160, ambient: 48,  pixelRatio: 1 },
  med:  { segments: 256, ambient: 96,  pixelRatio: 1.5 },
  high: { segments: 384, ambient: 144, pixelRatio: 2 },
};

export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  const u = Math.max(rng(), 1e-12), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
}

function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

// Deep-water dispersion: ω² = g·k, so c = g/ω and λ = g/(2π f²).
export const phaseSpeed = f => G / (TWO_PI * f);
export const wavelength = f => G / (TWO_PI * f * f);

// Frequency/direction jitter inside a train, as fractions of the component
// spacing. Frequency jitter must stay at 0: a uniformly spaced group refocuses
// exactly every 1/Δf, which is what makes two trains coincide often enough to
// produce rogue events; any jitter lets the refocus decay away within a few
// cycles. Direction jitter only changes the group's static transverse shape.
export const TUNE = { fJit: 0, dJit: 0.25 };

export function defaultTrain(i) {
  const presets = [
    { amp: 1.8, freq: 0.15, dir: 0,   bw: 0.20, spread: 10 },
    { amp: 1.6, freq: 0.11, dir: 30,  bw: 0.20, spread: 10 },
    { amp: 1.2, freq: 0.19, dir: -35, bw: 0.25, spread: 15 },
    { amp: 1.0, freq: 0.08, dir: 60,  bw: 0.20, spread: 8 },
    { amp: 0.9, freq: 0.13, dir: -70, bw: 0.20, spread: 12 },
    { amp: 0.8, freq: 0.22, dir: 110, bw: 0.30, spread: 20 },
  ];
  const p = presets[i % presets.length];
  const rng = mulberry32(500 + i * 104729);
  return {
    amp: p.amp, freq: p.freq, speed: phaseSpeed(p.freq), dir: p.dir, bw: p.bw, spread: p.spread, on: true, seed: i,
    // where and when this group first comes into focus
    x0: (rng() - 0.5) * LAB.W * 0.7, y0: (rng() - 0.5) * LAB.D * 0.7, tf: 6 + rng() * 40,
  };
}

// Gaussian-tapered component amplitudes with Σw = 1, so a train's amplitude is
// the crest height it reaches when all seven components focus. Phases are set
// so the components align at the train's focus point (x0, y0) at time tf — a
// dispersively focused group, as made in wave tanks — after which deep-water
// dispersion pulls the group apart and, quasi-periodically, back together.
export function buildTrainComps(tr, dispersion) {
  const rng = mulberry32(1000 + (tr.seed | 0) * 7919);
  const half = (N_COMP - 1) / 2;
  const w = [];
  let sum = 0;
  for (let j = 0; j < N_COMP; j++) {
    const d = j - half;
    w.push(Math.exp(-(d * d) / (2 * 2.5 * 2.5)));
    sum += w[j];
  }
  const th = tr.dir * DEG;
  const x0 = tr.x0 || 0, y0 = tr.y0 || 0, tf = tr.tf || 0;
  const comps = [];
  for (let j = 0; j < N_COMP; j++) {
    const d = (j - half) / half;
    const fj = (rng() * 2 - 1) * TUNE.fJit;
    const dj = (rng() * 2 - 1) * TUNE.dJit;
    const f = Math.max(0.02, tr.freq * (1 + tr.bw * (d + fj / half)));
    const om = TWO_PI * f;
    const k = dispersion ? om * om / G : om / Math.max(0.5, tr.speed);
    const dth = th + tr.spread * DEG * (d + dj / half);
    const dx = Math.cos(dth), dy = Math.sin(dth);
    const phi = -k * (dx * x0 + dy * y0) + om * tf;
    comps.push({ a: tr.amp * w[j] / sum, k, dx, dy, w: om, phi });
  }
  return comps;
}

// Fetch-limited JONSWAP parameters (Hasselmann et al. 1973) for a 10 m wind.
export function windSea(U10, fetchM = FETCH_M) {
  if (!(U10 >= 0.5)) return null;
  const x = G * fetchM / (U10 * U10);
  return { fp: 3.5 * (G / U10) * Math.pow(x, -0.33), alpha: 0.076 * Math.pow(x, -0.22), gamma: 3.3 };
}

export function jonswap(f, { fp, alpha, gamma }) {
  const sigma = f <= fp ? 0.07 : 0.09;
  const r = Math.exp(-((f - fp) ** 2) / (2 * sigma * sigma * fp * fp));
  return alpha * G * G * Math.pow(TWO_PI, -4) * Math.pow(f, -5) * Math.exp(-1.25 * Math.pow(fp / f, 4)) * Math.pow(gamma, r);
}

// Stratified-frequency, random-direction realisation of the wind sea: each
// frequency bin's variance S(f)·Δf is split across nd components so that
// Σ a²/2 reproduces the spectrum exactly.
export function buildAmbientComps(U10, windDirDeg, n, fMax, seed = 7) {
  const ws = windSea(U10);
  if (!ws || n <= 0) return { comps: [], fp: 0, Hs: 0 };
  const nd = n >= 144 ? 4 : n >= 96 ? 3 : 2;
  const nf = Math.floor(n / nd);
  const fLo = 0.55 * ws.fp;
  const fHi = Math.max(Math.min(3.2 * ws.fp, fMax), fLo * 1.08);
  const df = (fHi - fLo) / nf;
  const rng = mulberry32(seed);
  const comps = [];
  let variance = 0;
  for (let i = 0; i < nf; i++) {
    const fc = fLo + (i + 0.5) * df;
    const taper = 1 - smoothstep(0.8 * fMax, fMax, fc);
    const varBin = jonswap(fc, ws) * df * taper;
    const a = Math.sqrt(2 * varBin / nd);
    for (let m = 0; m < nd; m++) {
      const f = fLo + (i + (m + rng()) / nd) * df;
      const spreadDeg = Math.min(Math.max(gaussian(rng) * 26, -80), 80);
      const th = (windDirDeg + spreadDeg) * DEG;
      const om = TWO_PI * f;
      comps.push({ a, k: om * om / G, dx: Math.cos(th), dy: Math.sin(th), w: om, phi: rng() * TWO_PI });
      variance += a * a / 2;
    }
  }
  return { comps, fp: ws.fp, Hs: 4 * Math.sqrt(variance) };
}

// The wind sea's spectrum continued below the mesh's ~16 m cut-off, down to
// ~0.3 m: log-spaced frequencies (jittered within their bins), directions spread
// around the wind. The weight smoothstep(0.8·fMax, fMax, f) is the complement of
// the ambient taper, so mesh and detail together carry the whole spectrum. For
// an f⁻⁵ tail the slope variance a²k²/2 is equal per octave, so every component
// adds about the same roughness. These only shade the surface (normals, glints,
// whitecaps): they neither displace the mesh nor enter H_s or the detector.
// Returns { comps: [{ k, dx, dy, w, phi, ak }] (ascending f), msSlope: Σ a²k²/2 }.
export function buildDetailWaves(U10, windDirDeg, fMax = F_MAX, n = DETAIL_N, fTop = 2.3, seed = 11) {
  const ws = windSea(U10);
  if (!ws) return { comps: [], msSlope: 0 };
  const f1 = 0.8 * fMax, r = Math.pow(fTop / f1, 1 / n);
  const rng = mulberry32(seed);
  const comps = [];
  let msSlope = 0;
  for (let i = 0; i < n; i++) {
    const lo = f1 * Math.pow(r, i), hi = lo * r;
    const f = lo * Math.pow(r, 0.1 + 0.8 * rng());
    const a = Math.sqrt(2 * jonswap(f, ws) * (hi - lo) * smoothstep(0.8 * fMax, fMax, f));
    const om = TWO_PI * f, k = om * om / G;
    const th = (windDirDeg + Math.min(Math.max(gaussian(rng) * 32, -90), 90)) * DEG;
    comps.push({ k, dx: Math.cos(th), dy: Math.sin(th), w: om, phi: rng() * TWO_PI, ak: a * k });
    msSlope += a * a * k * k / 2;
  }
  return { comps, msSlope };
}

// The compiled component set shared by the CPU (detection, buoy, 2D view) and
// the GPU (vertex shader via a float texture).
export class Sea {
  constructor() {
    const N = MAX_COMPS;
    this.n = 0;
    this.a = new Float64Array(N);
    this.k = new Float64Array(N);
    this.dx = new Float64Array(N);
    this.dy = new Float64Array(N);
    this.w = new Float64Array(N);
    this.phi = new Float64Array(N);
    this.kdx = new Float64Array(N);
    this.kdy = new Float64Array(N);
    this.trainRange = [];        // [start, count] per train slot
    this.ambientStart = 0;
    this.ambientFp = 0;
    this.ambientHs = 0;
    this.Hs = 0;
    this.Q = 0;                  // Gerstner displacement factor (shared by all components)
    this.detail = { comps: [], msSlope: 0 };
    this.steepness = 0;
  }

  compile({ trains, dispersion = true, wind = 0, windDir = 0, nAmbient = 0, fMax = F_MAX, steepness = 0.5 }) {
    let n = 0;
    const put = c => {
      this.a[n] = c.a; this.k[n] = c.k; this.dx[n] = c.dx; this.dy[n] = c.dy;
      this.w[n] = c.w; this.phi[n] = c.phi; this.kdx[n] = c.k * c.dx; this.kdy[n] = c.k * c.dy;
      n++;
    };
    this.trainRange = [];
    for (const tr of trains.slice(0, MAX_TRAINS)) {
      const start = n;
      if (tr.on && tr.amp > 0) for (const c of buildTrainComps(tr, dispersion)) put(c);
      this.trainRange.push([start, n - start]);
    }
    this.ambientStart = n;
    const amb = buildAmbientComps(wind, windDir, Math.min(nAmbient, MAX_AMBIENT), fMax);
    for (const c of amb.comps) put(c);
    this.ambientFp = amb.fp;
    this.ambientHs = amb.Hs;
    this.detail = buildDetailWaves(wind, windDir, fMax);
    this.n = n;

    let variance = 0, sumAK = 0;
    for (let i = 0; i < n; i++) { variance += this.a[i] * this.a[i] / 2; sumAK += this.a[i] * this.k[i]; }
    this.Hs = 4 * Math.sqrt(variance);
    this.steepness = steepness;
    this.Q = sumAK > 0 ? steepness / sumAK : 0;
    return this;
  }

  // Linear surface elevation (the quantity the detector and H_s refer to).
  eta(x, y, t, i0 = 0, i1 = this.n) {
    let s = 0;
    for (let i = i0; i < i1; i++) s += this.a[i] * Math.cos(this.kdx[i] * x + this.kdy[i] * y - this.w[i] * t + this.phi[i]);
    return s;
  }

  etaTrain(slot, x, y, t) {
    const r = this.trainRange[slot];
    return r ? this.eta(x, y, t, r[0], r[0] + r[1]) : 0;
  }

  etaAmbient(x, y, t) { return this.eta(x, y, t, this.ambientStart, this.n); }

  // Samples η along a straight line with a rotation recurrence instead of a
  // trig call per sample: out[j] = η(x0 + j·ex·ds, y0 + j·ey·ds, t).
  fillRow(out, nS, x0, y0, ex, ey, ds, t, i0 = 0, i1 = this.n) {
    out.fill(0, 0, nS);
    for (let i = i0; i < i1; i++) {
      const ph0 = this.kdx[i] * x0 + this.kdy[i] * y0 - this.w[i] * t + this.phi[i];
      const dph = (this.kdx[i] * ex + this.kdy[i] * ey) * ds;
      let c = Math.cos(ph0), s = Math.sin(ph0);
      const cd = Math.cos(dph), sd = Math.sin(dph);
      const A = this.a[i];
      for (let j = 0; j < nS; j++) {
        out[j] += A * c;
        const c2 = c * cd - s * sd;
        s = s * cd + c * sd;
        c = c2;
      }
    }
    return out;
  }

  // Gerstner-displaced surface point and its normal for the material point
  // (x, y) — the same maths as the vertex shader, used for the buoy and beacon.
  // lodSpacing (local mesh vertex spacing) and rim reproduce the shader's
  // anti-aliasing and edge fades so the result sits on the rendered mesh.
  // out = { x, h, y, nx, ny, nz } with (x, h, y) in renderer axes (x, up, z).
  displaced(x, y, t, out = {}, lodSpacing = 0, rim = 1) {
    const Q = this.Q;
    let X = x, Y = y, h = 0, Sxx = 0, Sxy = 0, Syy = 0, Shx = 0, Shy = 0;
    for (let i = 0; i < this.n; i++) {
      const ph = this.kdx[i] * x + this.kdy[i] * y - this.w[i] * t + this.phi[i];
      const c = Math.cos(ph), s = Math.sin(ph);
      let a = this.a[i] * rim;
      if (lodSpacing > 0) a *= 1 - smoothstep(2.0, 4.2, this.k[i] * lodSpacing);
      const ak = a * this.k[i], dx = this.dx[i], dy = this.dy[i];
      h += a * c;
      X -= Q * a * dx * s;
      Y -= Q * a * dy * s;
      Sxx += Q * ak * dx * dx * c;
      Sxy += Q * ak * dx * dy * c;
      Syy += Q * ak * dy * dy * c;
      Shx += ak * dx * s;
      Shy += ak * dy * s;
    }
    let nx = Shy * Sxy + (1 - Syy) * Shx;
    let ny = (1 - Syy) * (1 - Sxx) - Sxy * Sxy;
    let nz = Sxy * Shx + Shy * (1 - Sxx);
    const l = Math.hypot(nx, ny, nz) || 1;
    out.x = X; out.h = h; out.y = Y;
    out.nx = nx / l; out.ny = ny / l; out.nz = nz / l;
    return out;
  }

  // Component texture: row 0 is static per compile (a, k, dx, dy); row 1 is
  // refreshed every frame with the time-dependent phase so the shader never
  // multiplies a large t in float32.
  packStatic(data) {
    for (let i = 0; i < TEX_W; i++) {
      const o = i * 4;
      if (i < this.n) { data[o] = this.a[i]; data[o + 1] = this.k[i]; data[o + 2] = this.dx[i]; data[o + 3] = this.dy[i]; }
      else data.fill(0, o, o + 4);
    }
  }

  packPhases(data, t) {
    const base = TEX_W * 4, Q = this.Q;
    for (let i = 0; i < this.n; i++) {
      const o = base + i * 4;
      let ph = (this.phi[i] - this.w[i] * t) % TWO_PI;
      if (ph < 0) ph += TWO_PI;
      const ak = this.a[i] * this.k[i];
      data[o] = ph; data[o + 1] = ak; data[o + 2] = Q * this.a[i]; data[o + 3] = Q * ak;
    }
  }
}

// Zero-down-crossing wave heights along one sampled profile: returns the
// tallest crest-to-trough height and the index of its crest.
export function scanWaves(eta, n = eta.length) {
  let Hmax = 0, iCrest = 0;
  let segMax = -Infinity, segMin = Infinity, segMaxI = 0;
  const close = () => {
    const h = segMax - segMin;
    if (h > Hmax) { Hmax = h; iCrest = segMaxI; }
  };
  for (let i = 0; i < n; i++) {
    const y = eta[i];
    // the first sample below zero opens the next wave; it must not be
    // charged to the wave that just ended
    if (i > 0 && eta[i - 1] >= 0 && y < 0) {
      close();
      segMax = -Infinity; segMin = Infinity; segMaxI = i;
    }
    if (y > segMax) { segMax = y; segMaxI = i; }
    if (y < segMin) segMin = y;
  }
  if (n > 0) close();
  return { Hmax, iCrest };
}

// Samples the lab region on a grid, then runs the zero-crossing scan along
// every row and every column so crossing seas are caught in both directions.
export class Detector {
  constructor(sea, spacing = 8) {
    this.sea = sea;
    this.ds = spacing;
    this.nx = Math.round(LAB.W / spacing) + 1;
    this.ny = Math.round(LAB.D / spacing) + 1;
    this.grid = new Float64Array(this.nx * this.ny);
    this.col = new Float64Array(this.ny);
  }

  detect(t) {
    const { sea, nx, ny, ds, grid, col } = this;
    const x0 = -LAB.W / 2, y0 = -LAB.D / 2;
    for (let j = 0; j < ny; j++) sea.fillRow(grid.subarray(j * nx, (j + 1) * nx), nx, x0, y0 + j * ds, 1, 0, ds, t);
    const best = { Hmax: 0, xM: 0, yM: 0, eta: 0 };
    for (let j = 0; j < ny; j++) {
      const row = grid.subarray(j * nx, (j + 1) * nx);
      const { Hmax, iCrest } = scanWaves(row, nx);
      if (Hmax > best.Hmax) { best.Hmax = Hmax; best.xM = x0 + iCrest * ds; best.yM = y0 + j * ds; best.eta = row[iCrest]; }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) col[j] = grid[j * nx + i];
      const { Hmax, iCrest } = scanWaves(col, ny);
      if (Hmax > best.Hmax) { best.Hmax = Hmax; best.xM = x0 + i * ds; best.yM = y0 + iCrest * ds; best.eta = col[iCrest]; }
    }
    return best;
  }

  // Scans the sea time since the previous scan in even steps ending exactly at
  // t1, at most maxGap apart but no more than maxSteps scans: at high time
  // speed one frame spans more sea time than the shortest rogue windows
  // (0.04-0.1 s). maxGap sits just above the default 2.5x span (0.083 s), so
  // the default speed still scans once. t1 <= t0 (paused, or time reset)
  // scans t1 alone.
  // Returns { best, last }: detect() results with their sea time t added; best
  // has the highest Hmax, last is the scan at t1.
  scanInterval(t0, t1, maxGap = 0.085, maxSteps = 6) {
    const steps = t1 > t0 ? Math.min(Math.max(Math.ceil((t1 - t0) / maxGap), 1), maxSteps) : 1;
    let best = null, last = null;
    for (let s = 1; s <= steps; s++) {
      const t = s === steps ? t1 : t0 + (t1 - t0) * s / steps;
      last = this.detect(t);
      last.t = t;
      if (!best || last.Hmax > best.Hmax) best = last;
    }
    return { best, last };
  }
}

// Splash ripples are decorative: a decaying circular packet, evaluated here for
// the buoy and in the vertex shader for the mesh, but never fed to the detector.
export function rippleEta(ripples, x, y, t) {
  let h = 0;
  for (const r of ripples) {
    const age = t - r.t0;
    if (age < 0 || age > RIPPLE.LIFE) continue;
    const d = Math.hypot(x - r.x, y - r.y);
    const u = d - RIPPLE.SPEED * age;
    const env = Math.exp(-(u * u) / (RIPPLE.WIDTH * RIPPLE.WIDTH));
    h += RIPPLE.AMP * env * Math.cos(RIPPLE.K * u) * Math.exp(-age / 3.5) / Math.sqrt(1 + d / 25);
  }
  return h;
}
