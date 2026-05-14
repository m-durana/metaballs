// Debug scrubber overlay — gated by `?scrub` URL flag. A bottom-fixed
// strip with a per-card slider and Release button so you can simulate
// hover/unhover sequences without actually mousing over cards.
//
// Two modes:
//
//   HOVER mode (default):
//     slider 0..1   → field.scrubHover(idx, value)
//                     (instant hover level, bypasses ramps)
//     [Release]     → field.popPaused(idx)
//                     (triggers pop at current hover, pauses at t=0,
//                      switches to RELEASE mode and resets slider)
//
//   RELEASE mode:
//     slider 0..1   → field.scrubPop(idx, value)
//                     (drives respawnT through the pop timeline)
//     [End]         → field.endPop(idx)
//                     (snap card back to rest, return to HOVER mode)

export function mountScrubber(field, cards) {
  if (!/[?&]scrub(=|&|$)/.test(location.search)) return;

  const root = document.createElement('div');
  root.id = 'scrubber';
  root.innerHTML = `
    <style>
      #scrubber {
        position: fixed;
        left: 50%;
        bottom: 16px;
        transform: translateX(-50%);
        display: flex;
        gap: 12px;
        align-items: center;
        padding: 10px 14px;
        background: rgba(20, 20, 24, 0.85);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        font-family: 'Nunito Sans', system-ui, sans-serif;
        font-size: 12px;
        color: #e8e8ea;
        z-index: 9999;
      }
      #scrubber .row { display: flex; gap: 8px; align-items: center; }
      #scrubber select, #scrubber button {
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 6px;
        color: #e8e8ea;
        padding: 4px 8px;
        font: inherit;
        cursor: pointer;
      }
      #scrubber button:hover { background: rgba(255,255,255,0.12); }
      #scrubber input[type=range] { width: 220px; }
      #scrubber .val { width: 36px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.75; }
      #scrubber .mode {
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        background: rgba(255,255,255,0.06);
      }
      #scrubber.release-mode .mode { background: rgba(217, 119, 87, 0.25); color: #f0b59c; }
    </style>
    <span class="mode">hover</span>
    <div class="row">
      <label>card</label>
      <select class="card-select"></select>
    </div>
    <div class="row">
      <label class="slider-label">hover</label>
      <input type="range" min="0" max="1" step="0.005" value="0" />
      <span class="val">0.00</span>
    </div>
    <button class="play" disabled title="Play (release mode only)">▶</button>
    <button class="action">Release</button>
    <button class="reset">Reset</button>
  `;
  document.body.appendChild(root);

  const sel = root.querySelector('.card-select');
  cards.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    const cls = [...c.el.classList].find(x => x !== 'item') || `card ${i}`;
    opt.textContent = cls;
    sel.appendChild(opt);
  });

  const slider     = root.querySelector('input[type=range]');
  const valLabel   = root.querySelector('.val');
  const sliderLbl  = root.querySelector('.slider-label');
  const modeLbl    = root.querySelector('.mode');
  const actionBtn  = root.querySelector('.action');
  const resetBtn   = root.querySelector('.reset');
  const playBtn    = root.querySelector('.play');

  let mode = 'hover';
  let playing = false;
  let playRaf = 0;
  const idx = () => Number(sel.value);

  function stopPlay() {
    if (playRaf) cancelAnimationFrame(playRaf);
    playRaf = 0;
    playing = false;
    playBtn.textContent = '▶';
  }

  function startPlay() {
    field.playPop(idx());
    playing = true;
    playBtn.textContent = '❚❚';
    const tick = () => {
      if (!playing) return;
      const i = idx();
      // Frame loop reset respawning to false on allDone — exit
      // release mode when that fires so the slider doesn't dangle.
      if (!field.isRespawning(i)) {
        stopPlay();
        enterHoverMode();
        return;
      }
      const t = field.getPopT01(i);
      slider.value = String(t);
      valLabel.textContent = t.toFixed(2);
      playRaf = requestAnimationFrame(tick);
    };
    playRaf = requestAnimationFrame(tick);
  }

  function setSlider(v) {
    slider.value = String(v);
    valLabel.textContent = Number(v).toFixed(2);
  }

  function enterHoverMode() {
    stopPlay();
    mode = 'hover';
    root.classList.remove('release-mode');
    modeLbl.textContent = 'hover';
    sliderLbl.textContent = 'hover';
    actionBtn.textContent = 'Release';
    playBtn.disabled = true;
    setSlider(0);
  }

  function enterReleaseMode() {
    mode = 'release';
    root.classList.add('release-mode');
    modeLbl.textContent = 'release';
    sliderLbl.textContent = 'pop t';
    actionBtn.textContent = 'End';
    playBtn.disabled = false;
    setSlider(0);
  }

  // Switching cards while mid-release would leave that card paused —
  // snap it back to rest first so each card starts clean.
  sel.addEventListener('change', () => {
    if (mode === 'release') {
      // End on the previously-selected card before switching focus.
      // (We don't track previous index; just end on all to be safe.)
      for (let i = 0; i < cards.length; i++) field.endPop(i);
      enterHoverMode();
    }
  });

  slider.addEventListener('input', () => {
    // Grabbing the slider while playing pauses playback so the user
    // can scrub from the current position.
    if (playing) {
      stopPlay();
      field.pausePop(idx());
    }
    const v = Number(slider.value);
    valLabel.textContent = v.toFixed(2);
    if (mode === 'hover') field.scrubHover(idx(), v);
    else                  field.scrubPop(idx(), v);
  });

  playBtn.addEventListener('click', () => {
    if (mode !== 'release') return;
    if (playing) {
      stopPlay();
      field.pausePop(idx());
    } else {
      startPlay();
    }
  });

  actionBtn.addEventListener('click', () => {
    if (mode === 'hover') {
      const ok = field.popPaused(idx());
      if (ok) enterReleaseMode();
    } else {
      field.endPop(idx());
      enterHoverMode();
    }
  });

  resetBtn.addEventListener('click', () => {
    for (let i = 0; i < cards.length; i++) field.endPop(i);
    enterHoverMode();
  });
}
