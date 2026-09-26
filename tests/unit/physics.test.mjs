// Unit tests for js/physics.js (pure maths, no DOM). Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Sea, Detector, scanWaves, defaultTrain, buildTrainComps, rippleEta,
  QUALITY, RIPPLE, TEX_W, TWO_PI, G, MAX_TRAINS,
} from '../../js/physics.js';

const QUALITIES = ['low', 'med', 'high'];

// The app's boot sea (main.js freshTrains + default state) at a given quality.
function defaultSea(q, over = {}) {
  return new Sea().compile({
    trains: [defaultTrain(0), defaultTrain(1)], dispersion: true,
    wind: 8, windDir: 20, steepness: 0.55, nAmbient: QUALITY[q].ambient, ...over,
  });
}

const close = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ± ${tol}, got ${actual}`);

test('default sea has H_s 2.875 and 14 + ambient components on every quality', () => {
  const expectedN = { low: 62, med: 110, high: 158 };
  for (const q of QUALITIES) {
    const sea = defaultSea(q);
    assert.equal(sea.n, expectedN[q], `sea.n on ${q}`);
    assert.equal(sea.n, 2 * 7 + QUALITY[q].ambient, `train + ambient count on ${q}`);
    assert.equal(sea.Hs.toFixed(3), '2.875', `H_s on ${q}`);
  }
});

test('H_s does not depend on quality at other winds', () => {
  for (const wind of [4, 12]) {
    const hs = QUALITIES.map(q => defaultSea(q, { wind }).Hs);
    const lo = Math.min(...hs), hi = Math.max(...hs);
    assert.ok(lo > 0, `H_s positive at ${wind} m/s`);
    assert.ok((hi - lo) / lo < 0.02, `H_s at ${wind} m/s varies by quality: ${hs.join(', ')}`);
    const amb = QUALITIES.map(q => defaultSea(q, { wind, trains: [] }).ambientHs);
    assert.ok((Math.max(...amb) - Math.min(...amb)) / Math.min(...amb) < 0.02, `ambient H_s at ${wind} m/s: ${amb.join(', ')}`);
  }
});

test('scanWaves charges each sample to one wave only', () => {
  // regression: the first sample below zero after a down-crossing used to be
  // counted as the trough of the wave that had just ended too (giving 5.5)
  const { Hmax, iCrest } = scanWaves([-2, -1, 1, 2.5, 1, -3, -2, 0.5, 1, 0.5, -0.1, -0.05]);
  assert.equal(Hmax, 4.5);
  assert.equal(iCrest, 3);
});

test('scanWaves on an empty profile finds no wave', () => {
  assert.deepEqual(scanWaves([]), { Hmax: 0, iCrest: 0 });
});

test('default sea fires exactly 14 events in 1200 s (15 s sea-time cooldown)', { timeout: 180_000 }, () => {
  const sea = defaultSea('med');
  const det = new Detector(sea, 8);
  let count = 0, last = -Infinity;
  for (let i = 0; i <= 1200 * 15; i++) {
    const t = i / 15;
    const ratio = det.detect(t).Hmax / sea.Hs;
    if (ratio >= 2 && t - last >= 15) { count++; last = t; }
  }
  assert.equal(count, 14);
});

test('a lone train focuses to its amplitude at (x0, y0, tf)', () => {
  for (const dispersion of [true, false]) {
    for (let i = 0; i < MAX_TRAINS; i++) {
      const tr = defaultTrain(i);
      const sea = new Sea().compile({ trains: [tr], dispersion, wind: 0 });
      assert.equal(sea.n, 7);
      close(sea.eta(tr.x0, tr.y0, tr.tf), tr.amp, 1e-9, `train ${i}, dispersion ${dispersion}:`);
      // Gaussian weights sum to one
      const sumA = buildTrainComps(tr, dispersion).reduce((s, c) => s + c.a, 0);
      close(sumA, tr.amp, 1e-12, `train ${i} Σa:`);
    }
  }
});

test('with dispersion on, every train component obeys k = ω²/g', () => {
  assert.equal(G, 9.81);
  const sea = new Sea().compile({ trains: Array.from({ length: MAX_TRAINS }, (_, i) => defaultTrain(i)), dispersion: true, wind: 8, nAmbient: 48 });
  assert.equal(sea.trainRange.length, MAX_TRAINS);
  for (const [start, count] of sea.trainRange) {
    assert.equal(count, 7);
    for (let i = start; i < start + count; i++) close(sea.k[i], sea.w[i] ** 2 / G, 1e-12 * sea.k[i], `component ${i}:`);
  }
  for (let i = sea.ambientStart; i < sea.n; i++) close(sea.k[i], sea.w[i] ** 2 / G, 1e-12 * sea.k[i], `ambient ${i}:`);
});

test('fillRow matches eta along an oblique line', () => {
  const sea = defaultSea('high');
  const th = 37 * Math.PI / 180, ex = Math.cos(th), ey = Math.sin(th);
  const nS = 240, ds = 3.3, x0 = -310, y0 = -140, t = 123.4;
  const out = sea.fillRow(new Float64Array(nS), nS, x0, y0, ex, ey, ds, t);
  for (let j = 0; j < nS; j++) close(out[j], sea.eta(x0 + j * ex * ds, y0 + j * ey * ds, t), 1e-9, `sample ${j}:`);
});

test('displaced() height equals eta without LOD or rim fades', () => {
  const sea = defaultSea('med');
  for (const [x, y, t] of [[0, 0, 0], [123.5, -80.25, 17.3], [-250, 140, 999.9]]) {
    close(sea.displaced(x, y, t, {}, 0, 1).h, sea.eta(x, y, t), 1e-9, `at (${x}, ${y}, ${t}):`);
  }
});

test('packPhases writes wrapped phases into row 1 for large t', () => {
  const sea = defaultSea('high');
  const t = 1e5;
  for (const Arr of [Float64Array, Float32Array]) {
    const data = new Arr(TEX_W * 2 * 4).fill(-7);
    sea.packPhases(data, t);
    const base = TEX_W * 4;
    for (let i = 0; i < TEX_W * 4; i++) assert.equal(data[i], -7, `row 0 untouched (${Arr.name})`);
    for (let i = 0; i < sea.n; i++) {
      const ph = data[base + i * 4];
      assert.ok(ph >= 0 && ph < TWO_PI, `${Arr.name} phase ${i} = ${ph}`);
      if (Arr === Float64Array) {
        // same angle as φ − ωt, modulo 2π
        close(Math.cos(ph), Math.cos(sea.phi[i] - sea.w[i] * t), 1e-6, `cos phase ${i}:`);
        close(Math.sin(ph), Math.sin(sea.phi[i] - sea.w[i] * t), 1e-6, `sin phase ${i}:`);
        close(data[base + i * 4 + 1], sea.a[i] * sea.k[i], 1e-15, `a·k ${i}:`);
      }
    }
  }
});

test('rippleEta: zero once a ripple is older than RIPPLE.LIFE, nonzero on a fresh ring', () => {
  const ripples = [{ x: 10, y: -20, t0: 5 }];
  assert.equal(rippleEta(ripples, 10 + RIPPLE.SPEED, -20, 5 + RIPPLE.LIFE + 0.01), 0);
  assert.equal(rippleEta(ripples, 10, -20, 4), 0, 'not yet dropped');
  // one second in, the ring has travelled RIPPLE.SPEED metres: sample on it
  const age = 1, d = RIPPLE.SPEED * age;
  const h = rippleEta(ripples, 10 + d, -20, 5 + age);
  close(h, RIPPLE.AMP * Math.exp(-age / 3.5) / Math.sqrt(1 + d / 25), 1e-12, 'crest height on the ring:');
  assert.ok(h > 0.5);
  assert.equal(rippleEta([], 0, 0, 0), 0);
});
