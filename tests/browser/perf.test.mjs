// The measuring aids for the shader's zero-weight skips: ?noskip must render
// exactly the image the default shader renders (the skips only drop work whose
// result is multiplied by zero), and ?fps must show the frame time, the
// quality and whether the skips are on, keeping GPU timer queries until they
// report however many frames that takes.
// Run: npm run test:browser
//
// The pixel check pins the sea and camera in two pages, one per shader, renders
// synchronously and reads the drawing buffer back in the same task.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { launch, newPage, open, waitFrames, collectConsole, onlyErrors, evalSim } from '../helpers/browser.mjs';

const T = { timeout: 180_000 };
let server, browser;

before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

const VIEWS = [
  { name: 'orbit', t: 23.5, pos: [285, 170, 450], target: [0, 0, 0] },
  { name: 'surface', t: 41.2, pos: [-46, 7, 160], target: [0, 1.5, 0] },
  // far out, grazing across the rim, so the flat far plane and the distance cut-offs are on screen
  { name: 'far', t: 12.8, pos: [1430, 120, 180], target: [0, 0, 0] },
];

// Pins the sea and camera, lets one loop frame repack the component phases for
// the pinned time, then renders and returns the drawing buffer as base64.
async function pinnedFrame(page, view) {
  await evalSim(page, (sim, v) => {
    Object.assign(sim.state, { running: false, simTime: v.t });
    const o = sim.ocean;
    o.camera.position.set(...v.pos);
    o.controls.target.set(...v.target);
    o.controls.update();
  }, view);
  await waitFrames(page, 2);
  return evalSim(page, sim => {
    const o = sim.ocean, gl = o.renderer.getContext();
    o.renderer.render(o.scene, o.camera);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let bin = '';
    for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode(...px.subarray(i, i + 0x8000));
    return { w, h, b64: btoa(bin) };
  });
}

test('?noskip renders the same image as the default shader, in orbit, surface and far views', T, async () => {
  const pages = {}, logs = {};
  try {
    for (const [key, query] of [['skip', '?q=low'], ['noskip', '?q=low&noskip']]) {
      pages[key] = await newPage(browser, { width: 480, height: 320 });
      logs[key] = collectConsole(pages[key]);
      await open(pages[key], server.url, query);
    }
    // the two pages really run different shaders
    assert.deepEqual(await evalSim(pages.skip, sim => sim.ocean.mesh.material.defines), { SKIP_ZERO: 1 });
    assert.deepEqual(await evalSim(pages.noskip, sim => sim.ocean.mesh.material.defines), {});
    assert.deepEqual(await evalSim(pages.noskip, sim => sim.ocean.farMesh.material.defines), { FLAT: 1 });

    for (const view of VIEWS) {
      const a = await pinnedFrame(pages.skip, view), b = await pinnedFrame(pages.noskip, view);
      assert.deepEqual([a.w, a.h], [b.w, b.h]);
      const pa = Buffer.from(a.b64, 'base64'), pb = Buffer.from(b.b64, 'base64');
      let maxDiff = 0, over1 = 0, lit = 0;
      for (let i = 0; i < pa.length; i++) {
        const d = Math.abs(pa[i] - pb[i]);
        if (d > maxDiff) maxDiff = d;
        if (d > 1) over1++;
        if (pa[i] > 8) lit++;
      }
      assert.ok(lit > pa.length / 8, `${view.name}: the frame is actually drawn (${lit} lit channels)`);
      assert.ok(maxDiff <= 1 && over1 === 0, `${view.name}: max channel diff ${maxDiff}, ${over1} channels off by more than 1`);
    }
    assert.deepEqual(onlyErrors(logs.skip), []);
    assert.deepEqual(onlyErrors(logs.noskip), []);
  } finally {
    for (const p of Object.values(pages)) await p.close();
  }
});

