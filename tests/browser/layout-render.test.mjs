// Layout and render checks in a real browser: the phone layouts (bottom sheets,
// HUD blocks that must not collide, the short-landscape rules), the no-WebGL
// fallback, and three pixel checks on pinned frames: no foam speckle at
// steepness 0, the far plane never drawing inside the displaced mesh, and the
// sky (and its reflection on the water) surviving a WebGL context loss, with a
// quality switch after the restore that logs no WebGL warnings.
// Run: npm run test:browser
//
// Pixel checks pause the sea, pin its time, render synchronously in the page
// and read the drawing buffer back in the same task. They compare two renders
// on the same machine instead of fixed colours.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { launch, newPage, open, waitFrames, collectConsole, onlyErrors, clickDock, evalSim, waitSim, setViewport } from '../helpers/browser.mjs';

const T = { timeout: 180_000 };
const POPS = [
  ['pop-trains', '[data-pop="pop-trains"]'],
  ['pop-settings', '[data-pop="pop-settings"]'],
  ['pop-click', '#btn-click'],
  ['pop-camera', '[data-pop="pop-camera"]'],
  ['pop-physics', '[data-pop="pop-physics"]'],
];

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

// ---------- local helpers: layout ----------

// Waits until every finite CSS animation (dock rise, sheet/popover entry,
// drawer entry, button ping) has finished. The infinite ones (bob, caustic)
// only wobble a few px and are ignored.
async function settle(page) {
  try {
    await page.waitForFunction(() => document.getAnimations()
      .filter(a => a.animationName && a.effect && a.effect.getComputedTiming().iterations !== Infinity)
      .every(a => a.playState === 'finished'), null, { timeout: 30_000, polling: 50 });
  } catch (err) {
    assert.fail('CSS entry animations did not finish: ' + err.message.split('\n')[0]);
  }
}

// Moves the mouse to the top-right corner (canvas or backdrop, never a dock
// button) and waits until no dock tooltip is showing.
async function unhover(page) {
  const { W } = await page.evaluate(() => ({ W: innerWidth }));
  await page.mouse.move(W - 4, 4);
  await page.waitForFunction(() => [...document.querySelectorAll('#dock .tip')].every(t => getComputedStyle(t).opacity === '0'),
    null, { timeout: 30_000, polling: 50 });
}

// Bounding boxes (CSS px, transforms included) of the HUD blocks that are
// rendered, and each dock button on its own (they fan out in an arc, so their
// union would be mostly empty space).
const hudBlocks = page => page.evaluate(() => {
  const shown = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
  const box = el => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const blocks = {};
  for (const [name, sel] of [['brand', '.brand'], ['stats', '#stats'], ['buoy', '#buoy-readout'], ['hint', '#hint'], ['nogl', '#nogl'], ['drawer', '#drawer']]) {
    const el = document.querySelector(sel);
    if (shown(el)) blocks[name] = box(el);
  }
  document.querySelectorAll('#dock .dock-btn').forEach((b, i) => { blocks['dock' + i] = box(b); });
  return { blocks, W: innerWidth, H: innerHeight };
});

const pick = (blocks, names) => Object.fromEntries(Object.entries(blocks).filter(([k]) => names.some(n => k === n || (n === 'dock' && /^dock\d$/.test(k)))));
const fmt = b => `[${b.l.toFixed(1)}, ${b.t.toFixed(1)} .. ${b.r.toFixed(1)}, ${b.b.toFixed(1)}]`;

// Pairs of blocks whose boxes intersect by more than `tol` px both ways. The
// tolerance absorbs sub-pixel touching (the brand ends at 70.25 px, the stats
// start at 70 px on phones).
function collisions(blocks, tol = 1) {
  const names = Object.keys(blocks), bad = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = blocks[names[i]], b = blocks[names[j]];
    const w = Math.min(a.r, b.r) - Math.max(a.l, b.l), h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    if (w > tol && h > tol) bad.push(`${names[i]} ${fmt(a)} overlaps ${names[j]} ${fmt(b)}`);
  }
  return bad;
}

function offscreen(blocks, W, H, tol = 0.5) {
  return Object.entries(blocks)
    .filter(([, b]) => b.l < -tol || b.t < -tol || b.r > W + tol || b.b > H + tol)
    .map(([k, b]) => `${k} ${fmt(b)} leaves the ${W}x${H} viewport`);
}

