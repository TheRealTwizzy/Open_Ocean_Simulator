// Browser smoke test: the app boots on SwiftShader WebGL2 without console
// errors and keeps rendering. Run: npm run test:browser

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { launch, newPage, open, waitFrames, collectConsole, onlyErrors, evalSim } from '../helpers/browser.mjs';

let server, browser;

before(async () => {
  server = await startServer();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('boots at ?q=low, shows H_s 2.88 and keeps rendering', { timeout: 180_000 }, async () => {
  const page = await newPage(browser, { width: 1280, height: 800 });
  const log = collectConsole(page);
  try {
    await open(page, server.url, '?q=low');
    const f0 = await waitFrames(page, 3);

    assert.equal(await evalSim(page, sim => !!sim.ocean), true, 'window.__sim.ocean exists');
    assert.equal(await evalSim(page, sim => sim.state.qualityActual), 'low');
    assert.equal(await page.textContent('#v-hs'), '2.88');
    assert.equal(await page.isVisible('#nogl'), false);

    const f1 = await waitFrames(page, 3);
    assert.ok(f1 >= f0 + 3, `frames advance (${f0} -> ${f1})`);
    assert.ok(await evalSim(page, sim => sim.state.simTime > 0), 'sea time advances');

    assert.deepEqual(onlyErrors(log), [], 'no console errors or page errors');
  } finally {
    await page.close();
  }
});
