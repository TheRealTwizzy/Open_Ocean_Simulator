// HUD behaviour in a real browser: stats, wave-train cards, dispersion lock,
// reactive tip, dock popovers and focus handling, the Space shortcut,
// tooltips and Reset. Run: npm run test:browser
//
// Expected H_s values are computed in Node with the same physics module the
// page uses (js/physics.js is DOM-free), so the HUD is checked against the
// model to the displayed 2 decimals rather than against magic numbers.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { launch, newPage, open, waitFrames, collectConsole, onlyErrors, clickDock, evalSim, waitSim, primeRogue } from '../helpers/browser.mjs';
import { Sea, defaultTrain, QUALITY, MAX_TRAINS, phaseSpeed, G, TWO_PI } from '../../js/physics.js';

const T = 180_000;
const WAIT = { timeout: 60_000, polling: 50 };
const POPS = ['pop-trains', 'pop-settings', 'pop-click', 'pop-camera', 'pop-physics'];
const DOCK = {
  'pop-trains': '[data-pop="pop-trains"]',
  'pop-settings': '[data-pop="pop-settings"]',
  'pop-click': '#btn-click',
  'pop-camera': '[data-pop="pop-camera"]',
  'pop-physics': '[data-pop="pop-physics"]',
};

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

// ---------- local helpers ----------

// H_s of the page's sea for these trains at ?q=low (48 ambient components), as main.js compiles it
function expectedHs(seeds, { wind = 8, windDir = 20, off = [] } = {}) {
  const trains = seeds.map(s => ({ ...defaultTrain(s), on: !off.includes(s) }));
  const sea = new Sea();
  sea.compile({ trains, dispersion: true, wind, windDir, nAmbient: QUALITY.low.ambient, steepness: 0.55 });
  return sea.Hs;
}

// page.waitForFunction that fails with a readable assertion instead of a bare timeout
async function waitFor(page, fn, arg, msg) {
  try {
    await page.waitForFunction(fn, arg, WAIT);
  } catch (err) {
    assert.fail(`${msg} (${err.message.split('\n')[0]})`);
  }
}

async function waitText(page, selector, expected, msg) {
  try {
    await page.waitForFunction(([s, e]) => { const el = document.querySelector(s); return !!el && el.textContent === e; }, [selector, expected], WAIT);
  } catch (err) {
    const got = await page.evaluate(s => document.querySelector(s)?.textContent, selector);
    assert.fail(`${msg || selector}: expected text ${JSON.stringify(expected)}, got ${JSON.stringify(got)} (${err.message.split('\n')[0]})`);
  }
}

async function waitTip(page, prefix) {
  try {
    await page.waitForFunction(p => document.getElementById('tip').textContent.startsWith(p), prefix, WAIT);
  } catch (err) {
    assert.fail(`#tip should start with ${JSON.stringify(prefix)}, got ${JSON.stringify(await tipText(page))}`);
  }
}
const tipText = page => page.evaluate(() => document.getElementById('tip').textContent);

const visiblePops = page => page.evaluate(ids => ids.filter(id => {
  const el = document.getElementById(id);
  return !el.hidden && getComputedStyle(el).display !== 'none';
}), POPS);

const expanded = page => page.evaluate(sel => Object.fromEntries(Object.entries(sel).map(([id, s]) =>
  [id, document.querySelector(s).getAttribute('aria-expanded')])), DOCK);

// what has focus: tag, id, data-pop, and the popover it sits in
const active = page => page.evaluate(() => {
  const a = document.activeElement;
  return { tag: a.tagName, id: a.id, pop: a.dataset?.pop || null, inPop: a.closest?.('.popover')?.id || null };
});

// a viewport point whose topmost element is the WebGL canvas (outside any open popover or HUD panel)
async function emptyCanvasPoint(page) {
  const p = await page.evaluate(() => {
    for (const fy of [0.3, 0.4, 0.25, 0.5, 0.2]) for (const fx of [0.9, 0.1, 0.8, 0.2, 0.5]) {
      const x = Math.round(innerWidth * fx), y = Math.round(innerHeight * fy);
      if (document.elementFromPoint(x, y)?.id === 'gl') return { x, y };
    }
    return null;
  });
  assert.ok(p, 'found a point where the canvas is on top');
  return p;
}