// Every rendered, non-transparent element in the HUD whose visible part
// (clipped by its scrolling/clipping ancestors) reaches past the left or right
// edge of the viewport. The HUD is position: fixed, so it never shows up in
// document.scrollWidth; this sweep is what actually catches a spill.
const horizontalSpill = page => page.evaluate(() => {
  const out = [];
  const opacity = el => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  for (const el of document.querySelectorAll('#hud *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (getComputedStyle(el).visibility === 'hidden' || opacity(el) < 0.05) continue;
    let l = r.left, rt = r.right;
    for (let a = el.parentElement; a && a.id !== 'hud'; a = a.parentElement) {
      if (getComputedStyle(a).overflowX !== 'visible') { const ar = a.getBoundingClientRect(); l = Math.max(l, ar.left); rt = Math.min(rt, ar.right); }
    }
    if (rt - l <= 0) continue;
    if (l < -0.5 || rt > innerWidth + 0.5) out.push(`${name(el)} spans x ${l.toFixed(1)}..${rt.toFixed(1)}`);
  }
  return out;
});

async function assertNoSpill(page, when) {
  const s = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, W: innerWidth }));
  assert.ok(s.doc <= s.W, `${when}: document.documentElement.scrollWidth ${s.doc} > innerWidth ${s.W}`);
  assert.ok(s.body <= s.W, `${when}: document.body.scrollWidth ${s.body} > innerWidth ${s.W}`);
  assert.deepEqual(await horizontalSpill(page), [], `${when}: HUD elements reach past the viewport edges`);
}

// Pauses the sea (so no rogue alert pops up mid-measurement) and moors a buoy,
// as a buoy-mode click would, then waits for the readout to appear.
async function pauseWithBuoy(page) {
  await evalSim(page, sim => { sim.state.running = false; sim.ui.resetBuoyHistory(); sim.ocean.setBuoy(20, 10); });
  await waitSim(page, () => !document.getElementById('buoy-readout').hidden);
}

const sparkline = page => page.evaluate(() => {
  const c = document.getElementById('buoy-spark');
  return { display: getComputedStyle(c).display, h: c.getBoundingClientRect().height };
});

// ---------- local helpers: pixels ----------

// Installed with page.addInitScript before open(). grab() renders the scene
// once and reads the drawing buffer back in the same task, flipped so row 0 is
// the top of the frame. Rows and columns are drawing-buffer pixels.
function pixelKit() {
  const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
  const toBuffer = (o, sy) => sy * o.renderer.getContext().drawingBufferHeight / o.canvas.clientHeight;
  window.__px = {
    grab() {
      const o = window.__sim.ocean, gl = o.renderer.getContext();
      o.renderer.render(o.scene, o.camera);
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const raw = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      const px = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) px.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
      return { W, H, px };
    },
    // row of the sea horizon: a sea-level point 30 km out along the view direction
    horizonRow() {
      const o = window.__sim.ocean, c = o.camera.position, t = o.controls.target;
      const dx = t.x - c.x, dz = t.z - c.z, L = Math.hypot(dx, dz);
      return toBuffer(o, o.project(c.x + dx / L * 30000, 0, c.z + dz / L * 30000).sy);
    },
    // lowest on-screen row of the displaced mesh's outer edge (the footprint is
    // |x|, |z| <= uRim); everything below it is inside the footprint
    rimRow() {
      const o = window.__sim.ocean, R = o.uniforms.uRim.value, cw = o.canvas.clientWidth, ch = o.canvas.clientHeight;
      let best = -Infinity;
      for (let s = -R; s <= R; s += 20) {
        for (const [x, z] of [[s, -R], [s, R], [-R, s], [R, s]]) {
          const p = o.project(x, 0, z);
          if (p && p.sx >= 0 && p.sx <= cw && p.sy >= 0 && p.sy <= ch) best = Math.max(best, p.sy);
        }
      }
      return toBuffer(o, best);
    },
    // mean colour and luminance over rows [y0, y1) and columns [x0, x1)
    mean(img, y0, y1, x0 = 0, x1 = img.W) {
      const s = [0, 0, 0, 0];
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * img.W + x) * 4;
        s[0] += img.px[i]; s[1] += img.px[i + 1]; s[2] += img.px[i + 2]; s[3] += lum(img.px, i); n++;
      }
      const [r, g, b, l] = s.map(v => v / n);
      return { r, g, b, lum: l, n };
    },
    // pixels whose largest channel difference exceeds tol, and the mean
    // absolute channel difference, over rows [y0, y1) and columns [x0, x1)
    diff(a, b, y0, y1, x0 = 0, x1 = a.W, tol = 0) {
      let count = 0, max = 0, sum = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * a.W + x) * 4;
        const d = Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 1] - b.px[i + 1]), Math.abs(a.px[i + 2] - b.px[i + 2]));
        if (d > tol) count++;
        if (d > max) max = d;
        sum += Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]) + Math.abs(a.px[i + 2] - b.px[i + 2]);
        n += 3;
      }
      return { count, max, meanAbs: sum / n };
    },
  };
}

