// HUD: dock, popovers, train cards, settings, stats, alert, beacon, buoy readout
// and the 2D superposition drawer. Talks to the simulation only through the
// `actions` object handed in by main.js.

import { MAX_TRAINS, TRAIN_COLORS, LAB, phaseSpeed, wavelength } from './physics.js';

const $ = id => document.getElementById(id);
const MARKER_MS = 3500;
const NARROW = () => window.innerWidth <= 640;

export function initUI({ state, sea, actions }) {
  const dock = $('dock');
  const backdrop = $('backdrop');
  const canvas2d = $('sea2d'), ctx2d = canvas2d.getContext('2d');
  let openPop = null, openBtn = null;
  let yScale2d = 30;

  // ---------- dock + popovers ----------
  function ping(btn) {
    btn.classList.remove('ping');
    void btn.offsetWidth;
    btn.classList.add('ping');
  }
  dock.addEventListener('animationend', e => { if (e.animationName === 'ping') e.target.classList.remove('ping'); });

  function positionPop(pop, btn) {
    if (NARROW()) return;
    const r = btn.getBoundingClientRect();
    const w = Math.min(pop.classList.contains('wide-pop') ? 440 : 370, window.innerWidth - 32);
    const x = Math.min(Math.max(r.left + r.width / 2, 16 + w / 2), window.innerWidth - 16 - w / 2);
    pop.style.setProperty('--x', x + 'px');
  }

  // keyboard users get focus handed back to the trigger; pointer users get it
  // dropped so Space stays the pause shortcut after a click
  let keyboardInput = false;
  document.addEventListener('keydown', () => { keyboardInput = true; }, true);
  document.addEventListener('pointerdown', () => { keyboardInput = false; }, true);

  function closePop(restoreFocus = true) {
    if (!openPop) return;
    const btn = openBtn;
    openPop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    openPop = openBtn = null;
    backdrop.hidden = true;
    if (!restoreFocus) return;
    if (keyboardInput) btn.focus({ preventScroll: true });
    else if (document.activeElement && document.activeElement.closest('.popover, .dock')) document.activeElement.blur();
  }

  function openPopover(pop, btn) {
    const same = openPop === pop;
    closePop(false);
    if (same) { btn.focus({ preventScroll: true }); return; }
    positionPop(pop, btn);
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    openPop = pop; openBtn = btn;
    backdrop.hidden = !NARROW();
    pop.focus({ preventScroll: true });
  }

  dock.querySelectorAll('.dock-btn').forEach(btn => {
    const id = btn.dataset.pop;
    if (id) { btn.setAttribute('aria-controls', id); $(id).tabIndex = -1; }
    btn.addEventListener('click', e => {
      ping(btn);
      if (id) openPopover($(id), btn);
      else if (e.detail > 0) btn.blur();
    });
  });
  backdrop.addEventListener('click', () => closePop());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (openPop) closePop();
      else if (!$('drawer').hidden) { setDrawer(false); $('btn-2d').focus({ preventScroll: true }); }
      return;
    }
    const tag = e.target.tagName;
    // Space activates a focused button or scrolls a focused panel body; anywhere else it pauses
    const scroller = e.target.classList && e.target.classList.contains('body');
    if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA' && tag !== 'BUTTON' && !scroller) {
      e.preventDefault();
      actions.togglePause();
    }
  });
  window.addEventListener('resize', () => {
    if (openPop) { positionPop(openPop, openBtn); backdrop.hidden = !NARROW(); }
    resize2d();
  });

  $('btn-pause').addEventListener('click', () => actions.togglePause());
  $('btn-2d').addEventListener('click', () => setDrawer($('drawer').hidden));
  $('drawer-close').addEventListener('click', () => setDrawer(false));

  function setDrawer(open) {
    $('drawer').hidden = !open;
    $('btn-2d').setAttribute('aria-pressed', String(open));
    if (open) { resize2d(); renderLegend(); }
  }

  // ---------- train cards ----------
  const fmtTrain = {
    amp: v => v.toFixed(2) + ' m',
    freq: v => v.toFixed(3) + ' Hz',
    speed: v => v.toFixed(1) + ' m/s',
    dir: v => v.toFixed(0) + '°',
    bw: v => '±' + Math.round(v * 100) + '%',
    spread: v => v.toFixed(0) + '°',
  };
  const trainSliders = [
    ['amp', 'Amplitude (focused crest)', 0.1, 4, 0.05],
    ['freq', 'Peak frequency', 0.05, 0.3, 0.005],
    ['speed', 'Phase speed', 2, 32, 0.25],
    ['dir', 'Heading', -180, 180, 5],
    ['bw', 'Bandwidth', 0.1, 0.5, 0.05],
    ['spread', 'Directional spread', 0, 40, 1],
  ];

  function trainMeta(tr) {
    return `λ ${wavelength(tr.freq).toFixed(0)} m · T ${(1 / tr.freq).toFixed(1)} s · refocus ${(3 / (tr.freq * tr.bw)).toFixed(0)} s`;
  }

  function renderTrains() {
    const list = $('train-list');
    list.innerHTML = '';
    state.trains.forEach((tr, i) => {
      const card = document.createElement('div');
      card.className = 'card' + (tr.on ? '' : ' off');
      card.style.setProperty('--c', tr.color);
      card.dataset.index = i;
      card.innerHTML = `
        <div class="card-head">
          <span class="name">Train ${i + 1}</span><span class="meta"></span>
          <label class="toggle" title="Enable"><input type="checkbox" data-k="on" ${tr.on ? 'checked' : ''} aria-label="Enable train ${i + 1}"><i></i></label>
          <button class="remove" aria-label="Remove train ${i + 1}" title="Remove">✕</button>
        </div>
        ${trainSliders.map(([k, label, min, max, step]) => `
          <div class="ctl"><label>${label} <output data-o="${k}"></output></label>
          <input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${tr[k]}" aria-label="Train ${i + 1} ${label}"></div>`).join('')}`;
      list.appendChild(card);
      syncCard(card, tr);
      card.querySelectorAll('input[type="range"]').forEach(inp => {
        inp.addEventListener('input', () => {
          tr[inp.dataset.k] = parseFloat(inp.value);
          if (inp.dataset.k === 'freq' && state.dispersion) tr.speed = phaseSpeed(tr.freq);
          syncCard(card, tr);
          actions.rebuild();
        });
      });
      card.querySelector('[data-k="on"]').addEventListener('change', e => {
        tr.on = e.target.checked;
        card.classList.toggle('off', !tr.on);
        actions.rebuild();
      });
      card.querySelector('.remove').addEventListener('click', () => actions.removeTrain(i));
    });
    $('train-count').textContent = `${state.trains.length} / ${MAX_TRAINS}`;
    $('add-train').disabled = state.trains.length >= MAX_TRAINS;
    renderLegend();
  }

  function syncCard(card, tr) {
    for (const [k] of trainSliders) {
      const inp = card.querySelector(`[data-k="${k}"]`);
      if (k === 'speed') {
        if (state.dispersion) tr.speed = phaseSpeed(tr.freq);
        inp.value = tr.speed;
        inp.disabled = state.dispersion;
        inp.title = state.dispersion ? 'Locked by deep-water dispersion: c = g / 2πf' : '';
      }
      card.querySelector(`[data-o="${k}"]`).textContent = fmtTrain[k](tr[k]) + (k === 'speed' && state.dispersion ? ' (g/2πf)' : '');
    }
    card.querySelector('.meta').textContent = trainMeta(tr);
  }

  function syncAllCards() {
    document.querySelectorAll('#train-list .card').forEach(card => syncCard(card, state.trains[card.dataset.index]));
  }

  $('add-train').addEventListener('click', () => actions.addTrain());

  // ---------- settings ----------
  const settings = [
    ['s-wind', 'wind', v => v.toFixed(1) + ' m/s'],
    ['s-winddir', 'windDir', v => v.toFixed(0) + '°'],
    ['s-steep', 'steepness', v => v.toFixed(2)],
    ['s-time', 'timeScale', v => v.toFixed(2) + '×'],
  ];
  function syncSettings() {
    for (const [id, key, fmt] of settings) { $(id).value = state[key]; $(id + '-v').textContent = fmt(state[key]); }
    $('s-disp').checked = state.dispersion;
    $('s-tint').checked = state.rogueTint;
    $('s-freeze').checked = state.autoFreeze;
    $('s-quality').value = state.quality;
  }
  for (const [id, key, fmt] of settings) {
    $(id).addEventListener('input', () => {
      state[key] = parseFloat($(id).value);
      $(id + '-v').textContent = fmt(state[key]);
      if (key !== 'timeScale') actions.rebuild();
    });
  }
  $('s-disp').addEventListener('change', e => {
    state.dispersion = e.target.checked;
    if (!state.dispersion) state.trains.forEach(tr => { tr.speed = Math.min(Math.max(tr.speed, 2), 32); });
    syncAllCards();
    actions.rebuild();
  });
  $('s-tint').addEventListener('change', e => { state.rogueTint = e.target.checked; actions.applyTint(); });
  $('s-freeze').addEventListener('change', e => { state.autoFreeze = e.target.checked; });
  $('s-quality').addEventListener('change', e => actions.setQuality(e.target.value));
  $('btn-reset').addEventListener('click', () => actions.reset());

  // ---------- click mode + camera ----------
  const clickNotes = {
    splash: 'Splash drops a decorative ripple packet on the water where you click (up to four at once). It never enters the detector.',
    buoy: 'Buoy moors a marker where you click. It rides the rendered surface and streams its elevation into the readout at the top left.',
  };
  document.querySelectorAll('#pop-click .seg button').forEach(b => b.addEventListener('click', () => actions.setClickMode(b.dataset.mode)));
  document.querySelectorAll('#pop-camera .seg button').forEach(b => b.addEventListener('click', () => actions.setCamera(b.dataset.cam)));
  $('buoy-remove').addEventListener('click', () => actions.clearBuoy());

  function syncModes() {
    document.querySelectorAll('#pop-click .seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === state.clickMode)));
    document.querySelectorAll('#pop-camera .seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cam === state.cameraPreset)));
    $('click-note').textContent = clickNotes[state.clickMode];
    const btn = $('btn-click');
    btn.classList.toggle('buoy', state.clickMode === 'buoy');
    btn.setAttribute('aria-label', 'Click mode: ' + state.clickMode);
    $('gl').classList.toggle('crosshair', state.clickMode === 'buoy');
  }

  // ---------- stats / alert / beacon ----------
  function updateStats(Hmax, ratio) {
    $('v-hs').textContent = sea.Hs.toFixed(2);
    $('v-hmax').textContent = Hmax.toFixed(2);
    $('v-ratio').textContent = ratio.toFixed(2);
    const fill = $('meter-fill');
    fill.style.width = Math.min(ratio / 2.5, 1) * 100 + '%';
    fill.style.background = ratio >= 2 ? 'var(--danger)' : ratio >= 1.6 ? 'var(--warn)' : 'var(--accent)';
    const tile = $('stat-ratio');
    tile.classList.toggle('rogue', ratio >= 2);
    tile.classList.toggle('hot', ratio >= 1.6 && ratio < 2);
    $('v-count').textContent = state.rogueCount;
  }

  let alertTimer = 0;
  function hideAlert() {
    clearTimeout(alertTimer);
    $('alert').classList.remove('show');
  }
  function showAlert(ev) {
    $('alert-sub').textContent = `H = ${(ev.ratio * sea.Hs).toFixed(1)} m · ${ev.ratio.toFixed(2)} × H_s · at (${Math.round(ev.xM)}, ${Math.round(ev.yM)}) m`;
    const overlay = $('alert');
    overlay.classList.remove('show');
    void overlay.offsetWidth;
    overlay.classList.add('show');
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => overlay.classList.remove('show'), 2800);
  }

  function setPaused(paused) {
    const b = $('btn-pause');
    b.setAttribute('aria-pressed', String(paused));
    b.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    b.nextElementSibling.innerHTML = (paused ? 'Resume' : 'Pause') + ' <kbd>space</kbd>';
  }

  function setFrozen(on) { $('frozen').classList.toggle('show', on); }

  function updateBeacon(wallNow, project) {
    const ev = state.lastEvent, el = $('beacon');
    if (!ev || wallNow - ev.wall > MARKER_MS) { el.hidden = true; return; }
    const p = project(ev.xM, ev.eta, ev.yM);
    if (!p) { el.hidden = true; return; }
    el.hidden = false;
    el.style.left = p.sx + 'px';
    el.style.top = p.sy + 'px';
    el.style.opacity = String(1 - (wallNow - ev.wall) / MARKER_MS);
  }

  // ---------- buoy readout ----------
  const spark = $('buoy-spark'), sctx = spark.getContext('2d');
  const hist = [];
  function resetBuoyHistory() { hist.length = 0; }
  // history is keyed by simulation time, so the window is 12 s of sea time
  // and the trace holds still while the sea is paused or frozen
  function updateBuoy(b, simNow) {
    const box = $('buoy-readout');
    if (!b) { box.hidden = true; hist.length = 0; return; }
    box.hidden = false;
    if (!hist.length || simNow > hist[hist.length - 1][0]) hist.push([simNow, b.eta]);
    while (hist.length > 1 && simNow - hist[0][0] > 12) hist.shift();
    let mx = -Infinity, mn = Infinity;
    for (const [, e] of hist) { if (e > mx) mx = e; if (e < mn) mn = e; }
    $('buoy-eta').textContent = (b.eta >= 0 ? '+' : '') + b.eta.toFixed(2);
    $('buoy-max').textContent = mx.toFixed(1);
    $('buoy-min').textContent = mn.toFixed(1);
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W = spark.clientWidth, H = spark.clientHeight;
    if (spark.width !== Math.round(W * dpr)) { spark.width = Math.round(W * dpr); spark.height = Math.round(H * dpr); }
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, W, H);
    const range = Math.max(sea.Hs * 0.75, Math.max(Math.abs(mx), Math.abs(mn)) * 1.1, 0.5);
    const yOf = e => H / 2 - e / range * (H / 2 - 3);
    sctx.strokeStyle = 'rgba(91,124,153,0.5)'; sctx.lineWidth = 1;
    sctx.beginPath(); sctx.moveTo(0, H / 2); sctx.lineTo(W, H / 2); sctx.stroke();
    sctx.setLineDash([3, 4]); sctx.strokeStyle = 'rgba(248,113,113,0.5)';
    sctx.beginPath(); sctx.moveTo(0, yOf(sea.Hs)); sctx.lineTo(W, yOf(sea.Hs)); sctx.stroke();
    sctx.setLineDash([]);
    if (hist.length > 1) {
      sctx.strokeStyle = '#7dd3fc'; sctx.lineWidth = 1.6; sctx.beginPath();
      hist.forEach(([s, e], i) => {
        const x = W - (simNow - s) / 12 * W;
        i ? sctx.lineTo(x, yOf(e)) : sctx.moveTo(x, yOf(e));
      });
      sctx.stroke();
    }
  }

  // ---------- 2D drawer ----------
  function resize2d() {
    if ($('drawer').hidden) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas2d.clientWidth * dpr), h = Math.round(canvas2d.clientHeight * dpr);
    if (canvas2d.width !== w) canvas2d.width = w;
    if (canvas2d.height !== h) canvas2d.height = h;
  }

  function renderLegend() {
    const lg = $('legend-2d');
    lg.innerHTML = state.trains.map((tr, i) => `<span><i style="background:${tr.color}"></i>Train ${i + 1}</span>`).join('') +
      (sea.ambientStart < sea.n ? '<span><i style="background:#64748b"></i>Wind sea</span>' : '') +
      '<span><i style="background:#f1f5f9;height:4px"></i>Sum</span>';
  }

  const rows = [];
  function draw2d(t, wallNow, Hmax) {
    if ($('drawer').hidden) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    resize2d();
    const W = canvas2d.width / dpr, H = canvas2d.height / dpr;
    if (W < 10 || H < 10) return;
    const n = Math.max(2, Math.ceil(W / 2) + 1);
    const ds = LAB.W / (n - 1);
    const need = state.trains.length + 2;
    while (rows.length < need) rows.push(new Float64Array(0));
    for (let i = 0; i < need; i++) if (rows[i].length < n) rows[i] = new Float64Array(n);
    const sum = rows[need - 1], amb = rows[need - 2];
    sum.fill(0, 0, n);
    state.trains.forEach((tr, i) => {
      const r = sea.trainRange[i];
      const out = rows[i];
      if (r && r[1] > 0) sea.fillRow(out, n, -LAB.W / 2, 0, 1, 0, ds, t, r[0], r[0] + r[1]);
      else out.fill(0, 0, n);
      for (let j = 0; j < n; j++) sum[j] += out[j];
    });
    sea.fillRow(amb, n, -LAB.W / 2, 0, 1, 0, ds, t, sea.ambientStart, sea.n);
    for (let j = 0; j < n; j++) sum[j] += amb[j];

    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, W, H);
    const midY = H * 0.5;
    let ampSum = 0;
    for (const tr of state.trains) if (tr.on) ampSum += tr.amp;
    const target = (H * 0.4) / Math.max(1.5, (ampSum + sea.ambientHs * 0.5) * 1.1);
    yScale2d += (target - yScale2d) * 0.08;
    const sc = yScale2d;
    const trace = arr => {
      ctx2d.beginPath();
      for (let j = 0; j < n; j++) { const x = j / (n - 1) * W, y = midY - arr[j] * sc; j ? ctx2d.lineTo(x, y) : ctx2d.moveTo(x, y); }
    };

    ctx2d.strokeStyle = '#1c3852'; ctx2d.lineWidth = 1;
    ctx2d.beginPath(); ctx2d.moveTo(0, midY); ctx2d.lineTo(W, midY); ctx2d.stroke();
    ctx2d.setLineDash([5, 6]);
    ctx2d.font = '10px ' + getComputedStyle(document.body).fontFamily;
    ctx2d.textBaseline = 'bottom';
    for (const [mult, color, label] of [[0.5, '#2b5375', '±H_s/2'], [1, '#7c3a45', '±H_s']]) {
      ctx2d.strokeStyle = color; ctx2d.fillStyle = color;
      for (const sgn of [1, -1]) {
        const y = midY - sgn * mult * sea.Hs * sc;
        ctx2d.beginPath(); ctx2d.moveTo(0, y); ctx2d.lineTo(W, y); ctx2d.stroke();
      }
      ctx2d.fillText(label, 8, midY - mult * sea.Hs * sc - 2);
    }
    ctx2d.setLineDash([]);

    ctx2d.lineWidth = 1.2; ctx2d.globalAlpha = 0.55;
    ctx2d.strokeStyle = '#64748b'; trace(amb); ctx2d.stroke();
    ctx2d.globalAlpha = 0.7; ctx2d.lineWidth = 1.4;
    state.trains.forEach((tr, i) => { if (!tr.on) return; ctx2d.strokeStyle = tr.color; trace(rows[i]); ctx2d.stroke(); });
    ctx2d.globalAlpha = 1;

    trace(sum);
    ctx2d.lineTo(W, H); ctx2d.lineTo(0, H); ctx2d.closePath();
    const g = ctx2d.createLinearGradient(0, midY - 60, 0, H);
    g.addColorStop(0, 'rgba(56,189,248,0.16)'); g.addColorStop(1, 'rgba(8,25,45,0.05)');
    ctx2d.fillStyle = g; ctx2d.fill();

    const ratio = sea.Hs > 0 ? Hmax / sea.Hs : 0;
    const hot = Math.min(Math.max((ratio - 1.2) / 0.8, 0), 1);
    ctx2d.lineWidth = 2.2;
    ctx2d.strokeStyle = hot > 0.75 ? '#f87171' : hot > 0.4 ? '#fbbf24' : '#f1f5f9';
    ctx2d.shadowColor = ctx2d.strokeStyle; ctx2d.shadowBlur = 6 + hot * 12;
    trace(sum); ctx2d.stroke();
    ctx2d.shadowBlur = 0;

    const ev = state.lastEvent;
    if (ev && wallNow - ev.wall < MARKER_MS && Math.abs(ev.yM) < LAB.D / 2) {
      const fade = 1 - (wallNow - ev.wall) / MARKER_MS;
      const x = (ev.xM + LAB.W / 2) / LAB.W * W;
      ctx2d.save();
      ctx2d.globalAlpha = fade;
      ctx2d.strokeStyle = '#f87171'; ctx2d.setLineDash([4, 5]); ctx2d.lineWidth = 1.2;
      ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, H); ctx2d.stroke();
      ctx2d.setLineDash([]);
      ctx2d.fillStyle = '#fca5a5'; ctx2d.font = '11px ' + getComputedStyle(document.body).fontFamily; ctx2d.textBaseline = 'top';
      ctx2d.fillText(`rogue ${ev.ratio.toFixed(2)}×H_s, ${Math.round(ev.yM)} m off this line`, Math.min(x + 8, W - 190), 6);
      ctx2d.restore();
    }
  }

  // ---------- reactive tip ----------
  function updateTip(ratio) {
    const tip = $('tip');
    const on = state.trains.filter(t => t.on);
    let html;
    if (on.length === 0) html = '<b>No trains:</b> only the wind sea is running. Add a wave train to build interference.';
    else if (on.length === 1 && state.wind < 5) html = '<b>One train:</b> a lone focused group peaks around 1.7–1.8 H<sub>s</sub> and never reaches 2 in still or light air. Add a second train on a different heading to reach rogue territory.';
    else if (on.length === 1) html = '<b>One train, fresh wind:</b> the group alone stays under 2 H<sub>s</sub>, but from ~5 m/s the wind sea\'s random crests ride on top of its focus and can carry it over the line. Add a second train for the big, regular bursts.';
    else if (on.some(a => on.some(b => a !== b && Math.abs(a.freq - b.freq) < 0.012)))
      html = '<b>Beat pattern:</b> two trains share nearly the same frequency, so you get slow beats — broad zones of reinforcement and cancellation — rather than sharp focusing events.';
    else if (!state.dispersion) html = '<b>Dispersion off:</b> each train is a rigid group that never spreads out. Rogues now happen whenever two focused groups cross — more often, less realistically.';
    else if (ratio >= 2) html = '<b>Rogue conditions:</b> the tallest wave exceeds 2·H<sub>s</sub>. In a real sea this crest would appear "out of nowhere" and vanish within a minute.';
    else if (ratio >= 1.7) html = '<b>Close!</b> H<sub>max</sub> is nearing 2·H<sub>s</sub> — groups are partially aligned. Watch the tinted crests.';
    else if (on.some(t => t.spread >= 25)) html = '<b>Short-crested:</b> a wide directional spread makes focus happen at points instead of along crest lines, so events get rare. Real seas look like this; tighten the spread to hunt faster.';
    else if (on.some(t => t.bw >= 0.4)) html = '<b>Broad band:</b> a wide bandwidth focuses sharply but briefly, and refocuses often. Coincidences between trains become fleeting.';
    else html = '<b>Tip:</b> trains refocus every 1/Δf seconds at their own focus points. A rogue needs two of them to coincide — watch the meter climb in bursts.';
    if (tip.dataset.html !== html) { tip.dataset.html = html; tip.innerHTML = html; }
  }

  // ---------- hint ----------
  setTimeout(() => $('hint').classList.add('fade'), 7000);

  function refresh() {
    state.trains.forEach((tr, i) => { tr.color = TRAIN_COLORS[i % TRAIN_COLORS.length]; });
    renderTrains();
    syncSettings();
    syncModes();
  }

  return {
    refresh, syncAllCards, syncSettings, syncModes, renderLegend, updateStats, showAlert, hideAlert, setPaused, setFrozen, updateBeacon,
    updateBuoy, resetBuoyHistory, draw2d, updateTip, closePop, setDrawer,
    isPopOpen: () => !!openPop,
    isDrawerOpen: () => !$('drawer').hidden,
    showNoGL: () => { $('nogl').hidden = false; setDrawer(true); },
  };
}
