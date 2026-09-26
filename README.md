# Open Ocean Simulator — Rogue Wave Lab

An interactive, single-file simulation of deep-ocean rogue wave formation through
**constructive interference** (linear focusing). Open `index.html` in any modern
browser — no build step, no network, no dependencies.

Two views, toggleable in the header: a **3D ocean surface** (hand-rolled WebGL,
wave sum evaluated in the vertex shader; drag to rotate) and the original
**2D cross-section**, where the resulting sea state is visibly the sum of the
two train lines.

## What it shows

Two storm wave trains (A and B) cross the same stretch of ocean at different
speeds and frequencies. The white "Resulting Sea State" line is their literal
sum at every point — the principle of superposition. When the trains' wave
groups drift into phase alignment, the surface briefly piles up into a single
towering crest: a rogue wave.

## The physics

- Each train is a **narrow-band group of 7 sinusoidal components** with
  Gaussian-tapered amplitudes around the central frequency you set. This is the
  honest model of a storm swell — and a mathematical necessity: two pure sine
  waves can *never* exceed the rogue threshold (by Cauchy–Schwarz,
  H/H<sub>s</sub> ≤ 1 for a two-component sea).
- **Significant wave height** is computed live and analytically:
  H<sub>s</sub> = 4σ with σ² = Σ aᵢ²/2 over all 14 components.
- **Rogue detection** uses the standard oceanographic definition: the profile is
  segmented at zero down-crossings each frame, and an alert fires when any
  individual wave's crest-to-trough height exceeds 2·H<sub>s</sub>. The
  convergence point is highlighted, and the simulation can auto-freeze briefly
  so you can inspect it.

Each train also has a **direction (heading)** slider. Pointing the trains along
different headings creates **crossing seas** — two wave systems whose crest
lines only fully reinforce where they intersect. Crossing wind-sea and swell is
a documented real-world rogue mechanism and the leading hypothesis for the
Draupner wave; in the 3D view, crests climbing above the H<sub>s</sub>
elevation glow orange, and rogue events drop a pulsing beacon at the
convergence point.

## Controls

- Per-train sliders: amplitude, central frequency, propagation speed, direction.
- Global time step / speed multiplier (0–8×), pause (space bar), reset.
- Toggleable physics sidebar with a reactive tip that responds to your slider
  settings (beats, non-lapping groups, near-rogue conditions, …).

## Rogue hunting recipe

Keep the two amplitudes similar, keep a healthy speed difference between the
trains, and watch the H<sub>max</sub>/H<sub>s</sub> meter approach the red tick
at 2.0. At the default settings an event lands roughly every half minute.