const tipStyle = (page, btnSel) => page.evaluate(s => {
  const btn = document.querySelector(s), tip = btn.nextElementSibling, cs = getComputedStyle(tip);
  const r = tip.getBoundingClientRect(), b = btn.getBoundingClientRect();
  // the bubble is rotated along the dock's fan, so compare its centre rather than its box edge
  const above = (r.top + r.bottom) / 2 < b.top && Math.abs((r.left + r.right) / 2 - (b.left + b.right) / 2) < b.width;
  return { cls: tip.className, text: tip.textContent.trim(), opacity: Number(cs.opacity), display: cs.display, visibility: cs.visibility, above, w: r.width };
}, btnSel);

async function waitTipOpacity(page, btnSel, cmp) {
  await waitFor(page, ([s, c]) => {
    const o = Number(getComputedStyle(document.querySelector(s).nextElementSibling).opacity);
    return c === 'shown' ? o >= 0.99 : o <= 0.01;
  }, [btnSel, cmp], `tooltip of ${btnSel} should be ${cmp} (computed opacity ${cmp === 'shown' ? '1' : '0'})`);
}

const legend = page => page.$$eval('#legend-2d span', els => els.map(e => e.textContent.trim()));
const cardNames = page => page.$$eval('#train-list .card .name', els => els.map(e => e.textContent));
const seeds = page => evalSim(page, sim => sim.state.trains.map(t => t.seed));
const card = i => `#train-list .card[data-index="${i}"]`;

// ---------- tests ----------

test('boots at ?q=low without console errors and shows H_s 2.88', { timeout: T }, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low', { frames: 3 });
    assert.equal(expectedHs([0, 1]).toFixed(2), '2.88', 'model agrees on the default sea');
    assert.equal(await page.textContent('#v-hs'), '2.88');
    assert.equal(await page.textContent('#v-count'), '0');
    assert.equal(await page.textContent('#train-count'), `2 / ${MAX_TRAINS}`);
    assert.deepEqual(await cardNames(page), ['Train 1', 'Train 2']);
    assert.equal(await evalSim(page, sim => sim.state.qualityActual), 'low');
    // detection has run: H_max and the ratio are numbers, not the placeholder dash
    const hmax = await page.textContent('#v-hmax'), ratio = await page.textContent('#v-ratio');
    assert.match(hmax, /^\d+\.\d\d$/);
    assert.match(ratio, /^\d+\.\d\d$/);
    assert.ok(Number(hmax) > 0 && Number(ratio) > 0, `H_max ${hmax}, ratio ${ratio}`);
    assert.equal(await page.isVisible('#alert'), false);
    assert.deepEqual(await visiblePops(page), []);
    await waitFrames(page, 2);
    assert.deepEqual(onlyErrors(log), []);
  } finally { await page.close(); }
});

