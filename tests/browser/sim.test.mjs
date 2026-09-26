// Browser specs for the simulation behaviour: rogue detection (alert, freeze,
// one count per wave), splash and buoy clicks, wheel zoom, the surface camera
// clearance, reduced motion, render quality / pixel ratio, HUD overlays that
// let clicks through, and the 2D drawer canvas. Run: npm run test:browser
//
// Everything waits on rendered frames (window.__sim.state.frames) or on state;
// SwiftShader takes 0.2-0.8 s per frame, so there are no sleeps for rendering.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import {
  launch, newPage, open, waitFrames, collectConsole, onlyErrors, clickDock, evalSim, waitSim, setViewport, primeRogue,
} from '../helpers/browser.mjs';

const T = { timeout: 180_000 };

let server, browser;

before(async () => {
  server = await startServer();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

// ---------- local helpers ----------

// Calls fn(sim, arg) in the page once after every rendered frame (polled
// between frames, so each sample sees the state one frame() left behind) and
// returns the samples. Stops after `frames` samples, or when
// until(samples, sim, arg) is truthy, or at `max`. fn/until follow the evalSim
// closure rule: pass test-side values through arg.
async function sampleFrames(page, fn, arg, { frames = 0, until = null, max = 80, timeout = 120_000 } = {}) {
  return page.evaluate(async ([fnSrc, untilSrc, a, nFrames, nMax, ms]) => {
    const ev = src => (0, eval)('(' + src + ')');
    const f = ev(fnSrc), stop = untilSrc ? ev(untilSrc) : null;
    const sim = window.__sim, out = [];
    const deadline = performance.now() + ms;
    let last = sim.state.frames;
    for (;;) {
      await new Promise(r => setTimeout(r, 4));
      if (sim.state.frames === last) {
        if (performance.now() > deadline) throw new Error(`sampleFrames: timed out after ${out.length} samples`);
        continue;
      }
      last = sim.state.frames;
      out.push(f(sim, a));
      if (nFrames && out.length >= nFrames) break;
      if (stop && stop(out, sim, a)) break;
      if (out.length >= nMax) break;
    }
    return out;
  }, [fn.toString(), until ? until.toString() : null, arg, frames, max, timeout]);
}

const camDistance = page => evalSim(page, sim => sim.ocean.camera.position.distanceTo(sim.ocean.controls.target));

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ui.js formatting of the buoy elevation readout
const etaText = eta => (eta >= 0 ? '+' : '') + eta.toFixed(2);

// ---------- rogue detection ----------

test('forced rogue event shows alert, beacon and count, and holds sea time during the 1.6 s freeze', T, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    const idle = await evalSim(page, () => ({
      alert: document.getElementById('alert').classList.contains('show'),
      beaconHidden: document.getElementById('beacon').hidden,
      frozen: document.getElementById('frozen').classList.contains('show'),
      count: document.getElementById('v-count').textContent,
    }));
    assert.deepEqual(idle, { alert: false, beaconHidden: true, frozen: false, count: '0' }, 'no alert before any event');

    const { t, ratio } = await primeRogue(page);
    const ev = await waitSim(page, sim => sim.state.rogueCount > 0 && sim.state.lastEvent);
    // restore time speed at once: from here on only the freeze may hold the sea still
    const snap = await evalSim(page, sim => {
      sim.state.timeScale = 2.5;
      const $ = id => document.getElementById(id);
      return {
        now: performance.now(), freezeUntil: sim.state.freezeUntil, cooldownUntil: sim.state.cooldownUntil,
        simTime: sim.state.simTime, rogueCount: sim.state.rogueCount,
        alert: $('alert').classList.contains('show'), alertSub: $('alert-sub').textContent,
        beaconHidden: $('beacon').hidden, beaconLeft: parseFloat($('beacon').style.left), beaconTop: parseFloat($('beacon').style.top),
        count: $('v-count').textContent, frozen: $('frozen').classList.contains('show'),
      };
    });

    assert.equal(ev.sim, t, 'event is stamped with the parked sea time');
    near(ev.ratio, ratio, 1e-9, 'event ratio matches the detector scan');
    assert.equal(snap.rogueCount, 1);
    assert.equal(snap.count, '1', '#v-count shows the new count');
    assert.equal(snap.alert, true, '#alert has class "show"');
    assert.match(snap.alertSub, new RegExp(ratio.toFixed(2).replace('.', '\\.') + ' × H_s'), 'alert text carries the ratio');
    assert.equal(snap.beaconHidden, false, '#beacon is unhidden');
    assert.ok(snap.beaconLeft > 0 && snap.beaconLeft < 800 && snap.beaconTop > 0 && snap.beaconTop < 600, 'beacon sits on screen');
    near(snap.freezeUntil - ev.wall, 1600, 1e-6, 'freeze lasts 1.6 s');
    near(snap.cooldownUntil - ev.wall, 6000, 1e-6, 'cooldown lasts 6 s');
    assert.ok(snap.now < snap.freezeUntil, 'still inside the freeze when checked');
    assert.equal(snap.simTime, t);
    // (#frozen is toggled at the start of frame(), before detection, so it
    // shows from the frame after the event: checked per frame below.)

    // Per frame until two frames have been sampled after the freeze ended (the
    // second of those frames certainly started after freezeUntil). A sample
    // taken at now < freezeUntil belongs to a frame that started even earlier,
    // so that frame was frozen.
    const samples = await sampleFrames(page, sim => ({
      now: performance.now(), freezeUntil: sim.state.freezeUntil, simTime: sim.state.simTime,
      frozenShown: document.getElementById('frozen').classList.contains('show'),
    }), null, { until: out => out.filter(s => s.now > s.freezeUntil).length >= 2, max: 60 });

    const during = samples.filter(s => s.now < s.freezeUntil);
    assert.ok(during.length >= 1, `sampled at least one frame inside the freeze (${samples.length} samples)`);
    for (const s of during) {
      assert.equal(s.simTime, t, 'sea time does not advance during the freeze even at time speed 2.5');
      assert.equal(s.frozenShown, true, '#frozen shown during the freeze');
    }
    const last = samples.at(-1);
    assert.equal(last.frozenShown, false, '#frozen hidden once the freeze is over');
    assert.ok(last.simTime > t, `sea time resumes after the freeze (${last.simTime} > ${t})`);
    assert.equal(await evalSim(page, sim => sim.state.rogueCount), 1, 'still one event');

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('at time speed 0 a parked rogue is counted once, even after the 6 s cooldown', T, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    const { t } = await primeRogue(page);
    await waitSim(page, sim => sim.state.rogueCount > 0);
    const f0 = await evalSim(page, sim => sim.state.frames);

    // time speed stays 0: wait out the wall-clock cooldown while frames keep rendering
    await waitSim(page, sim => performance.now() > sim.state.cooldownUntil + 100, null, { timeout: 90_000 });
    const samples = await sampleFrames(page, sim => ({
      count: sim.state.rogueCount, ratio: sim.state.ratio, running: sim.state.running, simTime: sim.state.simTime,
      frozen: performance.now() < sim.state.freezeUntil, pastCooldown: performance.now() > sim.state.cooldownUntil,
      countText: document.getElementById('v-count').textContent,
    }), null, { frames: 4 });

    const f1 = await evalSim(page, sim => sim.state.frames);
    assert.ok(f1 - f0 >= 8, `frames kept rendering through the cooldown (${f0} -> ${f1})`);
    for (const s of samples) {
      assert.equal(s.count, 1, 'the same wave is not counted again after the cooldown');
      assert.equal(s.countText, '1');
      assert.equal(s.simTime, t, 'sea time is parked');
      assert.ok(s.ratio >= 2, `the rogue is still under the detector (ratio ${s.ratio})`);
      assert.equal(s.running, true);
      assert.equal(s.frozen, false);
      assert.equal(s.pastCooldown, true);
    }

    // Control: detection is live and only the sea-time gap guard held it back.
    // Pretend the last event was 2 s of sea time ago and the parked wave counts again.
    await evalSim(page, sim => { sim.state.lastEvent.sim -= 2; });
    await waitSim(page, sim => sim.state.rogueCount === 2, null, { timeout: 30_000 });

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('a jump written to the sea time is scanned at the new time alone: the parked rogue counts once', T, async () => {
  // Sub-stepping 0.3 -> 860.405 s would scan 143 s apart, fire on a wave near
  // 573.7 s that was never on screen, then count the parked one after the cooldown.
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    const r0 = await evalSim(page, sim => {
      sim.state.timeScale = 0;
      sim.state.simTime = 0.3;
      return sim.detector.detect(0.3).Hmax / sim.sea.Hs;
    });
    await waitSim(page, (sim, r) => sim.state.ratio === r, r0);
    const target = 860.405;
    const ratio = await evalSim(page, (sim, t) => {
      sim.state.simTime = t;
      return sim.detector.detect(t).Hmax / sim.sea.Hs;
    }, target);
    assert.ok(ratio >= 2, `a rogue is parked at ${target} s (ratio ${ratio})`);

    const ev = await waitSim(page, sim => sim.state.lastEvent);
    assert.equal(ev.sim, target, 'the event is stamped with the sea time jumped to');
    near(ev.ratio, ratio, 1e-12, 'event ratio');

    await waitSim(page, sim => performance.now() > sim.state.cooldownUntil + 100, null, { timeout: 90_000 });
    const samples = await sampleFrames(page, sim => ({ count: sim.state.rogueCount, sim: sim.state.lastEvent.sim }), null, { frames: 4 });
    for (const s of samples) assert.deepEqual(s, { count: 1, sim: target }, 'still one event after the cooldown');

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('the frame loop fires on the best sub-step since the last scan while the stats show the sea at t', T, async () => {
  // One 8x frame span written by hand at time speed 0: scans at 860.34 s
  // (ratio 1.997) and 860.60 s (1.975) both miss the ~0.1 s window that peaks
  // at 2.002 between them; sub-steps 0.065 s apart catch it at 860.405 s.
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    const t0 = 860.34, t1 = 860.60;
    const r = await evalSim(page, (sim, [a, b]) => {
      Object.assign(sim.state, { timeScale: 0, autoFreeze: false, simTime: a });
      const ratio = t => sim.detector.detect(t).Hmax / sim.sea.Hs;
      return { a: ratio(a), b: ratio(b) };
    }, [t0, t1]);
    assert.ok(r.a < 2 && r.b < 2, `both ends miss (${r.a}, ${r.b})`);
    await waitSim(page, (sim, x) => sim.state.ratio === x, r.a);
    assert.equal(await evalSim(page, sim => sim.state.rogueCount), 0);

    await evalSim(page, (sim, t) => { sim.state.simTime = t; }, t1);
    // the event, if any, fires in the same scan that shows t1 in the stats
    await waitSim(page, (sim, x) => sim.state.ratio === x, r.b);
    const s = await evalSim(page, sim => {
      const ev = sim.state.lastEvent;
      return {
        count: sim.state.rogueCount, ev, simTime: sim.state.simTime, ratio: sim.state.ratio,
        evScan: ev && sim.detector.detect(ev.sim), Hs: sim.sea.Hs,
        ratioText: document.getElementById('v-ratio').textContent,
      };
    });
    assert.equal(s.count, 1, 'the window between the scans is counted');
    assert.ok(s.ev.sim > t0 && s.ev.sim < t1, `lastEvent.sim ${s.ev.sim} is the sub-step in (${t0}, ${t1})`);
    assert.ok(s.ev.ratio >= 2, `event ratio ${s.ev.ratio}`);
    near(s.ev.ratio, s.evScan.Hmax / s.Hs, 1e-12, 'event ratio is the scan at lastEvent.sim');
    assert.deepEqual([s.ev.xM, s.ev.yM, s.ev.eta], [s.evScan.xM, s.evScan.yM, s.evScan.eta], 'event crest is the scan at lastEvent.sim');
    assert.equal(s.simTime, t1, 'no auto-freeze: the sea stays at t');
    assert.ok(s.ratio < 2, `the stats show the scan at t (${s.ratio})`);
    assert.equal(s.ratioText, r.b.toFixed(2));

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('auto-freeze holds the sea at the sub-step that fired, so the stats and the rendered sea match the alert', T, async () => {
  // The span above with auto-freeze on: the alert reads 2.00 × H_s from the
  // 860.405 s sub-step, so the sea freezes there rather than at 860.60 s (1.975).
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    const t0 = 860.34, t1 = 860.60;
    const r0 = await evalSim(page, (sim, t) => {
      Object.assign(sim.state, { timeScale: 0, simTime: t });
      return sim.detector.detect(t).Hmax / sim.sea.Hs;
    }, t0);
    await waitSim(page, (sim, x) => sim.state.ratio === x, r0);
    assert.deepEqual(await evalSim(page, sim => [sim.state.autoFreeze, sim.state.rogueCount]), [true, 0]);

    await evalSim(page, (sim, t) => { sim.state.simTime = t; }, t1);
    // per frame from the one that fired (it renders too) until two frames later
    const samples = (await sampleFrames(page, sim => {
      const s = sim.state;
      return {
        ev: s.lastEvent, simTime: s.simTime, rendered: sim.ocean.simTime, ratio: s.ratio, Hs: sim.sea.Hs, Hmax: s.Hmax,
        ratioText: document.getElementById('v-ratio').textContent, alertSub: document.getElementById('alert-sub').textContent,
      };
    }, null, { until: out => out.filter(x => x.ev).length >= 3, max: 40 })).filter(x => x.ev);

    const ev = samples[0].ev;
    assert.ok(ev.sim > t0 && ev.sim < t1 && ev.ratio >= 2, `fired on a sub-step (${ev.sim}, ratio ${ev.ratio})`);
    assert.match(samples[0].alertSub, new RegExp(ev.ratio.toFixed(2).replace('.', '\\.') + ' × H_s'));
    for (const [i, x] of samples.entries()) {
      assert.equal(x.simTime, ev.sim, `frame ${i}: the sea is frozen at the event's sea time`);
      assert.equal(x.rendered, ev.sim, `frame ${i}: the ocean renders the event's sea time`);
      near(x.ratio, ev.ratio, 1e-12, `frame ${i}: the stats show the scan that fired`);
      near(x.Hmax, ev.ratio * x.Hs, 1e-9, `frame ${i}: H_max`);
      assert.equal(x.ratioText, ev.ratio.toFixed(2));
    }
    assert.equal(await evalSim(page, sim => sim.state.rogueCount), 1);

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('reset after an event hides the alert, the beacon and the count', T, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await primeRogue(page);
    await waitSim(page, sim => sim.state.rogueCount > 0);

    // check and press Reset in one task, so the 2.8 s auto-hide timer cannot interfere
    const r = await evalSim(page, sim => {
      const alert = document.getElementById('alert');
      const before = alert.classList.contains('show');
      document.getElementById('btn-reset').click();
      return {
        before, after: alert.classList.contains('show'),
        rogueCount: sim.state.rogueCount, lastEvent: sim.state.lastEvent, simTime: sim.state.simTime,
        timeScale: sim.state.timeScale, freezeUntil: sim.state.freezeUntil, cooldownUntil: sim.state.cooldownUntil,
      };
    });
    assert.equal(r.before, true, 'alert was showing before reset');
    assert.equal(r.after, false, 'reset hides the alert immediately');
    assert.deepEqual(
      { rogueCount: r.rogueCount, lastEvent: r.lastEvent, simTime: r.simTime, timeScale: r.timeScale, freezeUntil: r.freezeUntil, cooldownUntil: r.cooldownUntil },
      { rogueCount: 0, lastEvent: null, simTime: 0, timeScale: 2.5, freezeUntil: 0, cooldownUntil: 0 });

    await waitFrames(page, 2);
    const dom = await evalSim(page, sim => ({
      alert: document.getElementById('alert').classList.contains('show'),
      beaconHidden: document.getElementById('beacon').hidden,
      frozen: document.getElementById('frozen').classList.contains('show'),
      count: document.getElementById('v-count').textContent,
      rogueCount: sim.state.rogueCount,
    }));
    assert.deepEqual(dom, { alert: false, beaconHidden: true, frozen: false, count: '0', rogueCount: 0 }, 'alert stays hidden after reset');

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

// ---------- clicks on the water ----------

test('splash: a short click adds an active ripple at the picked point; a drag does not', T, async t => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    // pause: sea time is pinned, so pick() and two renders are comparable
    await evalSim(page, sim => { sim.actions.togglePause(); });
    await waitFrames(page, 1);
    const pre = await evalSim(page, sim => ({
      mode: sim.state.clickMode, running: sim.state.running, ripples: sim.ocean.ripples.length,
      active: sim.ocean.uniforms.uRipples.value.filter(v => v.w === 1).length,
    }));
    assert.deepEqual(pre, { mode: 'splash', running: false, ripples: 0, active: 0 });

    // baseline pixels around the click point; rendering twice must match exactly-ish
    const readRegion = sim => {
      const o = sim.ocean, r = o.renderer, gl = r.getContext(), pr = r.getPixelRatio(), S = 48;
      r.render(o.scene, o.camera);
      const x = Math.round(400 * pr - S / 2), y = Math.round(gl.drawingBufferHeight - 300 * pr - S / 2);
      const buf = new Uint8Array(S * S * 4);
      gl.readPixels(x, y, S, S, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };
    const diffSrc = `(a, b) => { let s = 0; for (let i = 0; i < a.length; i++) if (i % 4 !== 3) s += Math.abs(a[i] - b[i]); return s / (a.length * 3 / 4); }`;
    const control = await evalSim(page, (sim, o) => {
      const read = (0, eval)('(' + o.read + ')'), diff = (0, eval)('(' + o.diff + ')');
      window.__pxA = read(sim);
      return diff(window.__pxA, read(sim));
    }, { read: readRegion.toString(), diff: diffSrc });
    assert.ok(control < 0.5, `two renders of the paused sea match (mean diff ${control})`);

    await page.mouse.click(400, 300);
    await waitSim(page, sim => sim.ocean.ripples.length === 1);
    await waitFrames(page, 1);
    const hit = await evalSim(page, (sim, o) => {
      const read = (0, eval)('(' + o.read + ')'), diff = (0, eval)('(' + o.diff + ')');
      const oc = sim.ocean, p = oc.pick(400, 300), r = oc.ripples[0];
      const u = oc.uniforms.uRipples.value.map(v => [v.x, v.y, v.z, v.w]);
      return { p, r, u, simTime: sim.state.simTime, pixelDiff: diff(window.__pxA, read(sim)) };
    }, { read: readRegion.toString(), diff: diffSrc });
    assert.ok(hit.p, 'the centre of the view is on the water');
    near(hit.r.x, hit.p.x, 1e-6, 'ripple x at the picked point');
    near(hit.r.y, hit.p.y, 1e-6, 'ripple y at the picked point');
    assert.equal(hit.u[0][3], 1, 'uRipples[0].w === 1 (active)');
    near(hit.u[0][0], hit.p.x, 1e-3, 'uniform x');
    near(hit.u[0][1], hit.p.y, 1e-3, 'uniform y');
    near(hit.u[0][2], hit.simTime, 1e-3, 'uniform t0 is the sea time of the click');
    assert.deepEqual(hit.u.slice(1).map(v => v[3]), [0, 0, 0], 'other ripple slots inactive');
    t.diagnostic(`ripple pixel diff ${hit.pixelDiff.toFixed(2)} (control ${control.toFixed(2)})`);
    assert.ok(hit.pixelDiff > 2, `the ripple changes the rendered water around the click (mean diff ${hit.pixelDiff})`);

    // A drag must be rejected for its distance alone. Chrome dispatches
    // pointermove once per animation frame (~0.3 s here), so a stepped mouse
    // drag also trips the 400 ms hold rule; press and release 45 px apart
    // straight away instead (trusted CDP input, ~1 ms hold, no moves).
    const cdp = await page.context().newCDPSession(page);
    const pressRelease = async (x0, y0, x1, y1) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 });
    };
    const ripples = () => evalSim(page, sim => ({
      n: sim.ocean.ripples.length, active: sim.ocean.uniforms.uRipples.value.filter(v => v.w === 1).length,
    }));
    await pressRelease(300, 380, 345, 380);
    await waitFrames(page, 2);
    assert.deepEqual(await ripples(), { n: 1, active: 1 }, 'a 45 px drag does not add a ripple');

    // control: the same quick press/release within 6 px is a click and splashes
    await pressRelease(300, 380, 305, 380);
    await waitSim(page, sim => sim.ocean.ripples.length === 2, null, { timeout: 30_000 });
    await waitFrames(page, 1);
    assert.deepEqual(await ripples(), { n: 2, active: 2 }, 'a 5 px press/release is still a click');
    await cdp.detach();

    // and an ordinary stepped mouse drag orbits the camera without splashing
    const cam0 = await evalSim(page, sim => sim.ocean.camera.position.toArray());
    await page.mouse.move(300, 380);
    await page.mouse.down();
    await page.mouse.move(345, 380, { steps: 5 });
    await page.mouse.up();
    await waitFrames(page, 2);
    const drag = await evalSim(page, sim => ({
      ripples: sim.ocean.ripples.length,
      active: sim.ocean.uniforms.uRipples.value.filter(v => v.w === 1).length,
      cam: sim.ocean.camera.position.toArray(),
    }));
    const moved = Math.hypot(...drag.cam.map((v, i) => v - cam0[i]));
    assert.ok(moved > 0.5, `the drag reached the canvas and orbited the camera (${moved.toFixed(2)} m)`);
    assert.equal(drag.ripples, 2, 'a mouse drag does not add a ripple');
    assert.equal(drag.active, 2, 'still exactly two active ripple uniforms');

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('buoy: click places it, mesh and readout follow buoyState, a second click moves it and resets the history', T, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    const mode = await evalSim(page, sim => {
      sim.actions.setClickMode('buoy');
      sim.actions.togglePause();
      return {
        clickMode: sim.state.clickMode, running: sim.state.running,
        btnBuoy: document.getElementById('btn-click').classList.contains('buoy'),
        crosshair: document.getElementById('gl').classList.contains('crosshair'),
        visible: sim.ocean.buoyMesh.visible, readoutHidden: document.getElementById('buoy-readout').hidden,
      };
    });
    assert.deepEqual(mode, { clickMode: 'buoy', running: false, btnBuoy: true, crosshair: true, visible: false, readoutHidden: true });
    await waitFrames(page, 1);

    // --- place at A (paused: pick() is reproducible) ---
    await page.mouse.click(400, 300);
    await waitSim(page, sim => !!sim.ocean.buoy);
    await waitFrames(page, 1);
    const a = await evalSim(page, sim => {
      const o = sim.ocean, b = o.buoyState(sim.state.simTime);
      return {
        buoy: o.buoy, pick: o.pick(400, 300), visible: o.buoyMesh.visible, ripples: o.ripples.length,
        mesh: o.buoyMesh.position.toArray(), b,
        readoutHidden: document.getElementById('buoy-readout').hidden,
        etaText: document.getElementById('buoy-eta').textContent,
      };
    });
    assert.ok(a.pick, 'click point is on the water');
    near(a.buoy.x, a.pick.x, 1e-6, 'buoy x at the picked point');
    near(a.buoy.y, a.pick.y, 1e-6, 'buoy y at the picked point');
    assert.equal(a.visible, true, 'buoyMesh visible');
    assert.equal(a.ripples, 0, 'buoy mode does not splash');
    assert.equal(a.readoutHidden, false, '#buoy-readout unhidden');
    assert.match(a.etaText, /^[+-]\d+\.\d{2}$/, '#buoy-eta is numeric');
    assert.equal(a.etaText, etaText(a.b.eta), '#buoy-eta shows buoyState().eta');
    near(a.mesh[1], a.b.h - 0.5, 1e-9, 'mesh height from buoyState().h');
    near(a.mesh[0], a.b.x, 1e-9, 'mesh x from buoyState().x');
    near(a.mesh[2], a.b.z, 1e-9, 'mesh z from buoyState().z');

    // --- run the sea: the mesh follows buoyState(t).h every frame ---
    await evalSim(page, sim => { sim.state.timeScale = 8; sim.actions.togglePause(); });
    const t0 = await evalSim(page, sim => sim.state.simTime);
    const run = await sampleFrames(page, sim => {
      const o = sim.ocean, b = o.buoyState(sim.state.simTime);
      return {
        t: sim.state.simTime, meshY: o.buoyMesh.position.y, h: b.h, eta: b.eta,
        etaText: document.getElementById('buoy-eta').textContent,
      };
    }, t0, { until: (out, sim, start) => out.length >= 4 && out.at(-1).t - start >= 5, max: 60 });
    for (const s of run) {
      near(s.meshY, s.h - 0.5, 1e-9, `mesh height follows buoyState at t=${s.t}`);
      assert.equal(s.etaText, etaText(s.eta), `readout follows buoyState at t=${s.t}`);
    }
    const ys = run.map(s => s.meshY);
    assert.ok(Math.max(...ys) - Math.min(...ys) > 0.05, 'the buoy rides the moving sea');

    // --- pause, then move it to B: history restarts from the new point ---
    await evalSim(page, sim => sim.actions.togglePause());
    await waitFrames(page, 1);
    const hist = await evalSim(page, () => ({
      max: document.getElementById('buoy-max').textContent, min: document.getElementById('buoy-min').textContent,
    }));
    assert.notEqual(hist.max, hist.min, `12 s history has a range before moving (${hist.min}..${hist.max})`);

    await page.mouse.click(560, 380);
    await waitSim(page, (sim, ax) => sim.ocean.buoy && sim.ocean.buoy.x !== ax, a.buoy.x);
    await waitFrames(page, 1);
    const b = await evalSim(page, sim => {
      const o = sim.ocean, st = o.buoyState(sim.state.simTime);
      return {
        buoy: o.buoy, pick: o.pick(560, 380), mesh: o.buoyMesh.position.toArray(), st, visible: o.buoyMesh.visible,
        max: document.getElementById('buoy-max').textContent, min: document.getElementById('buoy-min').textContent,
        etaText: document.getElementById('buoy-eta').textContent,
      };
    });
    near(b.buoy.x, b.pick.x, 1e-6, 'buoy moved to the new picked x');
    near(b.buoy.y, b.pick.y, 1e-6, 'buoy moved to the new picked y');
    assert.ok(Math.hypot(b.buoy.x - a.buoy.x, b.buoy.y - a.buoy.y) > 20, 'buoy moved');
    assert.equal(b.visible, true);
    near(b.mesh[0], b.st.x, 1e-9, 'mesh x at the new buoy');
    near(b.mesh[2], b.st.z, 1e-9, 'mesh z at the new buoy');
    near(b.mesh[1], b.st.h - 0.5, 1e-9, 'mesh height at the new buoy');
    assert.equal(b.etaText, etaText(b.st.eta), '#buoy-eta at the new buoy');
    assert.equal(b.max, b.st.eta.toFixed(1), 'history reset: max is the single new sample');
    assert.equal(b.min, b.st.eta.toFixed(1), 'history reset: min is the single new sample');

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

// ---------- camera ----------

test('mouse wheel over the canvas zooms in (deltaY < 0) and out (deltaY > 0)', T, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    assert.equal(await evalSim(page, () => document.elementFromPoint(400, 300).id), 'gl', 'canvas under the pointer');
    const d0 = await camDistance(page);

    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, -400);
    const d1 = await waitSim(page, (sim, d) => {
      const o = sim.ocean, x = o.camera.position.distanceTo(o.controls.target);
      return x < d - 1 && x;
    }, d0);
    // OrbitControls: scale 0.95^(zoomSpeed · |deltaY| / 100) = 0.95^2.8 ≈ 0.866
    assert.ok(d1 < d0 * 0.95 && d1 > d0 * 0.7, `wheel up zooms in (${d0.toFixed(1)} -> ${d1.toFixed(1)} m)`);
    const tgt = await evalSim(page, sim => sim.ocean.controls.target.toArray());
    assert.deepEqual(tgt, [0, 0, 0], 'zoom keeps the orbit target');

    await page.mouse.wheel(0, 400);
    const d2 = await waitSim(page, (sim, d) => {
      const o = sim.ocean, x = o.camera.position.distanceTo(o.controls.target);
      return x > d + 1 && x;
    }, d1);
    assert.ok(d2 > d1 * 1.05, `wheel down zooms out (${d1.toFixed(1)} -> ${d2.toFixed(1)} m)`);

    await waitFrames(page, 2);
    near(await camDistance(page), d2, 0.5, 'zoom holds across frames');
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('surface camera renders >= 2.5 m above the sea and its stored height does not creep', T, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    const started = await evalSim(page, sim => {
      sim.actions.setCamera('surface');
      return { preset: sim.state.cameraPreset, transition: !!sim.ocean.transition, pressed: document.querySelector('#pop-camera [data-cam="surface"]').getAttribute('aria-pressed') };
    });
    assert.deepEqual(started, { preset: 'surface', transition: true, pressed: 'true' });
    await waitSim(page, sim => sim.ocean.transition === null, null, { timeout: 120_000 });
    const arrived = await evalSim(page, sim => ({ p: sim.ocean.camera.position.toArray(), t: sim.ocean.controls.target.toArray(), enabled: sim.ocean.controls.enabled }));
    near(arrived.p[0], -46, 0.5, 'surface preset x');
    near(arrived.p[2], 160, 0.5, 'surface preset z');
    assert.ok(arrived.p[1] > 6 && arrived.p[1] < 8.5, `surface preset height (${arrived.p[1]})`);
    assert.deepEqual(arrived.t, [0, 1.5, 0]);
    assert.equal(arrived.enabled, true, 'controls re-enabled after the transition');

    // big sea, and zoom in so the orbit height (~2.4 m) sits inside the crests
    const hs = await evalSim(page, sim => { sim.state.wind = 14; sim.actions.rebuild(); return sim.sea.Hs; });
    assert.ok(hs > 3, `wind 14 raises H_s (${hs})`);
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, -5300);
    await waitSim(page, sim => sim.ocean.camera.position.distanceTo(sim.ocean.controls.target) < 40);
    await waitFrames(page, 2);

    // record the stored height around each frame and the height actually rendered
    await evalSim(page, sim => {
      const o = sim.ocean, cam = o.camera, r = o.renderer;
      window.__cam = { stored: [], rendered: [] };
      const frame = o.frame, render = r.render;
      o.frame = function (t, dt) {
        const before = cam.position.y;
        const res = frame.call(this, t, dt);
        window.__cam.stored.push({ before, after: cam.position.y });
        return res;
      };
      r.render = function (scene, camera) {
        if (camera === cam) {
          const p = cam.position;
          window.__cam.rendered.push({ y: p.y, surf: sim.sea.eta(p.x, p.z, o.simTime), ripples: o.ripples.length });
        }
        return render.call(this, scene, camera);
      };
    });
    // park the sea on the tallest crest under the camera, then let it run through it
    const crest = await evalSim(page, sim => {
      const p = sim.ocean.camera.position;
      let best = { t: 0, eta: -Infinity };
      for (let t = 0; t <= 60; t += 0.05) { const e = sim.sea.eta(p.x, p.z, t); if (e > best.eta) best = { t, eta: e }; }
      sim.state.timeScale = 0;
      sim.state.simTime = best.t;
      return { ...best, y: p.y };
    });
    assert.ok(crest.eta + 2.5 > crest.y + 0.5, `a crest (${crest.eta.toFixed(2)} m) needs the camera (y ${crest.y.toFixed(2)}) lifted`);
    await waitFrames(page, 4);
    await evalSim(page, (sim, t) => { sim.state.simTime = t - 1.5; sim.state.timeScale = 2.5; }, crest.t);
    await waitFrames(page, 14);

    const rec = await evalSim(page, sim => ({ ...window.__cam, y: sim.ocean.camera.position.y }));
    assert.ok(rec.rendered.length >= 18, `rendered ${rec.rendered.length} frames`);
    for (const r of rec.rendered) {
      assert.equal(r.ripples, 0);
      assert.ok(r.y >= r.surf + 2.5 - 1e-6, `rendered camera ${r.y.toFixed(3)} m is >= 2.5 m above the sea ${r.surf.toFixed(3)} m`);
    }
    const y0 = rec.stored[0].before;
    for (const s of rec.stored) near(s.after, y0, 0.01, 'stored camera height between frames does not creep');
    near(rec.y, y0, 0.01, 'stored camera height at the end');
    // lifted: rendered higher than the height stored when the frame began
    const lifted = rec.rendered.filter((r, i) => r.y > rec.stored[i].before + 0.1).length;
    assert.ok(lifted >= 4, `the clearance lift was exercised (${lifted} lifted renders)`);

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('reduced motion: camera presets jump straight to the preset (no transition)', T, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const r = await evalSim(page, sim => {
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      sim.actions.setCamera('surface');
      const o = sim.ocean;
      return { reduce, transition: o.transition, enabled: o.controls.enabled, p: o.camera.position.toArray(), t: o.controls.target.toArray() };
    });
    assert.equal(r.reduce, true);
    assert.equal(r.transition, null, 'no transition under reduced motion');
    assert.equal(r.enabled, true);
    // OrbitControls clamps the polar angle, which lifts y from 7 to ~7.33
    near(r.p[0], -46, 0.2, 'x at the surface preset immediately');
    near(r.p[1], 7, 0.5, 'y at the surface preset immediately');
    near(r.p[2], 160, 0.2, 'z at the surface preset immediately');
    assert.deepEqual(r.t, [0, 1.5, 0]);

    await waitFrames(page, 2);
    const held = await evalSim(page, sim => ({ transition: sim.ocean.transition, p: sim.ocean.camera.position.toArray() }));
    assert.equal(held.transition, null);
    for (let i = 0; i < 3; i++) near(held.p[i], r.p[i], 0.05, 'camera stays at the preset');

    const back = await evalSim(page, sim => { sim.actions.setCamera('orbit'); return { transition: sim.ocean.transition, p: sim.ocean.camera.position.toArray() }; });
    assert.equal(back.transition, null);
    near(back.p[0], 285, 0.5, 'orbit x'); near(back.p[1], 170, 0.5, 'orbit y'); near(back.p[2], 450, 0.5, 'orbit z');

    // control: without the preference the same switch animates
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const anim = await evalSim(page, sim => { sim.actions.setCamera('surface'); return { transition: !!sim.ocean.transition, p: sim.ocean.camera.position.toArray() }; });
    assert.equal(anim.transition, true, 'animated transition without reduced motion');
    near(anim.p[0], 285, 0.5, 'camera has not jumped yet');

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

// ---------- render quality ----------

test('quality: low then auto re-arms auto quality and its step-down', T, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    // pin the core count so autoQuality picks 'high' at 800x600, DPR 1 on every machine
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8, configurable: true }));
    await open(page, server.url, '');
    // replica of main.js autoQuality(), evaluated with the page's own inputs
    const expectedAuto = await page.evaluate(() => {
      const q = new URLSearchParams(location.search).get('q');
      if (q) return 'override:' + q;
      if (matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600) return 'low';
      return (navigator.hardwareConcurrency || 4) >= 8 && (devicePixelRatio || 1) <= 1.5 ? 'high' : 'med';
    });
    assert.equal(expectedAuto, 'high');
    const boot = await evalSim(page, sim => ({ quality: sim.state.quality, actual: sim.state.qualityActual, segs: sim.ocean.mesh.geometry.parameters.segments }));
    assert.deepEqual(boot, { quality: 'auto', actual: 'high', segs: 384 });

    // The step-down needs a full 60-frame window of frame times (~1.3 s per
    // frame here at med/high). Top the window up with slow (50 ms, the cap)
    // samples so the real frame() logic decides within its 4 s warm-up instead.
    const fillWindow = () => evalSim(page, sim => {
      for (let i = 0; i < 59; i++) sim.ocean.frameTimes.push(0.05);
      return sim.ocean.frameTimes.length;
    });
    const waitActual = q => waitSim(page, (sim, q) => sim.state.qualityActual === q && {
      quality: sim.state.quality, at: performance.now(), frames: sim.state.frames,
      segs: sim.ocean.mesh.geometry.parameters.segments, frameTimes: sim.ocean.frameTimes.length,
    }, q, { timeout: 90_000 });

    // use up both automatic steps: high -> med -> low
    assert.ok(await fillWindow() >= 59);
    assert.equal((await waitActual('med')).quality, 'auto');
    assert.ok(await fillWindow() >= 59);
    const exhausted = await waitActual('low');
    assert.deepEqual({ quality: exhausted.quality, segs: exhausted.segs }, { quality: 'auto', segs: 160 });

    const low = await evalSim(page, sim => {
      sim.actions.setQuality('low');
      return { quality: sim.state.quality, actual: sim.state.qualityActual, segs: sim.ocean.mesh.geometry.parameters.segments, select: document.getElementById('s-quality').value };
    });
    assert.deepEqual(low, { quality: 'low', actual: 'low', segs: 160, select: 'low' });
    await waitFrames(page, 2);
    assert.ok(await evalSim(page, sim => sim.ocean.frameTimes.length) >= 2, 'frame times accumulate');

    const auto = await evalSim(page, sim => {
      sim.actions.setQuality('auto');
      return {
        quality: sim.state.quality, actual: sim.state.qualityActual, frameTimes: sim.ocean.frameTimes.length,
        oceanQ: sim.ocean.quality, segs: sim.ocean.mesh.geometry.parameters.segments,
        select: document.getElementById('s-quality').value, at: performance.now(),
      };
    });
    assert.deepEqual(
      { quality: auto.quality, actual: auto.actual, frameTimes: auto.frameTimes, oceanQ: auto.oceanQ, segs: auto.segs, select: auto.select },
      { quality: 'auto', actual: 'high', frameTimes: 0, oceanQ: 'high', segs: 384, select: 'auto' },
      'auto re-resolves via autoQuality and clears the frame-time window');

    // Both automatic steps were used up above, so this drop can only happen if
    // setQuality('auto') reset the step-down budget and its warm-up.
    assert.ok(await fillWindow() >= 59);
    const drop = await waitActual('med');
    assert.equal(drop.quality, 'auto');
    assert.equal(drop.segs, 256, 'mesh rebuilt at med');
    assert.ok(drop.frameTimes < 30, `window restarted after the step (${drop.frameTimes} samples)`);
    assert.ok(drop.at - auto.at >= 4000, `step-down waited for the fresh 4 s warm-up (${Math.round(drop.at - auto.at)} ms)`);

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('quality: pixel-ratio cap follows the preset at deviceScaleFactor 2 and survives a resize', T, async () => {
  const page = await newPage(browser, { width: 400, height: 300, deviceScaleFactor: 2 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    const read = () => evalSim(page, sim => {
      const c = document.getElementById('gl');
      return { dpr: devicePixelRatio, pr: sim.ocean.renderer.getPixelRatio(), w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight };
    });
    const check = (s, cap, label) => {
      const pr = Math.min(s.dpr, cap);
      assert.equal(s.pr, pr, `${label}: pixel ratio min(devicePixelRatio, ${cap})`);
      assert.equal(s.w, Math.floor(s.cw * pr), `${label}: canvas width`);
      assert.equal(s.h, Math.floor(s.ch * pr), `${label}: canvas height`);
    };
    const s0 = await read();
    assert.equal(s0.dpr, 2);
    check(s0, 1, 'low');
    assert.equal(s0.w, 400);

    await evalSim(page, sim => sim.actions.setQuality('high'));
    const s1 = await read();
    check(s1, 2, 'high');
    assert.equal(s1.w, 800);
    await waitFrames(page, 1);

    await evalSim(page, sim => sim.actions.setQuality('med'));
    check(await read(), 1.5, 'med');

    await evalSim(page, sim => sim.actions.setQuality('high'));
    await setViewport(page, 360, 280);
    const s2 = await read();
    check(s2, 2, 'high after resize');
    assert.equal(s2.w, 720);

    await evalSim(page, sim => sim.actions.setQuality('low'));
    const s3 = await read();
    check(s3, 1, 'back to low');
    assert.equal(s3.w, 360);

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

// ---------- HUD ----------

test('HUD overlays (#hint, #alert, #frozen, #beacon) let clicks through to the canvas', T, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    // look down on the sea so every overlay sits over water; hold the sea and
    // show every overlay from the frame loop's own state
    await evalSim(page, sim => {
      const o = sim.ocean;
      o.camera.position.set(0, 600, 200);
      o.controls.target.set(0, 0, 0);
      o.controls.update();
      sim.state.freezeUntil = performance.now() + 600_000;
      sim.state.lastEvent = { xM: 150, yM: 60, eta: 0, ratio: 2.01, wall: performance.now() + 600_000, sim: sim.state.simTime };
      sim.ui.hideAlert();
      document.getElementById('alert-sub').textContent = 'H = 5.8 m · 2.01 × H_s · at (150, 60) m';
      document.getElementById('alert').classList.add('show');
    });
    // the hint fades on its own 7 s after boot; wait for that, then bring it back for good
    await page.waitForFunction(() => document.getElementById('hint').classList.contains('fade'), null, { timeout: 30_000, polling: 100 });
    await evalSim(page, () => document.getElementById('hint').classList.remove('fade'));
    await waitFrames(page, 2);

    let expected = 0;
    for (const id of ['hint', 'alert', 'frozen', 'beacon']) {
      const info = await evalSim(page, (sim, id) => {
        const el = document.getElementById(id), cs = getComputedStyle(el), r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hitNone = document.elementFromPoint(x, y);
        el.style.pointerEvents = 'auto';
        const hitAuto = document.elementFromPoint(x, y);
        el.style.pointerEvents = '';
        return {
          pe: cs.pointerEvents, display: cs.display, visibility: cs.visibility, hidden: el.hidden, w: r.width, h: r.height, x, y,
          hitNone: hitNone && hitNone.id, coversPoint: !!hitAuto && el.contains(hitAuto),
        };
      }, id);
      assert.equal(info.pe, 'none', `#${id} has pointer-events: none`);
      assert.ok(!info.hidden && info.display !== 'none' && info.visibility === 'visible' && info.w > 0 && info.h > 0, `#${id} is showing (${JSON.stringify(info)})`);
      assert.equal(info.coversPoint, true, `#${id} is the top element at its centre when it takes pointer events`);
      assert.equal(info.hitNone, 'gl', `hit-testing at #${id} reaches the canvas`);

      await page.mouse.click(info.x, info.y);
      expected++;
      await waitSim(page, (sim, n) => sim.ocean.ripples.length === n, expected, { timeout: 30_000 });
    }
    const still = await evalSim(page, () => ['alert', 'frozen'].map(id => document.getElementById(id).classList.contains('show')).concat(!document.getElementById('beacon').hidden));
    assert.deepEqual(still, [true, true, true], 'overlays stayed up while clicked through');

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('2D drawer canvas fits its slot at DPR 2 and is not reallocated every frame', T, async () => {
  const page = await newPage(browser, { deviceScaleFactor: 2 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    assert.equal(await page.isVisible('#drawer'), false);
    await clickDock(page, '#btn-2d');
    await page.locator('#drawer').waitFor({ state: 'visible' });
    assert.equal(await page.getAttribute('#btn-2d', 'aria-pressed'), 'true');
    await waitFrames(page, 2);

    // count every write to the canvas size (each one reallocates and clears the bitmap)
    await evalSim(page, () => {
      const c = document.getElementById('sea2d');
      window.__sizeWrites = [];
      for (const k of ['width', 'height']) {
        const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, k);
        Object.defineProperty(c, k, {
          configurable: true,
          get() { return d.get.call(this); },
          set(v) { window.__sizeWrites.push([k, v]); d.set.call(this, v); },
        });
      }
    });
    const size = () => evalSim(page, () => {
      const c = document.getElementById('sea2d'), dpr = Math.min(devicePixelRatio, 2);
      return { dpr, w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, ew: Math.round(c.clientWidth * dpr), eh: Math.round(c.clientHeight * dpr) };
    });
    const s0 = await size();
    assert.equal(s0.dpr, 2);
    assert.ok(s0.cw > 100 && s0.ch > 50, `canvas has a slot (${s0.cw}x${s0.ch})`);
    assert.equal(s0.w, s0.ew, 'width = round(clientWidth * min(dpr, 2))');
    assert.equal(s0.h, s0.eh, 'height = round(clientHeight * min(dpr, 2))');

    const samples = await sampleFrames(page, () => {
      const c = document.getElementById('sea2d');
      return { w: c.width, h: c.height, writes: window.__sizeWrites.length };
    }, null, { frames: 5 });
    for (const s of samples) assert.deepEqual(s, { w: s0.w, h: s0.h, writes: 0 }, 'no size writes while drawing frames');

    // the 2D view is drawn: the bitmap is not empty
    const painted = await evalSim(page, () => {
      const c = document.getElementById('sea2d'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n / (d.length / 4);
    });
    assert.ok(painted > 0.2, `2D view painted (${(painted * 100).toFixed(1)}% of pixels)`);

    // control: a real resize is picked up once (so the write counter works), then it is quiet again
    await setViewport(page, 720, 560);
    const s1 = await size();
    assert.notEqual(s1.w, s0.w, 'resize changes the canvas width');
    assert.equal(s1.w, s1.ew);
    assert.equal(s1.h, s1.eh);
    const writes1 = await evalSim(page, () => window.__sizeWrites.length);
    assert.ok(writes1 >= 1 && writes1 <= 2, `resize wrote the size once per axis at most (${writes1})`);
    await waitFrames(page, 3);
    assert.equal(await evalSim(page, () => window.__sizeWrites.length), writes1, 'no further size writes after the resize');

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});