// Foam in the lower half of the current pinned frame: pixels that are
// near-white (min channel >= 100, channel spread <= 40; foam lands at ~110-140
// grey after tone mapping) in the app's render but not in a reference render
// with the fold (Jacobian) foam term switched off. uFoamJ edges of (2, 3) are
// out of reach because fold = clamp(1 - J, 0, 1). Sun glitter, sky
// reflections and crest-height foam are identical in both renders, so they
// cancel out. `changed` counts pixels that differ by more than 8 levels at all.
const foamPixels = page => evalSim(page, sim => {
  const J = sim.ocean.uniforms.uFoamJ.value, kit = window.__px;
  const edges = [J.x, J.y];
  const img = kit.grab();
  J.set(2, 3);
  const ref = kit.grab();
  J.set(edges[0], edges[1]);
  const { W, H } = img;
  const nearWhite = (p, i) => {
    const mn = Math.min(p[i], p[i + 1], p[i + 2]);
    return mn >= 100 && Math.max(p[i], p[i + 1], p[i + 2]) - mn <= 40;
  };
  let white = 0, changed = 0;
  for (let i = (H >> 1) * W * 4; i < W * H * 4; i += 4) {
    if (nearWhite(img.px, i) && !nearWhite(ref.px, i)) white++;
    if (Math.max(Math.abs(img.px[i] - ref.px[i]), Math.abs(img.px[i + 1] - ref.px[i + 1]), Math.abs(img.px[i + 2] - ref.px[i + 2])) > 8) changed++;
  }
  return { edges, white, changed, steepness: sim.state.steepness, Q: sim.sea.Q };
});

// ---------- phone layouts ----------