test('wave trains: add, mute, remove and preset-slot reuse drive H_s, count and legend', { timeout: T }, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  const hs = (s, o) => expectedHs(s, o).toFixed(2);
  try {
    await open(page, server.url, '?q=low');
    await clickDock(page, '#btn-2d');
    assert.equal(await page.isVisible('#drawer'), true, '2D drawer open');
    assert.equal(await page.getAttribute('#btn-2d', 'aria-pressed'), 'true');
    assert.deepEqual(await legend(page), ['Train 1', 'Train 2', 'Wind sea', 'Sum']);
    await clickDock(page, DOCK['pop-trains']);
    assert.deepEqual(await visiblePops(page), ['pop-trains']);
    assert.equal(await page.textContent('#v-hs'), '2.88');

    // add: H_s rises, count and legend grow
    const hs3 = hs([0, 1, 2]);
    assert.ok(Number(hs3) > 2.88);
    await page.click('#add-train');
    await waitText(page, '#v-hs', hs3, 'H_s after adding a train');
    assert.equal(await page.textContent('#train-count'), `3 / ${MAX_TRAINS}`);
    assert.deepEqual(await seeds(page), [0, 1, 2]);
    assert.deepEqual(await cardNames(page), ['Train 1', 'Train 2', 'Train 3']);
    assert.deepEqual(await legend(page), ['Train 1', 'Train 2', 'Train 3', 'Wind sea', 'Sum']);
    const swatch = await page.$eval('#legend-2d span:nth-child(3) i', el => getComputedStyle(el).backgroundColor);
    const cardColor = await page.$eval(`${card(2)} .name`, el => getComputedStyle(el).color);
    assert.equal(swatch, cardColor, 'legend swatch matches the new card colour');

    // mute train 1: H_s drops, card dims; unmute restores it
    const muted = hs([0, 1, 2], { off: [0] });
    assert.ok(Number(muted) < Number(hs3));
    await page.locator(`${card(0)} label.toggle`).uncheck();
    await waitText(page, '#v-hs', muted, 'H_s with train 1 muted');
    assert.equal(await evalSim(page, sim => sim.state.trains[0].on), false);
    assert.equal(await page.$eval(card(0), el => el.classList.contains('off')), true);
    assert.equal(await page.textContent('#train-count'), `3 / ${MAX_TRAINS}`, 'muting keeps the train');
    await page.locator(`${card(0)} label.toggle`).check();
    await waitText(page, '#v-hs', hs3, 'H_s with train 1 re-enabled');

    // remove train 1: H_s drops, count and legend shrink, cards renumber
    const removed = hs([1, 2]);
    assert.ok(Number(removed) < Number(hs3));
    await page.click(`${card(0)} .remove`);
    await waitText(page, '#v-hs', removed, 'H_s after removing train 1');
    assert.equal(await page.textContent('#train-count'), `2 / ${MAX_TRAINS}`);
    assert.deepEqual(await seeds(page), [1, 2]);
    assert.deepEqual(await cardNames(page), ['Train 1', 'Train 2']);
    assert.deepEqual(await legend(page), ['Train 1', 'Train 2', 'Wind sea', 'Sum']);

    // add again: the freed preset slot (seed 0) is reused, not a duplicate
    await page.click('#add-train');
    await waitText(page, '#train-count', `3 / ${MAX_TRAINS}`);
    const s = await seeds(page);
    assert.equal(new Set(s).size, s.length, `no duplicate seeds: ${s}`);
    assert.ok(s.includes(0), `freed seed 0 reused: ${s}`);
    assert.deepEqual(s, [1, 2, 0]);
    const added = await evalSim(page, sim => { const t = sim.state.trains[2]; return { amp: t.amp, freq: t.freq, dir: t.dir, on: t.on }; });
    const p0 = defaultTrain(0);
    assert.deepEqual(added, { amp: p0.amp, freq: p0.freq, dir: p0.dir, on: true }, 'new train carries preset 0');
    await waitText(page, '#v-hs', hs([1, 2, 0]), 'H_s after re-adding');

    // fill up to MAX_TRAINS: the add button disables and every seed is distinct
    for (let n = 4; n <= MAX_TRAINS; n++) {
      await page.click('#add-train');
      await waitText(page, '#train-count', `${n} / ${MAX_TRAINS}`);
    }
    assert.equal(await page.isDisabled('#add-train'), true);
    assert.deepEqual([...await seeds(page)].sort(), [0, 1, 2, 3, 4, 5]);
    assert.equal((await legend(page)).filter(t => t.startsWith('Train')).length, MAX_TRAINS);
    assert.deepEqual(onlyErrors(log), []);
  } finally { await page.close(); }
});

