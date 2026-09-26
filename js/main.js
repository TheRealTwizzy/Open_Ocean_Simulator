// Entry point: owns the simulation state and the frame loop, wires the scene
// (ocean.js), the wave maths (physics.js) and the HUD (ui.js) together.

import { Sea, Detector, defaultTrain, QUALITY, ROGUE_RATIO, MAX_TRAINS, TRAIN_COLORS, phaseSpeed } from './physics.js';
import { initUI } from './ui.js';

const FREEZE_MS = 1600;
const COOLDOWN_MS = 6000;
const DETECT_MS = 33;

const params = new URLSearchParams(location.search);

const state = {
  trains: [],
  nextSeed: 0,
  wind: 8, windDir: 20, steepness: 0.55, timeScale: 2.5, dispersion: true,
  quality: 'auto', qualityActual: 'med',
  rogueTint: true, autoFreeze: true,
  clickMode: 'splash', cameraPreset: 'orbit',
  simTime: 0, running: true, frames: 0,
  freezeUntil: 0, cooldownUntil: 0, rogueCount: 0, lastEvent: null,
  Hmax: 0, ratio: 0,
};

function freshTrains() {
  state.trains = [defaultTrain(0), defaultTrain(1)];
  state.nextSeed = 2;
  state.trains.forEach((tr, i) => { tr.color = TRAIN_COLORS[i]; });
}

function autoQuality() {
  const override = params.get('q');
  if (QUALITY[override]) return override;
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (coarse || Math.min(innerWidth, innerHeight) < 600) return 'low';
  const cores = navigator.hardwareConcurrency || 4;
  return cores >= 8 && (devicePixelRatio || 1) <= 1.5 ? 'high' : 'med';
}

const sea = new Sea();
const detector = new Detector(sea, 8);
const canvas = document.getElementById('gl');

let ocean = null;
const actions = {};
const ui = initUI({ state, sea, actions });

function compile() {
  const q = QUALITY[state.qualityActual];
  sea.compile({
    trains: state.trains, dispersion: state.dispersion, wind: state.wind, windDir: state.windDir,
    nAmbient: q.ambient, steepness: state.steepness,
  });
  if (ocean) ocean.syncSea();
}

actions.rebuild = () => { compile(); ui.syncAllCards(); ui.renderLegend(); };

actions.addTrain = () => {
  if (state.trains.length >= MAX_TRAINS) return;
  const tr = defaultTrain(state.nextSeed++);
  if (!state.dispersion) tr.speed = phaseSpeed(tr.freq);
  state.trains.push(tr);
  ui.refresh();
  compile();
};

actions.removeTrain = i => {
  state.trains.splice(i, 1);
  ui.refresh();
  compile();
};

actions.togglePause = () => {
  state.running = !state.running;
  ui.setPaused(!state.running);
};

actions.applyTint = () => { if (ocean) ocean.setRogueTint(state.rogueTint); };

actions.setQuality = q => {
  state.quality = q;
  state.qualityActual = q === 'auto' ? autoQuality() : q;
  if (ocean) ocean.setQuality(state.qualityActual);
  compile();
  ui.syncSettings();
};

actions.setClickMode = mode => { state.clickMode = mode; ui.syncModes(); };

actions.setCamera = preset => {
  state.cameraPreset = preset;
  if (ocean) ocean.setPreset(preset, true);
  ui.syncModes();
};

actions.clearBuoy = () => { if (ocean) ocean.clearBuoy(); ui.updateBuoy(null, performance.now()); };

actions.reset = () => {
  freshTrains();
  Object.assign(state, {
    wind: 8, windDir: 20, steepness: 0.55, timeScale: 2.5, dispersion: true, rogueTint: true, autoFreeze: true,
    simTime: 0, freezeUntil: 0, cooldownUntil: 0, rogueCount: 0, lastEvent: null, Hmax: 0, ratio: 0,
  });
  if (ocean) { ocean.ripples.length = 0; ocean.clearBuoy(); ocean.setRogueTint(true); }
  ui.refresh();
  compile();
  ui.updateStats(0, 0);
};

// ---------- detection ----------
function triggerRogue(best, ratio, wallNow) {
  state.rogueCount++;
  state.lastEvent = { xM: best.xM, yM: best.yM, eta: best.eta, ratio, wall: wallNow };
  state.cooldownUntil = wallNow + COOLDOWN_MS;
  if (state.autoFreeze) state.freezeUntil = wallNow + FREEZE_MS;
  ui.showAlert(state.lastEvent);
}

// ---------- pointer: click vs drag ----------
let press = null;
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  press = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
});
canvas.addEventListener('pointerup', e => {
  if (!press || press.id !== e.pointerId) return;
  const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
  const held = performance.now() - press.t;
  press = null;
  if (moved > 6 || held > 400) return;
  if (ui.isPopOpen()) { ui.closePop(); return; }
  if (!ocean) return;
  const p = ocean.pick(e.clientX, e.clientY);
  if (!p) return;
  if (state.clickMode === 'splash') ocean.addRipple(p.x, p.y, state.simTime);
  else ocean.setBuoy(p.x, p.y);
});
canvas.addEventListener('pointercancel', () => { press = null; });

// ---------- boot ----------
freshTrains();
state.qualityActual = autoQuality();
try {
  const { Ocean } = await import('./ocean.js');
  ocean = new Ocean(canvas, sea, state.qualityActual);
} catch (err) {
  console.error('WebGL initialisation failed:', err);
  ocean = null;
  ui.showNoGL();
}
compile();
ui.refresh();
ui.updateStats(0, 0);
window.addEventListener('resize', () => ocean && ocean.resize());

let lastWall = performance.now();
let lastDetect = 0, tipTimer = 0, qualityDrops = 0, warmup = performance.now();

function frame(wallNow) {
  const dt = Math.min((wallNow - lastWall) / 1000, 0.05);
  lastWall = wallNow;
  state.frames++;

  const frozen = wallNow < state.freezeUntil;
  ui.setFrozen(frozen);
  if (state.running && !frozen) state.simTime += dt * state.timeScale;
  const t = state.simTime;

  if (wallNow - lastDetect >= DETECT_MS) {
    lastDetect = wallNow;
    const best = detector.detect(t);
    state.Hmax = best.Hmax;
    state.ratio = sea.Hs > 0 ? best.Hmax / sea.Hs : 0;
    if (state.ratio >= ROGUE_RATIO && wallNow > state.cooldownUntil && state.running && !frozen) triggerRogue(best, state.ratio, wallNow);
    ui.updateStats(state.Hmax, state.ratio);
  }

  if (ocean) {
    ocean.frame(t, dt);
    ui.updateBeacon(wallNow, (x, h, y) => ocean.project(x, h, y));
    ui.updateBuoy(ocean.buoyState(t), wallNow);
    // one-way adaptive quality: step down if the GPU cannot keep up
    if (state.quality === 'auto' && qualityDrops < 2 && wallNow - warmup > 4000) {
      const mean = ocean.meanFrameTime();
      if (mean > 0.045 && state.qualityActual !== 'low') {
        state.qualityActual = state.qualityActual === 'high' ? 'med' : 'low';
        qualityDrops++;
        warmup = wallNow;
        ocean.setQuality(state.qualityActual);
        compile();
      }
    }
  }
  ui.draw2d(t, wallNow, state.Hmax);
  if (wallNow - tipTimer > 500) { tipTimer = wallNow; ui.updateTip(state.ratio); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// handle for automated checks
window.__sim = { state, sea, detector, actions, ui, get ocean() { return ocean; } };
