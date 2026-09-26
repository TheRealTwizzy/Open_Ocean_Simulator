// Playwright helpers for the browser specs. The app renders with WebGL2, which
// in CI and in containers runs on SwiftShader (software): expect 0.2–0.8 s per
// frame, so never sleep for a fixed time — wait on window.__sim.state.frames,
// which main.js increments once per requestAnimationFrame.
//
// Test hook (main.js): window.__sim = { state, sea, detector, actions, ui, ocean }
// (ocean is a getter; null when WebGL failed).

import { chromium } from 'playwright';

export const SWIFTSHADER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
export const DEFAULT_TIMEOUT = 60_000;

let chosenChannel;                                  // cached per process after the first successful launch

/**
 * Checks that a browser really has WebGL2 with what the app needs: an RGBA32F
 * data texture read back by texelFetch in a vertex shader.
 * @returns {Promise<{ ok: boolean, renderer?: string, reason?: string }>}
 */
export async function probeWebGL2(browser) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const gl = c.getContext('webgl2');
      if (!gl) return { ok: false, reason: 'no webgl2 context' };
      const shader = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      try {
        const prog = gl.createProgram();
        gl.attachShader(prog, shader(gl.VERTEX_SHADER, `#version 300 es
          uniform sampler2D t; out vec4 v;
          void main() { v = texelFetch(t, ivec2(1, 0), 0); gl_Position = vec4(0, 0, 0, 1); gl_PointSize = 1.0; }`));
        gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, `#version 300 es
          precision highp float; in vec4 v; out vec4 o;
          void main() { o = v; }`));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { ok: false, reason: 'link failed: ' + gl.getProgramInfoLog(prog) };
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array([0, 0, 0, 0, 0.25, 0.5, 0.75, 1]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.viewport(0, 0, 1, 1);
        gl.useProgram(prog);
        gl.drawArrays(gl.POINTS, 0, 1);
        const px = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
        const good = Math.abs(px[0] - 64) <= 2 && Math.abs(px[1] - 128) <= 2 && Math.abs(px[2] - 191) <= 2 && px[3] === 255;
        return good ? { ok: true, renderer } : { ok: false, renderer, reason: 'texelFetch read back ' + Array.from(px) };
      } catch (e) {
        return { ok: false, reason: String(e && e.message || e) };
      }
    });
  } finally {
    await page.close();
  }
}

/**
 * Launches Chromium with SwiftShader WebGL. Tries the default build (the
 * headless shell) first and verifies WebGL2 with probeWebGL2; if that fails it
 * falls back to { channel: 'chromium' } (new headless on the full build).
 * `npx playwright install chromium` installs both. The working choice is
 * cached for later launches in the same process.
 * @param {import('playwright').LaunchOptions} [options] extra launch options;
 *   passing `channel` skips the probe/fallback and uses it as given
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launch(options = {}) {
  const { args = [], ...rest } = options;
  const launchWith = channel => chromium.launch({ ...rest, ...(channel ? { channel } : {}), args: [...SWIFTSHADER_ARGS, ...args] });
  if ('channel' in options) return launchWith(options.channel);
  if (chosenChannel !== undefined) return launchWith(chosenChannel);
  const reasons = [];
  for (const channel of [null, 'chromium']) {
    let browser;
    try {
      browser = await launchWith(channel);
      const gl = await probeWebGL2(browser);
      if (gl.ok) { chosenChannel = channel; return browser; }
      reasons.push(`${channel || 'default'}: ${gl.reason}`);
    } catch (e) {
      reasons.push(`${channel || 'default'}: ${String(e.message).split('\n')[0]}`);
    }
    if (browser) await browser.close().catch(() => {});
  }
  throw new Error('No Chromium build with working WebGL2 (' + reasons.join('; ') + ')');
}

/**
 * New page in its own context with a viewport. Small viewports render much
 * faster on SwiftShader; use 1280x800 only where layout is under test.
 * Width > 640 keeps the desktop layout (the app switches to narrow at <= 640).
 * Close with `await page.close()` (the page owns its context).
 */
export async function newPage(browser, { width = 800, height = 600, ...contextOptions } = {}) {
  return browser.newPage({ ...contextOptions, viewport: { width, height } });
}

/**
 * Makes canvas.getContext('webgl' | 'webgl2' | 'experimental-webgl') return
 * null in every document the page loads from now on, so the app takes its
 * no-WebGL path (console.error 'WebGL initialisation failed', #nogl shown,
 * 2D drawer opened, window.__sim.ocean === null). Call before open().
 */
export async function disableWebGL(page) {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (/^(webgl2?|experimental-webgl)$/.test(String(type))) return null;
      return orig.call(this, type, ...rest);
    };
  });
}

/**
 * Loads the app and waits until it is running.
 * @param {import('playwright').Page} page
 * @param {string} url  server base URL from startServer() (ends with '/')
 * @param {string} [query='?q=low']  appended/resolved against url ('' for none)
 * @param {{ nogl?: boolean, frames?: number, timeout?: number }} [opts]
 *   nogl: install disableWebGL() first and wait for #nogl to be visible with
 *         window.__sim.ocean === null instead of a live ocean (default false)
 *   frames: rendered frames to wait for after boot (default 2)
 *   timeout: per wait, ms (default 60000)
 */