test('dispersion toggle locks and unlocks the train speed sliders', { timeout: T }, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  const speed = i => `${card(i)} input[data-k="speed"]`;
  const speedOut = i => `${card(i)} output[data-o="speed"]`;
  const dispToggle = page.locator('#pop-settings label.toggle', { has: page.locator('#s-disp') });
  const k3 = () => evalSim(page, sim => sim.sea.k[3]);          // centre component of train 1 (f = freq exactly)
  const f1 = defaultTrain(0).freq, f2 = defaultTrain(1).freq;
  const locked = f => `${phaseSpeed(f).toFixed(1)} m/s (g/2πf)`;
  try {
    await open(page, server.url, '?q=low');
    await clickDock(page, DOCK['pop-trains']);
    // dispersion on (default): sliders disabled, speed = g/2πf
    for (const i of [0, 1]) {
      assert.equal(await page.isDisabled(speed(i)), true, `train ${i + 1} speed locked`);
      assert.match(await page.getAttribute(speed(i), 'title'), /Locked by deep-water dispersion/);
    }
    assert.equal(await page.textContent(speedOut(0)), locked(f1));
    assert.equal(await page.textContent(speedOut(1)), locked(f2));
    assert.ok(Math.abs(await k3() - (TWO_PI * f1) ** 2 / G) < 1e-9, 'k = ω²/g with dispersion');

    // dispersion off: sliders unlock
    await clickDock(page, DOCK['pop-settings']);
    assert.equal(await page.isChecked('#s-disp'), true);
    await dispToggle.uncheck();
    assert.equal(await evalSim(page, sim => sim.state.dispersion), false);
    await clickDock(page, DOCK['pop-trains']);
    for (const i of [0, 1]) {
      assert.equal(await page.isDisabled(speed(i)), false, `train ${i + 1} speed unlocked`);
      assert.equal(await page.getAttribute(speed(i), 'title'), '');
    }
    assert.equal(await page.textContent(speedOut(0)), `${phaseSpeed(f1).toFixed(1)} m/s`, 'no g/2πf suffix');

    // the slider reaches its max, and the readout shows >= 31.2 m/s
    const max = Number(await page.getAttribute(speed(0), 'max'));
    assert.ok(max >= 31.2, `speed slider max ${max}`);
    await page.locator(speed(0)).focus();
    await page.keyboard.press('End');
    assert.equal(Number(await page.inputValue(speed(0))), max);
    assert.equal(await evalSim(page, sim => sim.state.trains[0].speed), max);
    const shown = await page.textContent(speedOut(0));
    assert.equal(shown, `${max.toFixed(1)} m/s`);
    assert.ok(parseFloat(shown) >= 31.2, `displayed speed ${shown}`);
    assert.ok(Math.abs(await k3() - TWO_PI * f1 / max) < 1e-9, 'k = ω/c without dispersion (sea recompiled)');

    // dispersion back on: locked again and speed snaps back to g/2πf
    await clickDock(page, DOCK['pop-settings']);
    await dispToggle.check();
    assert.equal(await evalSim(page, sim => sim.state.dispersion), true);
    await clickDock(page, DOCK['pop-trains']);
    for (const i of [0, 1]) assert.equal(await page.isDisabled(speed(i)), true, `train ${i + 1} speed locked again`);
    assert.equal(await page.textContent(speedOut(0)), locked(f1));
    assert.ok(Math.abs(await evalSim(page, sim => sim.state.trains[0].speed) - phaseSpeed(f1)) < 1e-9);
    assert.ok(Math.abs(await k3() - (TWO_PI * f1) ** 2 / G) < 1e-9);
    assert.deepEqual(onlyErrors(log), []);
  } finally { await page.close(); }
});