test('?fps shows the frame time, the quality and whether the skips are on; hidden without it', T, async () => {
  for (const [query, skips] of [['?q=low&fps', 'on'], ['?q=low&fps&noskip', 'off']]) {
    const page = await newPage(browser, { width: 640, height: 480 });
    const log = collectConsole(page);
    try {
      await open(page, server.url, query);
      const text = await (await page.waitForFunction(() => {
        const el = document.getElementById('perf');
        return !el.hidden && el.textContent;
      }, null, { timeout: 60_000 })).jsonValue();
      const m = text.match(new RegExp(`^low · skips ${skips} · (\\d+\\.\\d) ms \\((\\d+) fps\\) · GPU (n/a|…|\\d+\\.\\d\\d ms)$`));
      assert.ok(m, `readout format: "${text}"`);
      const ms = parseFloat(m[1]);
      assert.ok(ms > 0 && Math.abs(Number(m[2]) - 1000 / ms) <= 1, `fps matches the frame time: "${text}"`);
      // the GPU field follows whether the timer extension exists in this browser
      const hasTimer = await evalSim(page, sim => !!sim.ocean.gpuTimer);
      assert.equal(m[3] === 'n/a', !hasTimer, `GPU field "${m[3]}" vs timer ${hasTimer}`);
      assert.deepEqual(onlyErrors(log), []);
    } finally {
      await page.close();
    }
  }

  const page = await newPage(browser, { width: 640, height: 480 });
  try {
    await open(page, server.url, '?q=low');
    await waitFrames(page, 3);
    assert.equal(await page.evaluate(() => document.getElementById('perf').hidden), true);
    assert.equal(await evalSim(page, sim => sim.ocean.gpuTimer), null);
  } finally {
    await page.close();
  }
});

// A stand-in EXT_disjoint_timer_query_webgl2 (SwiftShader exposes none) whose
// results take `latency` frames to arrive and always read 3.25 ms. Counts
// queries deleted before their result was available.
function fakeGpuTimer(latency) {
  const TIME_ELAPSED = 0x88BF, DISJOINT = 0x8FBB, AVAILABLE = 0x8867, RESULT = 0x8866;
  let frame = 0, active = null;
  const tick = () => { frame++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__fake = { droppedEarly: 0, maxPending: 0, pending: 0 };
  const P = WebGL2RenderingContext.prototype, orig = { ...Object.fromEntries(
    ['getExtension', 'getParameter', 'createQuery', 'beginQuery', 'endQuery', 'getQueryParameter', 'deleteQuery'].map(k => [k, P[k]])) };
  const fakes = new WeakSet();
  P.getExtension = function (name) {
    return name === 'EXT_disjoint_timer_query_webgl2' ? { TIME_ELAPSED_EXT: TIME_ELAPSED, GPU_DISJOINT_EXT: DISJOINT } : orig.getExtension.call(this, name);
  };
  P.getParameter = function (p) { return p === DISJOINT ? false : orig.getParameter.call(this, p); };
  P.createQuery = function () { const q = { end: Infinity }; fakes.add(q); return q; };
  P.beginQuery = function (target, q) { if (target !== TIME_ELAPSED) return orig.beginQuery.call(this, target, q); active = q; };
  P.endQuery = function (target) {
    if (target !== TIME_ELAPSED) return orig.endQuery.call(this, target);
    active.end = frame;
    const f = window.__fake;
    f.maxPending = Math.max(f.maxPending, ++f.pending);
  };
  P.getQueryParameter = function (q, p) {
    if (!fakes.has(q)) return orig.getQueryParameter.call(this, q, p);
    return p === AVAILABLE ? frame >= q.end + latency : p === RESULT ? 3.25e6 : null;
  };
  P.deleteQuery = function (q) {
    if (!fakes.has(q)) return orig.deleteQuery.call(this, q);
    if (frame < q.end + latency) window.__fake.droppedEarly++;
    window.__fake.pending--;
  };
}

test('?fps keeps GPU timer queries until they report, even when results lag 12 frames', T, async () => {
  const page = await newPage(browser, { width: 640, height: 480 });
  const log = collectConsole(page);
  try {
    await page.addInitScript(fakeGpuTimer, 12);
    await open(page, server.url, '?q=low&fps');
    assert.ok(await evalSim(page, sim => !!sim.ocean.gpuTimer), 'the stand-in timer is picked up');
    await page.waitForFunction(() => /GPU 3\.25 ms$/.test(document.getElementById('perf').textContent), null, { timeout: 90_000 });
    const fake = await page.evaluate(() => window.__fake);
    assert.equal(fake.droppedEarly, 0, 'no query is deleted before its result arrives');
    assert.ok(fake.maxPending <= 8, `at most 8 queries in flight (${fake.maxPending})`);
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});
