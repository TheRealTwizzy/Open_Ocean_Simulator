// Text contrast of the HUD in a real browser. The panels are translucent glass
// over a live WebGL sky and sea that can be near-white, so every text is
// measured against the worst case: what its own box and its ancestors paint
// behind it, composited over a white backdrop. That is their background colours
// and images, their ::before/::after boxes that overlap it (the caustic stripes
// sweeping behind popover and drawer header text) and their inset glows
// (zero-offset inset box-shadows, at half their alpha: their value along the
// padding edge, which text never reaches). A gradient counts as the stop that
// leaves the lowest contrast; backdrop blur is ignored. Text in --faint or
// --muted must reach WCAG AA 4.5:1; every other text colour is reported, not
// asserted. Run: node --test tests/browser/contrast.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { launch, newPage, open, collectConsole, onlyErrors, clickDock, evalSim, waitSim } from '../helpers/browser.mjs';

const T = { timeout: 180_000 };
const AA = 4.5;
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

// Waits until every finite CSS animation (popover/sheet/drawer entry, dock
// rise) has finished, so opacities are final.
async function settle(page) {
  await page.waitForFunction(() => document.getAnimations()
    .filter(a => a.animationName && a.effect && a.effect.getComputedTiming().iterations !== Infinity)
    .every(a => a.playState === 'finished'), null, { timeout: 30_000, polling: 50 });
}

// Runs in the page. Every rendered HUD element with a non-empty text node of
// its own: its colour, the worst-case composite behind it and the ratio, plus
// the computed colours of the two tokens. html and body are skipped: they
// paint under the full-screen canvas.
function measureText() {
  const parse = s => {
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [r, g, b, a];
  };
  const over = (c, bg) => [0, 1, 2].map(i => c[3] * c[i] + (1 - c[3]) * bg[i]);
  const lum = c => {
    const [r, g, b] = c.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const tokenOf = {};
  for (const name of ['--faint', '--muted']) {
    const probe = document.createElement('i');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    tokenOf[getComputedStyle(probe).color] = name;
    probe.remove();
  }
  const opacity = el => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  const px = v => (/px$/.test(v) ? parseFloat(v) : NaN);
  // Whether e's ::before/::after (computed style ps) overlaps rect r. An
  // absolutely positioned box is placed from its resolved offsets in e's
  // padding box; any other, or one that does not resolve, counts as overlapping.
  const pseudoOverlaps = (e, ps, r) => {
    if (ps.position !== 'absolute') return true;
    const b = e.getBoundingClientRect(), s = getComputedStyle(e);
    const bl = px(s.borderLeftWidth), bt = px(s.borderTopWidth);
    const w = px(ps.width), h = px(ps.height);
    const left = Number.isNaN(px(ps.left)) ? b.width - bl - px(s.borderRightWidth) - px(ps.right) - w : px(ps.left);
    const top = Number.isNaN(px(ps.top)) ? b.height - bt - px(s.borderBottomWidth) - px(ps.bottom) - h : px(ps.top);
    if ([w, h, left, top].some(Number.isNaN)) return true;
    const x = b.left + bl + left, y = b.top + bt + top;
    return x < r.right && x + w > r.left && y < r.bottom && y + h > r.top;
  };
  // background image (its colour stops) over background colour, top first
  const fills = (s, alpha = 1) => {
    const out = [], stops = [...s.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map(m => parse(m[0])), bg = parse(s.backgroundColor);
    if (stops.length) out.push(stops.map(c => [c[0], c[1], c[2], c[3] * alpha]));
    if (bg && bg[3] > 0) out.push([[bg[0], bg[1], bg[2], bg[3] * alpha]]);
    return out;
  };
  // What e paints behind text in rect r, top first, each layer a list of
  // candidate colours: its ::after and ::before, its inset glows, its own fills.
  const layersOf = (e, r) => {
    const s = getComputedStyle(e), out = [];
    for (const which of ['::after', '::before']) {
      const ps = getComputedStyle(e, which);
      if (/^(none|normal)$/.test(ps.content) || ps.display === 'none' || ps.visibility !== 'visible' || !pseudoOverlaps(e, ps, r)) continue;
      out.push(...fills(ps, parseFloat(ps.opacity)));
    }
    for (const sh of s.boxShadow === 'none' ? [] : s.boxShadow.split(/,(?![^(]*\))/)) {
      const c = parse(sh), [x, y, blur] = (sh.replace(/rgba?\([^)]*\)/, '').match(/-?[\d.]+px/g) || []).map(parseFloat);
      if (/\binset\b/.test(sh) && c && x === 0 && y === 0 && blur > 0) out.push([[c[0], c[1], c[2], c[3] / 2]]);
    }
    out.push(...fills(s));
    return out;
  };
  // 'panel › tag(id).class' ('#' would be escaped in the TAP output)
  const label = el => {
    const own = el.tagName.toLowerCase() + (el.id ? `(${el.id})` : '') +
      (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '');
    const ctx = el.parentElement && el.parentElement.closest('[id]:not(#hud)');
    return (ctx ? ctx.id + ' › ' : '') + own;
  };
  const out = [];
  for (const el of document.querySelectorAll('#hud *')) {
    const text = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
    if (!text) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || cs.visibility !== 'visible' || opacity(el) < 0.05) continue;
    const color = parse(cs.color);
    if (!color) continue;
    const layers = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) layers.push(...layersOf(e, r));
    const contrast = b => ratio(over(color, b), b);
    let back = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) {
      back = layers[i].map(c => over(c, back)).reduce((a, b) => (contrast(b) < contrast(a) ? b : a));
    }
    const fg = over(color, back);
    out.push({
      el: label(el), text: text.slice(0, 24), token: tokenOf[cs.color] || null,
      color: cs.color, back: back.map(Math.round), ratio: ratio(fg, back),
    });
  }
  return { tokens: tokenOf, rows: out };
}