test('reactive tip switches at the 5 m/s wind threshold with one train', { timeout: T }, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await waitFor(page, () => document.getElementById('tip').textContent.length > 0, null, '#tip gets filled in');
    assert.ok(!(await tipText(page)).startsWith('One train'), 'two trains: not a one-train tip');

    // one train at the default 8 m/s wind
    await clickDock(page, DOCK['pop-trains']);
    await page.click(`${card(1)} .remove`);
    await waitText(page, '#train-count', `1 / ${MAX_TRAINS}`);
    await waitTip(page, 'One train, fresh wind:');

    await clickDock(page, DOCK['pop-settings']);
    await page.fill('#s-wind', '4.5');
    assert.equal(await evalSim(page, sim => sim.state.wind), 4.5);
    assert.equal(await page.textContent('#s-wind-v'), '4.5 m/s');
    await waitTip(page, 'One train:');

    await page.fill('#s-wind', '5');
    assert.equal(await evalSim(page, sim => sim.state.wind), 5);
    await waitTip(page, 'One train, fresh wind:');

    await page.fill('#s-wind', '4.5');
    await waitTip(page, 'One train:');

    // the tip lives in the physics popover
    await clickDock(page, DOCK['pop-physics']);
    assert.equal(await page.isVisible('#tip'), true);
    assert.match(await tipText(page), /^One train: a lone focused group/);
    assert.deepEqual(onlyErrors(log), []);
  } finally { await page.close(); }
});

test('popovers: one at a time, Esc and canvas click close, focus moves in', { timeout: T }, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    assert.deepEqual(await visiblePops(page), []);

    // each dock button opens its own popover and closes whichever was open
    for (const id of POPS) {
      await clickDock(page, DOCK[id]);
      assert.deepEqual(await visiblePops(page), [id], `only ${id} visible`);
      const exp = await expanded(page);
      for (const other of POPS) assert.equal(exp[other], String(other === id), `aria-expanded of ${other} with ${id} open`);
      assert.equal((await active(page)).inPop, id, `focus moved into ${id}`);
    }

    // Esc closes the open popover (pop-physics)
    await page.keyboard.press('Escape');
    assert.deepEqual(await visiblePops(page), []);
    assert.equal((await expanded(page))['pop-physics'], 'false');

    // clicking the canvas outside closes it and leaves no focus in the dock or popover
    await clickDock(page, DOCK['pop-camera']);
    assert.deepEqual(await visiblePops(page), ['pop-camera']);
    const p = await emptyCanvasPoint(page);
    const ripples = await evalSim(page, sim => sim.ocean.ripples.length);
    await page.mouse.click(p.x, p.y);
    await waitFor(page, () => document.getElementById('pop-camera').hidden, null, 'clicking the canvas closes the camera popover');
    assert.deepEqual(await visiblePops(page), []);
    assert.equal((await expanded(page))['pop-camera'], 'false');
    assert.equal((await active(page)).tag, 'BODY');
    assert.equal(await evalSim(page, sim => sim.ocean.ripples.length), ripples, 'the closing click does not splash');

    // clicking the open popover's own button toggles it shut
    await clickDock(page, DOCK['pop-settings']);
    assert.deepEqual(await visiblePops(page), ['pop-settings']);
    await clickDock(page, DOCK['pop-settings']);
    assert.deepEqual(await visiblePops(page), []);
    assert.equal((await expanded(page))['pop-settings'], 'false');
    assert.deepEqual(onlyErrors(log), []);
  } finally { await page.close(); }
});

test('popovers: keyboard open moves focus in, Esc returns it to the dock button', { timeout: T }, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await page.locator('#btn-pause').focus();
    await page.keyboard.press('Tab');
    assert.equal((await active(page)).pop, 'pop-trains', 'Tab from Pause reaches the trains button');
    await page.keyboard.press('Enter');
    assert.deepEqual(await visiblePops(page), ['pop-trains']);
    assert.equal((await active(page)).inPop, 'pop-trains', 'focus moved into the popover');
    assert.equal((await expanded(page))['pop-trains'], 'true');

    // navigate inside the popover, then Esc
    await page.keyboard.press('Tab');
    const inside = await active(page);
    assert.equal(inside.inPop, 'pop-trains', `Tab stays inside the popover (${inside.tag})`);
    await page.keyboard.press('Escape');
    assert.deepEqual(await visiblePops(page), []);
    assert.equal((await active(page)).pop, 'pop-trains', 'focus returned to the trains dock button');
    assert.equal((await expanded(page))['pop-trains'], 'false');

    // same for a popover opened from a keyboard-focused button further along
    await page.keyboard.press('Tab');
    assert.equal((await active(page)).pop, 'pop-settings');
    await page.keyboard.press('Enter');
    assert.deepEqual(await visiblePops(page), ['pop-settings']);
    assert.equal((await active(page)).inPop, 'pop-settings');
    await page.keyboard.press('Tab');
    assert.equal((await active(page)).id, 's-wind', 'first control of Settings');
    await page.keyboard.press('Escape');
    assert.deepEqual(await visiblePops(page), []);
    assert.equal((await active(page)).pop, 'pop-settings', 'focus returned to the settings dock button');
    assert.equal(await evalSim(page, sim => sim.state.running), true, 'no key in this sequence paused the sea');
    assert.deepEqual(onlyErrors(log), []);
  } finally { await page.close(); }
});