test('375x812: nothing spills sideways, and every popover opens as a full-width bottom sheet', T, async () => {
  const page = await newPage(browser, { width: 375, height: 812 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await evalSim(page, sim => { sim.state.running = false; });
    await settle(page);
    await assertNoSpill(page, 'at rest');

    // the full-width buoy readout and the 2D drawer (8 px gutters) on screen as well
    await pauseWithBuoy(page);
    await clickDock(page, '#btn-2d');
    await unhover(page);
    assert.equal(await evalSim(page, sim => sim.ui.isDrawerOpen()), true, 'the 2D drawer opened');
    await settle(page);
    await assertNoSpill(page, 'with the buoy readout and the 2D drawer open');
    await clickDock(page, '#btn-2d');
    await unhover(page);
    assert.equal(await evalSim(page, sim => sim.ui.isDrawerOpen()), false, 'the 2D drawer closed');

    for (const [id, sel] of POPS) {
      await clickDock(page, sel);
      await unhover(page);
      await settle(page);
      const s = await page.evaluate(pid => {
        const el = document.getElementById(pid), r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        const bd = document.getElementById('backdrop');
        return {
          hidden: el.hidden, l: r.left, r: r.right, t: r.top, b: r.bottom,
          radii: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
          borderBottom: cs.borderBottomWidth, transform: cs.transform,
          backdrop: !bd.hidden && getComputedStyle(bd).display !== 'none',
          W: innerWidth, H: innerHeight,
        };
      }, id);
      assert.equal(s.hidden, false, `#${id} is open`);
      assert.ok(Math.abs(s.l) <= 0.5 && Math.abs(s.r - s.W) <= 0.5, `#${id} spans the full width (x ${s.l}..${s.r} of ${s.W})`);
      assert.ok(Math.abs(s.b - s.H) <= 0.5, `#${id} is anchored to the bottom edge (bottom ${s.b} of ${s.H})`);
      assert.ok(s.t >= 0 && s.b - s.t <= 0.74 * s.H + 1, `#${id} starts on screen and is at most 74vh tall (y ${s.t}..${s.b})`);
      assert.deepEqual(s.radii, ['18px', '18px', '0px', '0px'], `#${id} has rounded top corners only`);
      assert.equal(s.borderBottom, '0px', `#${id} has no bottom border`);
      assert.ok(s.transform === 'none' || s.transform === 'matrix(1, 0, 0, 1, 0, 0)', `#${id} is not shifted by the desktop translateX(-50%) (${s.transform})`);
      assert.equal(s.backdrop, true, `the backdrop dims the scene behind #${id}`);
      await assertNoSpill(page, `with #${id} open`);

      await page.mouse.click(s.W - 4, 4);            // lands on the backdrop, which closes the sheet
      await page.waitForFunction(pid => document.getElementById(pid).hidden && document.getElementById('backdrop').hidden, id, { timeout: 30_000, polling: 50 });
    }
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('320x568, 375x812 and 390x844: the dock fits and its tooltips stay on screen when shown', T, async () => {
  const page = await newPage(browser, { width: 320, height: 568 });
  try {
    await open(page, server.url, '?q=low');
    const spill = [];
    for (const [w, h] of [[320, 568], [375, 812], [390, 844]]) {
      if (w !== 320) await setViewport(page, w, h);
      await settle(page);
      await unhover(page);
      const { blocks, W, H } = await hudBlocks(page);
      spill.push(...offscreen(pick(blocks, ['dock']), W, H).map(c => `${w}x${h}: ${c}`));
      spill.push(...collisions(pick(blocks, ['dock'])).map(c => `${w}x${h}: ${c}`));
      const n = await page.locator('#dock .dock-btn').count();
      for (let i = 0; i < n; i++) {
        await page.locator('#dock .dock-btn').nth(i).hover({ force: true });
        await page.waitForFunction(k => getComputedStyle(document.querySelectorAll('#dock .dock-btn')[k].nextElementSibling).opacity === '1',
          i, { timeout: 30_000, polling: 50 });
        const tip = await page.evaluate(k => {
          const t = document.querySelectorAll('#dock .dock-btn')[k].nextElementSibling, r = t.getBoundingClientRect();
          return { text: t.textContent.trim(), l: r.left, r: r.right, W: innerWidth };
        }, i);
        if (tip.l < -0.5 || tip.r > tip.W + 0.5) spill.push(`${w}x${h}: "${tip.text}" spans x ${tip.l.toFixed(1)}..${tip.r.toFixed(1)} of ${tip.W}`);
      }
    }
    assert.deepEqual(spill, []);
    // a mouse still has a Space key: the hint stays
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#btn-pause + .tip kbd')).display), 'inline');
  } finally {
    await page.close();
  }
});

test('touch screen: dock tooltips drop the Space key hint', T, async () => {
  const page = await newPage(browser, { width: 390, height: 844, hasTouch: true, isMobile: true });
  try {
    await open(page, server.url, '?q=low');
    const kbd = () => page.evaluate(() => getComputedStyle(document.querySelector('#btn-pause + .tip kbd')).display);
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true, 'a coarse pointer');
    assert.equal(await kbd(), 'none');
    // setPaused() rewrites the label and its <kbd>
    await evalSim(page, sim => sim.actions.togglePause());
    assert.equal(await page.textContent('#btn-pause + .tip'), 'Resume space');
    assert.equal(await kbd(), 'none', 'still hidden after the pause label changes');
  } finally {
    await page.close();
  }
});

test('390x844 portrait: brand, stats, buoy readout, hint and dock do not collide and stay on screen', T, async () => {
  const page = await newPage(browser, { width: 390, height: 844 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await pauseWithBuoy(page);
    await settle(page);
    const { blocks, W, H } = await hudBlocks(page);
    // the hint is measured whether or not its 7 s fade has run: its box is what matters while it shows
    assert.deepEqual(Object.keys(blocks).filter(k => !k.startsWith('dock')).sort(), ['brand', 'buoy', 'hint', 'stats']);
    assert.equal(Object.keys(blocks).filter(k => k.startsWith('dock')).length, 7, 'seven dock buttons');
    assert.deepEqual(collisions(blocks), []);
    assert.deepEqual(offscreen(blocks, W, H), []);

    // taller than 480 px: the readout is the full-width strip under the stats and keeps its sparkline
    assert.ok(Math.abs(blocks.buoy.l - 16) <= 0.5 && Math.abs(blocks.buoy.r - (W - 16)) <= 0.5, `buoy readout spans 16..${W - 16} (${fmt(blocks.buoy)})`);
    assert.ok(blocks.buoy.t >= blocks.stats.b, 'buoy readout sits below the stats');
    const spark = await sparkline(page);
    assert.equal(spark.display, 'block', 'sparkline shown');
    assert.ok(spark.h >= 40, `sparkline is ~46 px tall (${spark.h})`);
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('844x390 landscape: the hint is hidden, the buoy readout moves top-right without its sparkline, nothing collides', T, async () => {
  const page = await newPage(browser, { width: 844, height: 390 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await pauseWithBuoy(page);
    await settle(page);
    const { blocks, W, H } = await hudBlocks(page);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('hint')).display), 'none', 'hint hidden at <= 480 px height');
    assert.deepEqual(Object.keys(blocks).filter(k => !k.startsWith('dock')).sort(), ['brand', 'buoy', 'stats']);
    assert.deepEqual(collisions(blocks), []);
    assert.deepEqual(offscreen(blocks, W, H), []);

    const b = blocks.buoy;
    assert.ok(Math.abs(b.r - (W - 16)) <= 0.5, `buoy readout is right-aligned with a 16 px gutter (${fmt(b)})`);
    assert.ok(Math.abs(b.t - 90) <= 0.5, `buoy readout is at top: 90px (${fmt(b)})`);
    assert.ok(b.l > W / 2, `buoy readout is on the right half (${fmt(b)})`);
    assert.ok(b.t >= blocks.stats.b, 'buoy readout sits below the stats');
    const spark = await sparkline(page);
    assert.equal(spark.display, 'none', 'no sparkline at <= 480 px height');
    assert.ok(b.b - b.t < 80, `readout is compact without the sparkline (${(b.b - b.t).toFixed(1)} px tall)`);
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

// ---------- no WebGL ----------

test('no WebGL: the fallback panel fits in portrait and at 844x390, the 2D drawer opens and draws, only the WebGL failure is logged', T, async () => {
  const page = await newPage(browser, { width: 390, height: 844 });
  const log = collectConsole(page);
  try {
    // open() installs an init script that makes getContext('webgl' | 'webgl2' | 'experimental-webgl') return null
    await open(page, server.url, '?q=low', { nogl: true });
    assert.equal(await evalSim(page, sim => sim.ocean), null, 'no ocean without WebGL');
    assert.equal(await evalSim(page, sim => sim.ui.isDrawerOpen()), true, 'the 2D drawer opened by itself');
    assert.equal(await page.getAttribute('#btn-2d', 'aria-pressed'), 'true');
    assert.equal(await page.textContent('#v-hs'), '2.88', 'the stats still run on the CPU');

    for (const [w, h] of [[390, 844], [844, 390]]) {
      if (w !== 390) await setViewport(page, w, h);
      else await waitFrames(page, 2);
      await settle(page);
      const where = `${w}x${h}`;
      const { blocks, W, H } = await hudBlocks(page);
      assert.ok(blocks.nogl && blocks.drawer, `${where}: #nogl and #drawer are rendered`);
      assert.equal(await page.isVisible('#nogl h2'), true, `${where}: the panel heading shows`);
      assert.deepEqual(offscreen(pick(blocks, ['nogl', 'drawer', 'dock']), W, H), [], `${where}: panel, drawer and dock stay inside the viewport`);
      const names = ['nogl', 'drawer', 'dock', 'brand', 'stats'];
      assert.deepEqual(collisions(pick(blocks, names)), [], `${where}: no collisions among ${names.join(', ')}`);
      if (h <= 480) assert.equal(await page.isVisible('#nogl p'), false, `${where}: the explanation is dropped on a short viewport`);

      const drawn = await page.evaluate(() => {
        const c = document.getElementById('sea2d'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return { w: c.width, h: c.height, frac: n / (c.width * c.height) };
      });
      assert.ok(drawn.w > 100 && drawn.h > 50, `${where}: the 2D canvas has a real size (${drawn.w}x${drawn.h})`);
      assert.ok(drawn.frac > 0.3, `${where}: the 2D view is drawn (${(drawn.frac * 100).toFixed(0)}% of pixels painted)`);
    }

    const errors = onlyErrors(log);
    assert.deepEqual(errors.filter(e => e.type === 'pageerror'), [], 'no uncaught page errors');
    const expected = [/^THREE\.WebGLRenderer: Error creating WebGL context\./, /^WebGL initialisation failed: /];
    assert.deepEqual(errors.filter(e => !expected.some(re => re.test(e.text))), [], 'only the logged WebGL failure');
    for (const re of expected) assert.ok(errors.some(e => re.test(e.text)), `logged: ${re}`);
  } finally {
    await page.close();
  }
});

// At 320 px tall the 2D drawer (top at H - 270) reaches up over the brand and
// the stats, whatever the panel does; there only the panel's own collisions
// are checked. From 630 px wide the stats move up beside the brand, clear of
// the drawer, so every pair is checked.
test('no WebGL on short landscapes: the fallback panel leaves the brand, stats, drawer and dock uncovered', T, async () => {
  const page = await newPage(browser, { width: 844, height: 390 });
  try {
    await open(page, server.url, '?q=low', { nogl: true });
    const bad = [];
    for (const [w, h] of [[844, 390], [740, 360], [667, 375], [812, 375], [640, 360], [630, 360], [616, 360], [610, 360], [568, 320], [480, 320]]) {
      if (w !== 844) await setViewport(page, w, h);
      await settle(page);
      const { blocks, W, H } = await hudBlocks(page);
      const where = `${w}x${h}`;
      assert.ok(blocks.nogl, `${where}: #nogl is rendered`);
      assert.equal(await page.isVisible('#nogl h2'), true, `${where}: the panel heading shows`);
      if (w >= 630) bad.push(...collisions(pick(blocks, ['nogl', 'brand', 'stats', 'drawer', 'dock'])).map(c => `${where}: ${c}`));
      else for (const other of ['brand', 'stats', 'drawer', 'dock']) bad.push(...collisions(pick(blocks, ['nogl', other])).map(c => `${where}: ${c}`));
      bad.push(...offscreen(pick(blocks, ['nogl', 'drawer', 'dock']), W, H).map(c => `${where}: ${c}`));
    }
    assert.deepEqual(bad, []);
  } finally {
    await page.close();
  }
});

// Between 481 and ~631 px tall the desktop panel (top: 22%) used to cover the
// top of the 2D drawer, which opens by itself without WebGL.
test('no WebGL at mid heights: the fallback panel clears the brand, stats, drawer and dock', T, async () => {
  const page = await newPage(browser, { width: 800, height: 600 });
  try {
    await open(page, server.url, '?q=low', { nogl: true });
    const bad = [];
    for (const [w, h] of [[800, 600], [800, 481], [800, 540], [1280, 631], [1024, 590], [760, 620]]) {
      if (w !== 800 || h !== 600) await setViewport(page, w, h);
      await settle(page);
      const { blocks, W, H } = await hudBlocks(page);
      const where = `${w}x${h}`;
      assert.ok(blocks.nogl && blocks.drawer, `${where}: #nogl and #drawer are rendered`);
      assert.equal(await page.isVisible('#nogl h2'), true, `${where}: the panel heading shows`);
      bad.push(...collisions(pick(blocks, ['nogl', 'brand', 'stats', 'drawer', 'dock'])).map(c => `${where}: ${c}`));
      bad.push(...offscreen(pick(blocks, ['nogl', 'drawer', 'dock']), W, H).map(c => `${where}: ${c}`));
    }
    assert.deepEqual(bad, []);
    // tall enough: the full panel, explanation included
    await setViewport(page, 800, 600);
    await settle(page);
    assert.equal(await page.isVisible('#nogl p'), true, '800x600: the explanation shows');
  } finally {
    await page.close();
  }
});

// ---------- pixels ----------

test('steepness 0 renders no foam speckle, while 0.55 foams on a focused crest', T, async () => {
  const page = await newPage(browser, { width: 640, height: 480 });
  const log = collectConsole(page);
  await page.addInitScript(pixelKit);
  try {
    await open(page, server.url, '?q=low');

    // the default sea (wind 8, two trains) flattened to steepness 0
    await evalSim(page, sim => { sim.state.running = false; sim.state.simTime = 30; sim.state.steepness = 0; sim.actions.rebuild(); });
    await waitFrames(page, 2);                       // the loop repacks Q·a and Q·a·k for the new steepness
    const calm = await foamPixels(page);
    assert.equal(calm.Q, 0, 'no Gerstner displacement at steepness 0');
    assert.ok(calm.edges[1] - calm.edges[0] >= 0.01, `foam smoothstep edges stay apart at steepness 0 (${calm.edges})`);
    assert.ok(calm.white <= 10 && calm.changed <= 10, `default sea at steepness 0: no foam speckle (${JSON.stringify(calm)})`);

    // One focused train and no wind: at its focus the fold reaches ~0.55 against
    // the 0.396 foam threshold at steepness 0.55, while the crest stays under
    // H_s (~0.91 H_s), so crest-height foam is out of play. The focus is moved
    // between the orbit target and the camera, into the lower half of the frame.
    await evalSim(page, sim => {
      const s = sim.state, c = sim.ocean.camera.position;
      s.wind = 0;
      s.trains[1].on = false;
      s.trains[0].x0 = 0.4 * c.x;
      s.trains[0].y0 = 0.4 * c.z;
      s.steepness = 0.55;
      sim.actions.rebuild();
      s.simTime = s.trains[0].tf;
    });
    await waitFrames(page, 2);
    const steep = await foamPixels(page);
    assert.ok(steep.white >= 100, `steepness 0.55 foams on the focused crest (${JSON.stringify(steep)})`);

    await evalSim(page, sim => { sim.state.steepness = 0; sim.actions.rebuild(); });
    await waitFrames(page, 2);
    const flat = await foamPixels(page);
    assert.ok(flat.edges[1] - flat.edges[0] >= 0.01, `foam smoothstep edges stay apart at steepness 0 (${flat.edges})`);
    assert.ok(flat.white <= 10 && flat.changed <= 10,
      `same focus at steepness 0: ~no near-white foam pixels (${flat.white}, against ${steep.white} at 0.55; ${JSON.stringify(flat)})`);

    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('the far plane never draws inside the displaced mesh footprint (wind 14, orbit camera)', T, async () => {
  const page = await newPage(browser, { width: 640, height: 480 });
  const log = collectConsole(page);
  await page.addInitScript(pixelKit);
  try {
    await open(page, server.url, '?q=low');
    await evalSim(page, sim => { sim.state.running = false; sim.state.wind = 14; sim.actions.rebuild(); sim.state.simTime = 40; });
    await waitFrames(page, 2);
    const r = await evalSim(page, sim => {
      const o = sim.ocean, kit = window.__px, far = o.farMesh;
      const hz = kit.horizonRow(), rim = kit.rimRow();
      far.visible = true;
      const withFar = kit.grab();
      far.visible = false;
      const noFar = kit.grab();
      far.visible = true;
      // control: the same far plane without its footprint discard
      const m = far.material;
      const leaky = new m.constructor({ uniforms: { ...o.uniforms, uRim: { value: 0 } }, vertexShader: m.vertexShader, fragmentShader: m.fragmentShader, defines: { ...m.defines } });
      far.material = leaky;
      const leak = kit.grab();
      far.material = m;
      leaky.dispose();
      const { W, H } = withFar, y0 = Math.ceil(rim) + 8;
      return {
        preset: sim.state.cameraPreset, cam: o.camera.position.toArray().map(Math.round), farY: far.position.y, Hs: sim.sea.Hs,
        hz, rim, y0, W, H,
        inside: kit.diff(withFar, noFar, y0, H),
        beyond: kit.diff(withFar, noFar, Math.ceil(hz) + 2, Math.floor(rim) - 2),
        leak: kit.diff(withFar, leak, y0, H, 0, W, 6),
      };
    });
    assert.equal(r.preset, 'orbit');
    assert.deepEqual(r.cam, [285, 170, 450], 'camera at the orbit preset');
    assert.equal(r.farY, -0.15);
    assert.ok(r.Hs > 3.2, `a big sea (H_s ${r.Hs.toFixed(2)} m)`);
    assert.ok(r.hz < r.rim && r.y0 < r.H / 2, `the footprint region (rows ${r.y0}..${r.H}) lies below the horizon (${r.hz.toFixed(1)}) and the rim (${r.rim.toFixed(1)})`);
    assert.equal(r.inside.count, 0, `hiding the far plane changes no pixel inside the footprint (${JSON.stringify(r.inside)})`);
    assert.ok(r.beyond.count > 0, `the far plane does fill in between the rim and the horizon (${JSON.stringify(r.beyond)})`);
    assert.ok(r.leak.count > 1000, `without the discard the far plane would poke through the troughs (${JSON.stringify(r.leak)})`);
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('after a WebGL context loss and restore, the sky and its reflection on the water come back, and a quality switch is clean', T, async () => {
  const page = await newPage(browser, { width: 640, height: 480 });
  const log = collectConsole(page);
  await page.addInitScript(pixelKit);
  try {
    await open(page, server.url, '?q=low');
    await evalSim(page, sim => { sim.state.running = false; sim.state.simTime = 30; });
    await waitFrames(page, 2);

    // sky: rows above the horizon (the Sky dome drawn directly); water: rows
    // below it, whose colour is mostly the baked sky cube map (Fresnel
    // reflection, and the horizon haze the fog mixes in)
    const before = await evalSim(page, () => {
      const kit = window.__px, img = kit.grab(), hz = Math.round(kit.horizonRow());
      window.__before = img;
      return { hz, H: img.H, sky: kit.mean(img, 0, hz - 10), water: kit.mean(img, hz + 10, img.H) };
    });
    assert.ok(before.hz > 40 && before.hz < before.H / 2, `horizon in the upper half (row ${before.hz})`);
    assert.ok(before.sky.lum > 150, `bright sky before the loss (${JSON.stringify(before.sky)})`);
    assert.ok(before.water.lum > 40, `water reflects the sky before the loss (${JSON.stringify(before.water)})`);

    // three.js prevents the default on 'webglcontextlost', which is what allows a restore
    const lost = await evalSim(page, async sim => {
      const o = sim.ocean, gl = o.renderer.getContext();
      window.__loseExt = gl.getExtension('WEBGL_lose_context');
      const ev = new Promise(res => o.canvas.addEventListener('webglcontextlost', e => res(e.defaultPrevented), { once: true }));
      window.__loseExt.loseContext();
      return { prevented: await ev, lost: gl.isContextLost() };
    });
    assert.deepEqual(lost, { prevented: true, lost: true });
    await waitFrames(page, 2);                       // the loop keeps running while the context is gone

    // restore from a later task: Chrome records the prevented default only after the lost event's dispatch
    const restored = await evalSim(page, async sim => {
      const o = sim.ocean, gl = o.renderer.getContext();
      const ev = new Promise(res => {
        const t = setTimeout(() => res(false), 20_000);
        o.canvas.addEventListener('webglcontextrestored', () => { clearTimeout(t); res(true); }, { once: true });
      });
      window.__loseExt.restoreContext();
      return { event: await ev, lost: gl.isContextLost() };
    });
    assert.deepEqual(restored, { event: true, lost: false }, 'webglcontextrestored fired and the context is back');
    await waitFrames(page, 3);
    assert.equal(await evalSim(page, sim => sim.ocean.needsRebake), false, 'the frame loop consumed the re-bake request');

    const after = await evalSim(page, (sim, hz) => {
      const kit = window.__px, a = window.__before, b = kit.grab();
      return {
        sky: { ...kit.diff(a, b, 0, hz - 10), ...kit.mean(b, 0, hz - 10) },
        water: { ...kit.diff(a, b, hz + 10, b.H), ...kit.mean(b, hz + 10, b.H) },
      };
    }, before.hz);
    for (const k of ['sky', 'water']) {
      assert.ok(after[k].lum >= 0.9 * before[k].lum, `${k} is not black after the restore (luminance ${after[k].lum.toFixed(1)} vs ${before[k].lum.toFixed(1)})`);
      assert.ok(after[k].meanAbs <= 3, `${k} matches the pre-loss frame (mean |diff| ${after[k].meanAbs.toFixed(2)} levels, max ${after[k].max})`);
    }

    // A quality switch disposes the pre-loss mesh geometry. three re-creates
    // its internals on restore, so a dispose listener left over from the lost
    // context would delete that context's buffers and VAO, which Chrome reports
    // as 'WebGL: INVALID_OPERATION: delete: object does not belong to this context'.
    const switched = await evalSim(page, sim => {
      const before = sim.ocean.mesh.geometry.parameters.segments;
      sim.actions.setQuality('med');
      return { before, after: sim.ocean.mesh.geometry.parameters.segments };
    });
    assert.deepEqual(switched, { before: 160, after: 256 }, 'low -> med rebuilt the mesh');
    await waitFrames(page, 3);

    assert.deepEqual(onlyErrors(log), []);
    // WebGL misuse after the restore shows up as 'WebGL: ...' warnings
    const foreign = log.filter(e => /does not belong to this context/.test(e.text));
    assert.deepEqual(foreign, [], 'no deletes of objects from the lost context');
    const glWarnings = log.filter(e => e.type === 'warning' && /WebGL: /.test(e.text));
    assert.deepEqual(glWarnings, [], 'no WebGL errors reported as warnings');
  } finally {
    await page.close();
  }
});