// Measures the page, prints a table row per element/colour/backdrop not yet
// printed by this test (`printed`), and returns the --faint/--muted rows under
// 4.5:1.
async function audit(t, page, state, printed = new Set()) {
  const { tokens, rows } = await page.evaluate(measureText);
  rows.sort((a, b) => a.ratio - b.ratio);
  const lines = [];
  for (const r of rows) {
    const key = `${r.el}|${r.color}|${r.back}`;
    if (printed.has(key)) continue;
    printed.add(key);
    const flag = r.token ? (r.ratio >= AA ? 'ok  ' : 'FAIL') : '    ';
    lines.push(`${flag} ${r.ratio.toFixed(2).padStart(5)}:1  ${(r.token || r.color).padEnd(18)}  on rgb(${r.back.join(', ')})`.padEnd(61) + `  ${r.el} "${r.text}"`);
  }
  const checked = rows.filter(r => r.token).length;
  const legend = Object.entries(tokens).map(([c, n]) => `${n} ${c}`).join(', ');
  t.diagnostic(`${state}: ${rows.length} texts, ${checked} in --faint/--muted (${legend}); ${rows.length - lines.length} already listed`);
  for (const l of lines) t.diagnostic('  ' + l);
  assert.ok(checked > 0, `${state}: found --faint/--muted text to check`);
  return rows.filter(r => r.token && r.ratio < AA).map(r => `${state}: ${r.el} "${r.text}" ${r.token} on rgb(${r.back.join(', ')}) is ${r.ratio.toFixed(2)}:1`);
}

test('default HUD: brand, stats, hint (and the tooltip, alert and frozen badge, reported)', T, async t => {
  const page = await newPage(browser, { width: 800, height: 600 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await evalSim(page, sim => { sim.state.running = false; });
    // the hint fades 7 s after boot: wait for that, then bring it back for good
    await page.waitForFunction(() => document.getElementById('hint').classList.contains('fade'), null, { timeout: 30_000, polling: 100 });
    await evalSim(page, () => {
      const hint = document.getElementById('hint');
      hint.style.transition = 'none';
      hint.classList.remove('fade');
    });
    await settle(page);
    const printed = new Set();
    const bad = await audit(t, page, 'default HUD', printed);

    // report only: a hovered dock tooltip, the rogue alert and the frozen badge
    await page.hover('[data-pop="pop-settings"]', { force: true });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-pop="pop-settings"]').nextElementSibling).opacity === '1',
      null, { timeout: 30_000, polling: 50 });
    await evalSim(page, () => {
      document.getElementById('alert-sub').textContent = 'H = 5.8 m · 2.01 × H_s · at (150, 60) m';
      for (const id of ['alert', 'frozen']) {
        const el = document.getElementById(id);
        el.style.animation = 'none';
        el.classList.add('show');
      }
    });
    await audit(t, page, 'with overlays', printed);
    assert.deepEqual(bad, []);
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('800x600: every dock popover', T, async t => {
  const page = await newPage(browser, { width: 800, height: 600 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await evalSim(page, sim => { sim.state.running = false; });
    const bad = [], printed = new Set();
    for (const [id, sel] of POPS) {
      await clickDock(page, sel);
      await page.locator('#' + id).waitFor({ state: 'visible' });
      await page.mouse.move(796, 4);
      await settle(page);
      bad.push(...await audit(t, page, id, printed));
    }
    assert.deepEqual(bad, []);
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('375x812: the wave-train popover as a bottom sheet', T, async t => {
  const page = await newPage(browser, { width: 375, height: 812 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await evalSim(page, sim => { sim.state.running = false; });
    await clickDock(page, '[data-pop="pop-trains"]');
    await page.locator('#pop-trains').waitFor({ state: 'visible' });
    await settle(page);
    const sheet = await page.evaluate(() => getComputedStyle(document.getElementById('pop-trains')).borderTopLeftRadius);
    assert.equal(sheet, '18px', 'the popover is a bottom sheet');
    assert.deepEqual(await audit(t, page, 'pop-trains sheet'), []);
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('2D drawer and buoy readout', T, async t => {
  const page = await newPage(browser, { width: 800, height: 600 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    await evalSim(page, sim => { sim.state.running = false; sim.actions.setClickMode('buoy'); });
    const p = await evalSim(page, sim => {
      for (const [x, y] of [[400, 300], [300, 380], [500, 380]]) {
        if (document.elementFromPoint(x, y)?.id === 'gl' && sim.ocean.pick(x, y)) return { x, y };
      }
      return null;
    });
    assert.ok(p, 'a canvas point on the water');
    await page.mouse.click(p.x, p.y);
    await waitSim(page, () => !document.getElementById('buoy-readout').hidden);
    await clickDock(page, '#btn-2d');
    await page.locator('#drawer').waitFor({ state: 'visible' });
    await page.mouse.move(796, 4);
    await settle(page);
    assert.deepEqual(await audit(t, page, 'drawer + buoy readout'), []);
    assert.deepEqual(onlyErrors(log), []);
  } finally {
    await page.close();
  }
});

test('no WebGL: the fallback panel and the 2D drawer', T, async t => {
  const page = await newPage(browser, { width: 800, height: 600 });
  try {
    await open(page, server.url, '?q=low', { nogl: true });
    await settle(page);
    assert.equal(await page.isVisible('#nogl p'), true, 'the panel explanation shows');
    assert.deepEqual(await audit(t, page, 'no WebGL'), []);
  } finally {
    await page.close();
  }
});