test('Space pauses from the page but not from inputs, selects or buttons', { timeout: T }, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  const run = () => evalSim(page, sim => sim.state.running);
  const pressed = () => page.getAttribute('#btn-pause', 'aria-pressed');
  try {
    await open(page, server.url, '?q=low');
    await page.evaluate(() => document.activeElement?.blur());
    assert.equal((await active(page)).tag, 'BODY');
    assert.equal(await run(), true);
    assert.equal(await pressed(), 'false');

    // focus on body: Space toggles pause both ways
    await page.keyboard.press('Space');
    assert.equal(await run(), false);
    assert.equal(await pressed(), 'true');
    assert.equal(await page.getAttribute('#btn-pause', 'aria-label'), 'Resume');
    const t0 = await evalSim(page, sim => sim.state.simTime);
    await waitFrames(page, 2);
    assert.equal(await evalSim(page, sim => sim.state.simTime), t0, 'sea time holds while paused');
    await page.keyboard.press('Space');
    assert.equal(await run(), true);
    assert.equal(await pressed(), 'false');
    assert.equal(await page.getAttribute('#btn-pause', 'aria-label'), 'Pause');

    // INPUT: Space on the wind slider does nothing to pause
    await clickDock(page, DOCK['pop-settings']);
    await page.locator('#s-wind').focus();
    await page.keyboard.press('Space');
    assert.equal(await run(), true, 'Space in an INPUT does not pause');
    assert.equal(await evalSim(page, sim => sim.state.wind), 8);

    // BUTTON: Space activates the focused button (2D view) instead of pausing
    await page.keyboard.press('Escape');
    await page.locator('#btn-2d').focus();
    await page.keyboard.press('Space');
    assert.equal(await run(), true, 'Space on a BUTTON does not pause');
    await waitFor(page, () => !document.getElementById('drawer').hidden, null, 'Space on the focused 2D button opens the drawer');
    assert.equal(await page.getAttribute('#btn-2d', 'aria-pressed'), 'true', 'Space activated the button');

    // a focused scrolling panel body keeps Space for scrolling
    await clickDock(page, DOCK['pop-physics']);
    await page.locator('#pop-physics .body').focus();
    await page.keyboard.press('Space');
    assert.equal(await run(), true, 'Space in the physics panel body does not pause');
    await page.keyboard.press('Escape');

    // mouse-clicked dock buttons without a popover drop focus, so Space still pauses
    await clickDock(page, '#btn-pause');
    assert.equal(await run(), false, 'clicking Pause pauses');
    assert.notEqual((await active(page)).id, 'btn-pause', 'focus does not stay on the clicked Pause button');
    await page.keyboard.press('Space');
    assert.equal(await run(), true, 'Space after a Pause click resumes');
    assert.equal(await pressed(), 'false');

    await clickDock(page, '#btn-2d');
    assert.equal(await page.isVisible('#drawer'), false, 'clicking 2D closes the drawer');
    assert.notEqual((await active(page)).id, 'btn-2d');
    await page.keyboard.press('Space');
    assert.equal(await run(), false, 'Space after a 2D click pauses');
    await page.keyboard.press('Space');
    assert.equal(await run(), true);

    // SELECT last: Space opens the native picker, whose state later keys would depend on
    await clickDock(page, DOCK['pop-settings']);
    await page.locator('#s-quality').focus();
    await page.keyboard.press('Space');
    assert.equal(await run(), true, 'Space in a SELECT does not pause');
    assert.equal(await evalSim(page, sim => sim.state.quality), 'auto');
    await waitFrames(page, 1);
    assert.equal(await run(), true);
    assert.deepEqual(onlyErrors(log), []);
  } finally { await page.close(); }
});

