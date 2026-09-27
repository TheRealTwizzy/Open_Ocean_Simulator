// The water's small-scale look: the short-wave detail layer (the wind sea's
// spectrum continued below the mesh's ~16 m, as normals only) must leave a calm
// sea glassy, roughen it with the wind, fade with distance instead of aliasing,
// and break into whitecaps in the proportions whitecap surveys report.
// Run: npm run test:browser
//
// Every check compares two renders of one pinned frame on the same machine
// (a uniform toggled between them), never fixed colours.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { launch, newPage, open, waitFrames, collectConsole, onlyErrors, evalSim } from '../helpers/browser.mjs';

const T = { timeout: 180_000 };
let server, browser;

before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

const NEAR = { pos: [30, 14, 70], target: [0, 0, 0] };
const ORBIT = { pos: [285, 170, 450], target: [0, 0, 0] };

// Sets the wind, pins sea time and camera, and lets a loop frame repack the
// phases for the pinned time.
async function pin(page, wind, cam) {
  await evalSim(page, (sim, a) => {
    sim.state.wind = a.wind;
    sim.actions.rebuild();
    Object.assign(sim.state, { running: false, simTime: 40 });
    const o = sim.ocean;
    o.camera.position.set(...a.cam.pos);
    o.controls.target.set(...a.cam.target);
    o.controls.update();
  }, { wind, cam });
  await waitFrames(page, 2);
}

// Renders the pinned frame once per uniform setting (restoring the uniforms
// after) and returns per-setting statistics over row bands of the frame,
// given as fractions from the top: hf = mean |Δ| between horizontal and
// vertical neighbours; diffs[k] = mean |Δ| against setting 0 and the share of
// pixels that differ by more than 30 (summed over RGB).
function renderBands(sim, { settings, bands }) {
  const o = sim.ocean, u = o.uniforms, gl = o.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const saved = Object.fromEntries(Object.keys(Object.assign({}, ...settings)).map(k => [k, u[k].value]));
  const frames = settings.map(set => {
    for (const [k, v] of Object.entries(set)) u[k].value = v;
    o.renderer.render(o.scene, o.camera);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (const [k, v] of Object.entries(saved)) u[k].value = v;
    return px;
  });
  const at = (px, x, yTop) => { const i = ((h - 1 - yTop) * w + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  return bands.map(([top, bottom]) => {
    const y0 = Math.floor(top * h), y1 = Math.min(Math.floor(bottom * h), h - 2);
    return frames.map(px => {
      let hf = 0, d = 0, over = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = 0; x < w - 1; x++) {
        const c = at(px, x, y), r = at(px, x + 1, y), b = at(px, x, y + 1), c0 = at(frames[0], x, y);
        let s = 0;
        for (let k = 0; k < 3; k++) { hf += Math.abs(c[k] - r[k]) + Math.abs(c[k] - b[k]); s += Math.abs(c[k] - c0[k]); }
        d += s; if (s > 30) over++; n++;
      }
      return { hf: hf / n, diff: d / n, share: over / n };
    });
  });
}

test('a calm sea is glassy; the wind roughens it with short waves up close', T, async () => {
  const page = await newPage(browser, { width: 640, height: 400 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    const hf = {};
    for (const wind of [0, 8]) {
      await pin(page, wind, NEAR);
      assert.equal(await evalSim(page, sim => sim.ocean.uniforms.uDetailCount.value), wind ? 40 : 0);
      // the lower half of the frame is all water
      const [[stats]] = await evalSim(page, renderBands, { settings: [{}], bands: [[0.55, 1]] });
      hf[wind] = stats.hf;
    }
    assert.ok(hf[8] > 3 * hf[0], `fine detail at wind 8 vs 0: ${hf[8].toFixed(1)} vs ${hf[0].toFixed(1)}`);
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('the short-wave detail fades with distance instead of aliasing', T, async () => {
  const page = await newPage(browser, { width: 640, height: 400 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await pin(page, 8, ORBIT);
    // fog off in both renders, so it cannot hide what happens far out; the
    // horizon of the orbit preset sits about a quarter down the frame
    const noFog = { uFogNear: 1e6, uFogFar: 2e6 };
    const [far, near] = await evalSim(page, renderBands, {
      settings: [{ ...noFog, uDetailCount: 0 }, { ...noFog }],
      bands: [[0.27, 0.33], [0.8, 1]],
    });
    // far out the waves are too fine to resolve: they may only widen the sun's
    // lobe (a smooth change), never add pixel-to-pixel noise as aliasing would
    const gainFar = far[1].hf / far[0].hf, gainNear = near[1].hf / near[0].hf;
    assert.ok(gainNear > 2, `the detail adds fine structure up close (x${gainNear.toFixed(2)})`);
    assert.ok(gainFar < 1.3, `and no noise far out (x${gainFar.toFixed(2)})`);
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('whitecap cover follows the wind: ~0 at 3 m/s, ~0.5 % at 8, ~4 % at 15', T, async () => {
  const page = await newPage(browser, { width: 640, height: 400 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=med');
    await evalSim(page, sim => sim.actions.setQuality('med'));
    const cover = {};
    for (const wind of [3, 8, 15]) {
      await pin(page, wind, NEAR);
      const [[, off]] = await evalSim(page, renderBands, { settings: [{}, { uWhitecap: 0 }], bands: [[0.45, 1]] });
      cover[wind] = off.share;
    }
    const pct = x => (100 * x).toFixed(2) + ' %';
    // Monahan's fit gives ~0.02 %, 0.45 % and 4 % for these winds
    assert.ok(cover[3] < 0.003, `3 m/s: ${pct(cover[3])}`);
    assert.ok(cover[8] > 0.002 && cover[8] < 0.012, `8 m/s: ${pct(cover[8])}`);
    assert.ok(cover[15] > 0.02 && cover[15] < 0.08, `15 m/s: ${pct(cover[15])}`);
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});
