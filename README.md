# Open Ocean Simulator — Rogue Wave Lab

An immersive, browser-based open ocean where crossing wave trains and a wind sea
pile up into rogue waves through **constructive interference** (dispersive
focusing). Live at <https://therealtwizzy.github.io/Open_Ocean_Simulator/>.

The ocean is rendered with [Three.js](https://threejs.org/) (vendored, no CDN,
no build step): the full wave sum runs in the vertex shader, with Gerstner chop,
analytic normals, sky reflection, sun glint, subsurface glow and foam, and the
fragment shader adds the wind sea's short waves (down to ~0.3 m) and whitecaps. Serve the
folder over HTTP (`python3 -m http.server`) — ES modules do not load from
`file://`.

## What you can do

- **Add, remove, mute and shape wave trains** (up to 6). Each has amplitude, peak
  frequency, heading, bandwidth (±10–50 %), directional spread (0–40°) and, when
  dispersion is off, its own phase speed.
- **Set the wind.** A JONSWAP wind sea (0–15 m/s, 60 km fetch, Gaussian
  directional spread, waves longer than ~16 m) runs underneath the trains and
  counts toward H<sub>s</sub>.
- **Toggle deep-water dispersion** (ω² = g·k, on by default). Speed sliders then
  show the computed c = g/2πf and lock; groups focus and disperse for real.
- **Interact with the water.** Drag to orbit, scroll or pinch to zoom, pick the
  Orbit or Surface camera. Click the sea to drop a splash ripple, or switch the
  click mode to Buoy and moor a marker that streams its elevation to a 12 s
  sparkline.
- **Watch the 2D superposition** drawer: every train's profile along the centre
  line, the wind sea, and their white sum with the ±H<sub>s</sub> guides.
- **Read the physics** in the explainer panel, with a tip that reacts to your
  settings.

Controls live in a dock of circular buttons along the bottom: pause, wave
trains, settings, click mode, camera, physics, 2D view. Space pauses; Esc
closes any panel.

## The physics

- Every component, from the trains and the wind sea alike, is
  η = a·cos(k(x cos θ + y sin θ) − ωt + φ). The surface is their sum.
- A **train** is a group of 7 components with Gaussian-tapered amplitudes
  (Σw = 1, so the amplitude slider is the crest height of the fully focused
  group), evenly spaced over ±bandwidth around the peak frequency, with phases
  set so they align at a focus point — the wave-tank recipe for a rogue. With
  dispersion each component travels at its own speed, so the group flattens
  out and, every 1/Δf seconds, refocuses.
- **Significant wave height** H<sub>s</sub> = 4σ with σ² = Σaᵢ²/2 over all
  components, updated live and identical across render-quality presets.
- **Rogue detection** samples the central 600 × 320 m on an 8 m grid 30 times a
  second, including the sea time between scans (steps of at most 0.085 s, so
  brief peaks survive high time speeds), and runs a zero-down-crossing scan
  along every row and column. A wave whose crest-to-trough height exceeds
  2·H<sub>s</sub> fires the alert, drops a beacon on the crest as drawn, and
  briefly freezes the simulation at that instant (optional).
- The wind sea's spectrum continues below the mesh's ~16 m in the fragment
  shader: 40 short dispersive waves down to ~0.3 m, spread around the wind, that
  shade the surface (no wind, glassy water) and fade once too fine for a pixel,
  widening the sun's glitter path instead. Whitecaps appear where the local slope
  passes ~0.3, the linear breaking onset: about 0.5 % of the sea at 8 m/s and
  4 % at 15, in line with whitecap surveys.
- Crest steepness (Gerstner displacement), the short waves, foam and splash
  ripples are visual only and never enter H<sub>s</sub> or the detector.

At the default settings (two trains at 0.15 Hz / 0.11 Hz crossing at 30°,
bandwidth 20 %, spread 10°, 8 m/s wind) the two groups' refocus periods of
100 s and 136 s beat against each other, so rogue events arrive in irregular
bursts every minute or two at 2.5× time (a lone group never crosses 2·H<sub>s</sub>
in still water; with wind on, its random crests occasionally carry one over).
Widen the bandwidth or the spread, or raise the wind, and events become rarer —
like the real ocean.

## Layout

```
index.html          HUD markup, import map, physics explainer
css/style.css       deep-sea styling (glass panels, dock, popovers, sliders)
js/physics.js       trains, JONSWAP ambient, Gerstner surface, detector (pure JS)
js/ocean.js         Three.js scene: ocean shader, sky, camera, buoy, picking
js/ui.js            dock, popovers, train cards, stats, alert, 2D drawer
js/main.js          state, frame loop, detection, interaction, quality
vendor/             three.module.min.js, OrbitControls.js, Sky.js (r170)
tests/              unit (node:test) and browser (Playwright) specs, helpers/
package.json        test scripts and the pinned Playwright version
```

Render quality is auto-picked (`?q=low|med|high` overrides it) and steps down,
up to twice, if the GPU cannot hold ~22 fps. Everything works offline once loaded.

`?fps` adds a readout of the median frame time and, where the browser exposes
`EXT_disjoint_timer_query_webgl2`, the GPU time per render. `?noskip` turns off
the shader's zero-weight skips (same image, different work), so opening
`?q=low&fps` and `?q=low&fps&noskip` on one device measures what they save.

## Tests

```
npm test                          # physics unit tests (Node 22, no dependencies)
npm ci                            # once, for the browser tests
npx playwright install chromium
npm run test:browser              # boots the app in headless Chromium (SwiftShader WebGL2)
```

The unit tests check the wave maths in `js/physics.js` directly; the browser
tests serve the repo over a local HTTP server and drive the real page through
the `window.__sim` hook. CI runs both on pull requests and pushes to `main`.