test('dock tooltips show on hover and keyboard focus, hide when their popover is open', { timeout: T }, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    const rest = await emptyCanvasPoint(page);
    await page.mouse.move(rest.x, rest.y);
    for (const sel of ['#btn-pause', DOCK['pop-trains'], '#btn-2d']) await waitTipOpacity(page, sel, 'hidden');

    // hover Pause: its bubble fades in above the button, the others stay hidden
    await page.hover('#btn-pause', { force: true });
    await waitTipOpacity(page, '#btn-pause', 'shown');
    let st = await tipStyle(page, '#btn-pause');
    assert.equal(st.cls, 'tip');
    assert.equal(st.text, 'Pause space');
    assert.equal(st.display, 'block');
    assert.equal(st.visibility, 'visible');
    assert.ok(st.above && st.w > 20, 'tooltip sits above (and over) the button');
    assert.equal((await tipStyle(page, DOCK['pop-trains'])).opacity, 0, 'unhovered tooltip stays hidden');

    // moving away hides it again
    await page.mouse.move(rest.x, rest.y);
    await waitTipOpacity(page, '#btn-pause', 'hidden');

    // label follows the pause state
    await evalSim(page, sim => sim.actions.togglePause());
    await page.hover('#btn-pause', { force: true });
    await waitTipOpacity(page, '#btn-pause', 'shown');
    assert.equal((await tipStyle(page, '#btn-pause')).text, 'Resume space');
    await evalSim(page, sim => sim.actions.togglePause());

    // another button's tooltip
    await page.hover(DOCK['pop-trains'], { force: true });
    await waitTipOpacity(page, DOCK['pop-trains'], 'shown');
    assert.equal((await tipStyle(page, DOCK['pop-trains'])).text, 'Wave trains');
    await waitTipOpacity(page, '#btn-pause', 'hidden');

    // with its popover open the tooltip is not displayed, even under the pointer
    await clickDock(page, DOCK['pop-trains']);
    assert.deepEqual(await visiblePops(page), ['pop-trains']);
    st = await tipStyle(page, DOCK['pop-trains']);
    assert.equal(st.display, 'none', 'tooltip hidden while its popover is open');
    await page.keyboard.press('Escape');
    assert.deepEqual(await visiblePops(page), []);

    // keyboard focus (:focus-visible) shows it without hovering
    await page.mouse.move(rest.x, rest.y);
    await page.keyboard.press('Tab');                 // focus moved on from the trains button (restored by Esc)
    const now = await active(page);
    assert.equal(now.pop, 'pop-settings', 'Tab reached the settings button');
    await waitTipOpacity(page, DOCK['pop-settings'], 'shown');
    assert.equal((await tipStyle(page, DOCK['pop-settings'])).text, 'Settings');
    await waitTipOpacity(page, DOCK['pop-trains'], 'hidden');
    assert.deepEqual(onlyErrors(log), []);
  } finally { await page.close(); }
});