export async function open(page, url, query = '?q=low', { nogl = false, frames = 2, timeout = DEFAULT_TIMEOUT } = {}) {
  if (nogl) await disableWebGL(page);
  await page.goto(new URL(query, url).href, { timeout });
  await page.waitForFunction(() => !!window.__sim, null, { timeout, polling: 50 });
  const hasOcean = await page.evaluate(() => !!window.__sim.ocean);
  if (nogl) {
    if (hasOcean) throw new Error('open({ nogl: true }): WebGL was expected to be disabled but window.__sim.ocean exists');
    await page.locator('#nogl').waitFor({ state: 'visible', timeout });
  } else if (!hasOcean) {
    throw new Error('open(): the app booted without WebGL (window.__sim.ocean is null, #nogl shown)');
  }
  if (frames > 0) await waitFrames(page, frames, { timeout });
}

/**
 * Resolves once window.__sim.state.frames has increased by n from its value
 * at call time. Returns the new frame count.
 * @param {number} [n=1]
 * @param {{ timeout?: number }} [opts] default max(60 s, n × 3 s)
 */
export async function waitFrames(page, n = 1, { timeout = Math.max(DEFAULT_TIMEOUT, n * 3000) } = {}) {
  const start = await page.evaluate(() => window.__sim.state.frames);
  await page.waitForFunction(([s, k]) => window.__sim.state.frames >= s + k, [start, n], { timeout, polling: 50 });
  return page.evaluate(() => window.__sim.state.frames);
}

/**
 * Starts recording console errors/warnings and uncaught page errors. Call
 * before open(). The returned array fills up live:
 *   { type: 'error' | 'warning' | 'pageerror', text: string, location: string }
 */
export function collectConsole(page) {
  const entries = [];
  page.on('console', msg => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const loc = msg.location();
    entries.push({ type, text: msg.text(), location: loc && loc.url ? `${loc.url}:${loc.lineNumber}` : '' });
  });
  page.on('pageerror', err => {
    entries.push({ type: 'pageerror', text: String(err && (err.stack || err.message) || err), location: '' });
  });
  return entries;
}

/** Only the 'error' and 'pageerror' entries of a collectConsole() array. */
export function onlyErrors(entries) {
  return entries.filter(e => e.type === 'error' || e.type === 'pageerror');
}

/** Clicks a dock button. They bob (idle animation), so the click is forced. */
export async function clickDock(page, selector) {
  await page.click(selector, { force: true });
}

/**
 * Runs fn(window.__sim, arg) in the page and returns its (serialisable)
 * result; async fns are awaited. fn is sent as source text, so it must not
 * close over test-side variables: pass them through arg.
 *   const hs = await evalSim(page, sim => sim.sea.Hs);
 *   await evalSim(page, (sim, q) => sim.actions.setQuality(q), 'med');
 */
export async function evalSim(page, fn, arg) {
  return page.evaluate(([src, a]) => (0, eval)('(' + src + ')')(window.__sim, a), [fn.toString(), arg]);
}

/**
 * Waits until fn(window.__sim, arg) is truthy in the page (polled every 50 ms)
 * and returns that value. Same closure rule as evalSim.
 *   await waitSim(page, sim => sim.state.rogueCount > 0);
 */
export async function waitSim(page, fn, arg, { timeout = DEFAULT_TIMEOUT } = {}) {
  const handle = await page.waitForFunction(
    ([src, a]) => (0, eval)('(' + src + ')')(window.__sim, a), [fn.toString(), arg], { timeout, polling: 50 });
  try { return await handle.jsonValue(); } finally { await handle.dispose(); }
}

/** Resizes the viewport, then waits `frames` rendered frames (default 2). */
export async function setViewport(page, width, height, frames = 2) {
  await page.setViewportSize({ width, height });
  if (frames > 0) await waitFrames(page, frames);
}

/**
 * Scans detector.detect(t).Hmax / sea.Hs over t in [from, to] (step) in the
 * page, without touching state, and returns the sea time with the highest
 * ratio >= 2, or null. Defaults suit the default sea on ?q=low, whose first
 * rogue is near t = 19.2 s (ratio peaks ~2.014 at t = 19.64).
 * @returns {Promise<{ t: number, ratio: number } | null>}
 */
export async function findRogueTime(page, { from = 18, to = 21, step = 0.02 } = {}) {
  return evalSim(page, (sim, o) => {
    let best = null;
    const n = Math.round((o.to - o.from) / o.step);
    for (let i = 0; i <= n; i++) {
      const t = o.from + i * o.step;
      const ratio = sim.detector.detect(t).Hmax / sim.sea.Hs;
      if (ratio >= 2 && (!best || ratio > best.ratio)) best = { t, ratio };
    }
    return best;
  }, { from, to, step });
}

/**
 * Parks the sea on a rogue: finds a time with findRogueTime(), then sets
 * state.timeScale = 0 and state.simTime = t, so the next detection scan
 * (next frame) fires an event provided state.running, no freeze is active,
 * the 6 s wall cooldown has passed and the last event is > 1 s of sea time
 * away. Throws if no rogue is found. Follow with e.g.
 *   await waitSim(page, sim => sim.state.rogueCount > 0);
 * @returns {Promise<{ t: number, ratio: number }>}
 */
export async function primeRogue(page, range = {}) {
  const hit = await findRogueTime(page, range);
  if (!hit) throw new Error('primeRogue: no t with Hmax/Hs >= 2 in the scanned range');
  await evalSim(page, (sim, t) => { sim.state.timeScale = 0; sim.state.simTime = t; }, hit.t);
  return hit;
}