test('Reset restores two default trains, H_s 2.88, zero rogues and hides the alert', { timeout: T }, async () => {
  const page = await newPage(browser);
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await clickDock(page, DOCK['pop-settings']);

    // a real rogue event: count 1, alert and freeze shown
    const { t } = await primeRogue(page);
    const ev = await waitSim(page, sim => sim.state.rogueCount > 0 && sim.state.lastEvent)
      .catch(err => assert.fail(`a rogue event fires once the sea is parked at t = ${t} (${err.message.split('\n')[0]})`));
    assert.equal(ev.sim, t);
    await waitText(page, '#v-count', '1');

    // disturb the rest of the state, then re-arm the alert (it self-hides after 2.8 s) right
    // before clicking, and record what the page looked like the moment Reset's click arrived
    await page.locator('#btn-reset').scrollIntoViewIfNeeded();
    await evalSim(page, sim => {
      sim.actions.addTrain();
      sim.state.wind = 3; sim.state.dispersion = false; sim.state.steepness = 0.2;
      sim.actions.rebuild(); sim.ui.syncSettings();
      window.__atReset = null;
      const armed = performance.now();
      document.addEventListener('click', e => {
        if (e.target.id !== 'btn-reset') return;
        window.__atReset = {
          alert: document.getElementById('alert').classList.contains('show'), count: sim.state.rogueCount,
          trains: sim.state.trains.length, ms: Math.round(performance.now() - armed),
        };
      }, { capture: true, once: true });
      sim.ui.showAlert(sim.state.lastEvent);
    });
    assert.equal(await page.textContent('#train-count'), `3 / ${MAX_TRAINS}`);
    // forced: the actionability wait costs a few (slow) frames, ~1 s here, eating into the 2.8 s
    // alert window; forced it lands in ~20 ms. The capture listener proves it hit #btn-reset.
    await page.click('#btn-reset', { force: true });

    const pre = await page.evaluate(() => window.__atReset);
    assert.ok(pre, 'the click reached #btn-reset');
    assert.equal(pre.alert, true, `alert still showing when Reset ran (${pre.ms} ms after it was shown; it self-hides at 2800)`);
    assert.equal(pre.count, 1);
    assert.equal(pre.trains, 3);
    assert.equal(await page.$eval('#alert', el => el.classList.contains('show')), false, '#alert lost class show');
    const s = await evalSim(page, sim => ({
      seeds: sim.state.trains.map(t => t.seed), amps: sim.state.trains.map(t => t.amp), on: sim.state.trains.map(t => t.on),
      rogueCount: sim.state.rogueCount, lastEvent: sim.state.lastEvent, wind: sim.state.wind, dispersion: sim.state.dispersion,
      steepness: sim.state.steepness, timeScale: sim.state.timeScale, freezeUntil: sim.state.freezeUntil, Hs: sim.sea.Hs,
    }));
    assert.deepEqual(s.seeds, [0, 1]);
    assert.deepEqual(s.amps, [defaultTrain(0).amp, defaultTrain(1).amp]);
    assert.deepEqual(s.on, [true, true]);
    assert.equal(s.rogueCount, 0);
    assert.equal(s.lastEvent, null);
    assert.equal(s.wind, 8);
    assert.equal(s.dispersion, true);
    assert.equal(s.steepness, 0.55);
    assert.equal(s.timeScale, 2.5);
    assert.equal(s.freezeUntil, 0);
    assert.equal(s.Hs.toFixed(2), '2.88');

    assert.equal(await page.textContent('#v-hs'), '2.88');
    assert.equal(await page.textContent('#v-count'), '0');
    assert.equal(await page.textContent('#train-count'), `2 / ${MAX_TRAINS}`);
    assert.deepEqual(await cardNames(page), ['Train 1', 'Train 2']);
    assert.equal(await page.textContent('#s-wind-v'), '8.0 m/s');
    assert.equal(await page.isChecked('#s-disp'), true);

    // the freeze badge clears and the sea runs again
    await waitFrames(page, 2);
    assert.equal(await page.$eval('#frozen', el => el.classList.contains('show')), false);
    assert.equal(await page.$eval('#alert', el => el.classList.contains('show')), false);
    assert.ok(await evalSim(page, sim => sim.state.simTime > 0 && sim.state.simTime < 5), 'sea time restarted from 0');
    assert.equal(await page.textContent('#v-hs'), '2.88');
    assert.deepEqual(onlyErrors(log), []);
  } finally { await page.close(); }
});
