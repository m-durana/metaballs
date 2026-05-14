import vertSource from './metaballs.vert?raw';
import fragSource from './metaballs.frag?raw';

const N = 20;
const PALETTE_SIZE = 5;

const BASE_RADIUS_CSS = 11;
const RADIUS_HOVER_SCALE = 9;
const THRESHOLD = 1.4;

const HOVER_UP_MS = 48000;
// Sub-threshold decay: when hover never crossed POP_THRESHOLD,
// hoverTarget=0 just smoothly retracts the cloud over this window
// instead of triggering the pop animation. Tuned to ~75% of HOVER_UP_MS
// so the retract reads as a slightly-faster mirror of the growth ramp,
// not a separate snappy decay curve.
const HOVER_DOWN_MS = 36000;

// Hover floor below which unhover is treated as a smooth retract
// (no pop). Brief hovers under ~POP_THRESHOLD * HOVER_UP_MS milliseconds
// never engaged enough to deserve the scatter-and-fade animation.
const POP_THRESHOLD = 0.1;

// Hold delay between hoverTarget transitioning to 0 and the pop firing.
// During this beat the cloud freezes at its engaged level (hover doesn't
// decay), so unhover reads as "lingers a moment, then snaps" rather
// than "snaps the instant the cursor leaves." Re-hovering within the
// window cancels the delay.
const POP_DELAY_MS = 0;

// ?dots stretches the pop animation 2.5× so the ungrowth reads as a
// slow, choreographed dispersion instead of a quick whoosh. /mockup
// keeps the original snappier timings — user prefers it punchy there.
const _IS_DOTS = true;
// Pop window — per-dot positions scatter outward and alpha fades over
// this whole duration. Cohesion (cloud-cluster look) collapses much
// faster via DISPERSION_MS so the cloud quickly resolves into 28
// individual dots that are then visible scattering.
const POP_DURATION_MS = _IS_DOTS ? 3000 : 1200;
const POP_HOLD_MS = _IS_DOTS ? 500 : 200;
// Cohesion decay — cloud-cluster parts (baseline, centroid, halo)
// drop to 0 over this short window so dots become individually
// visible at the start of the pop, not during a long blob shrink.
// Scaled with POP_DURATION_MS to keep the same proportion of the
// pop window.
const POP_DISPERSION_MS = _IS_DOTS ? 550 : 220;
// Hover decay during pop — own card's u_hover drops to 0 over this
// window. Drives radius shrink (so per-dot kernels become small) and
// other cards' rival fade-in (via reactive rivalCover sampled in JS).
// In ?dots mode it's stretched to match POP_DURATION_MS so the
// membrane collapses smoothly, dots visibly shrink as they scatter,
// and rivals' hue bodies fade back in over the full pop window.
// /mockup keeps the snappier 380ms — user prefers it punchy.
const POP_HOVER_DECAY_MS = _IS_DOTS ? 3000 : 380;

const MEMBRANE_R_BASE_CSS = 50;
const MEMBRANE_AMP        = 0.10;
const MEMBRANE_T_SCALE    = 0.00022;
const Y_COMPRESS          = 0.62;

const ENGULF_MARGIN_CSS = 80;

const SLOT_ANGLE_RAD = (Math.PI * 2) / N;
const MAX_ANGULAR_DEV = SLOT_ANGLE_RAD * 0.45;

const DEBUG_DOTS = true;
const DEBUG_INVIS = typeof location !== 'undefined' && location.search.includes('invis');

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRGB(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function membraneDeform(theta, tt, phase) {
  return (
    0.55 * Math.sin(theta * 2 + tt        + phase) +
    0.35 * Math.sin(theta * 3 - tt * 0.7  + phase * 1.3) +
    0.25 * Math.sin(theta * 5 + tt * 0.5  + phase * 2.1)
  ) / 1.15;
}

function makeCardState(seed) {
  const rand = mulberry32(seed);
  const points = [];

  for (let i = 0; i < N; i++) {
    const slot = (i + 0.5) * SLOT_ANGLE_RAD;
    const wiggleFreq  = 0.0004 + rand() * 0.0006;
    const wigglePhase = rand() * Math.PI * 2;
    const wiggleAmp = 0.002 + Math.pow(rand(), 2) * 0.030;
    const pulseFreq  = 0.00025 + rand() * 0.00100;
    const pulsePhase = rand() * Math.PI * 2;
    const pulseAmp   = 0.04 + rand() * 0.22;

    const engulfReach    = 0.55 + Math.pow(rand(), 1.4) * 1.85;
    const engulfAngBias  = (rand() - 0.5) * Math.PI * 1.6;
    const engulfDriftFq  = 0.00008 + rand() * 0.00075;
    const engulfDriftPh  = rand() * Math.PI * 2;
    const engulfDriftAmp = 0.35 + rand() * 0.55;
    const engulfAngDriftFq = 0.00010 + rand() * 0.00060;
    const engulfAngDriftPh = rand() * Math.PI * 2;
    const engulfAngDriftAmp = 1.20 + rand() * 1.60;

    const clusterRoll = rand();
    let clusterScale = 1.0;
    if (clusterRoll < 0.25)      clusterScale = 0.35 + rand() * 0.20;
    else if (clusterRoll > 0.75) clusterScale = 1.40 + rand() * 0.50;

    // Per-dot phase + time-shift for the membrane breathing — was
    // shared per-card, which made all dots peak/trough at the same
    // beats and read as "all points stop together at three rhythms".
    // With per-dot offsets every dot is on its own rhythm.
    const membranePhaseShift = rand() * Math.PI * 2;
    const membraneTimeShift  = rand() * 30000;  // ms

    points.push({
      slot,
      wiggleAmp, wiggleFreq, wigglePhase,
      pulseFreq, pulsePhase, pulseAmp,
      membranePhaseShift, membraneTimeShift,
      radiusMul: 0.40 + Math.pow(rand(), 1.4) * 1.65,
      engulfReach, clusterScale,
      engulfAngBias, engulfDriftFq, engulfDriftPh, engulfDriftAmp,
      engulfAngDriftFq, engulfAngDriftPh, engulfAngDriftAmp,

      initialized: false,
      hadFirstHop: false,
      prevX: 0, prevY: 0,
      ctrlX: 0, ctrlY: 0,
      nextX: 0, nextY: 0,
      currentX: 0, currentY: 0,
      timer: rand(),
      hopMs: 2500 + rand() * 2000,

      tearDirX: 0, tearDirY: 0, tearReach: 0,

      // Pop dissipation: each dot picks an outward direction + reach
      // when the pop triggers. Position during pop = origin + dir*reach*ease.
      popDirX: 0, popDirY: 0,
      popReach: 0,
      popOriginX: 0, popOriginY: 0,
      popScale: 1,
    });
  }

  return {
    points,
    hover: 0,
    hoverTarget: 0,
    sibHover: 0,
    sibHoverTarget: 0,
    centroidX: 0,
    centroidY: 0,
    phase: rand() * Math.PI * 2,
    tearActiveIdx: -1,
    tearMs: 0,
    tearCooldown: 4000 + rand() * 9000,
    lastTearIdx: -1,
    respawning: false,
    respawnT: 0,
    respawnFade: 1,
    // effHover = hover when steady; during pop it decays smoothly to 0
    // even though state.hover is held frozen. Used as u_hover in the
    // shader so OTHER cards' rival/hueRival fades ramp back in over the
    // pop window instead of snapping at teleport.
    effHover: 0,
    popInitialHover: 0,
    // Cohesion factor: 1 at rest, drops to 0 quickly during pop. Sent
    // as u_dispersion[i]. Distinct from respawnFade (slower per-dot
    // alpha fade) and effHover (rival decay).
    dispersion: 1,
    teleported: false,
    prevHoverTarget: 0,
    // Pop-delay timer: -1 when inactive, ≥0 counts up while we're
    // holding the cloud frozen between unhover and the actual pop
    // (see POP_DELAY_MS). Reset to -1 if hoverTarget goes back up.
    popDelayT: -1,
    // Debug-scrubber: when true, the respawn timeline is driven
    // externally (via scrubPop) instead of advancing per-frame, and
    // the natural allDone reset is suppressed.
    respawnPaused: false,
  };
}

function compileShader(gl, src, type) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    console.error(`[metaballs] shader compile error:\n${log}\n${src}`);
    throw new Error('Shader compile failed');
  }
  return sh;
}

function linkProgram(gl, vs, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[metaballs] program link error:', gl.getProgramInfoLog(prog));
    throw new Error('Program link failed');
  }
  return prog;
}

export function mountField(canvas, cards) {
  const NCARDS = cards.length;
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
  if (!gl) {
    canvas.style.display = 'none';
    console.warn('[metaballs] WebGL2 unsupported, hiding field canvas');
    return { setHover: () => {} };
  }

  const vs = compileShader(gl, vertSource, gl.VERTEX_SHADER);
  const fs = compileShader(gl, fragSource, gl.FRAGMENT_SHADER);
  const program = linkProgram(gl, vs, fs);
  gl.useProgram(program);

  const quad = new Float32Array([
    -1, -1,  1, -1, -1,  1,
    -1,  1,  1, -1,  1,  1,
  ]);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // All per-card uniforms are arrays; uniform locations point at the
  // array base and the vec3fv/etc setters can fill the whole array.
  const u = {
    points:     gl.getUniformLocation(program, 'u_points'),
    palette:    gl.getUniformLocation(program, 'u_palette'),
    centroid:   gl.getUniformLocation(program, 'u_centroid'),
    radius:     gl.getUniformLocation(program, 'u_radius'),
    hover:      gl.getUniformLocation(program, 'u_hover'),
    fade:       gl.getUniformLocation(program, 'u_fade'),
    hueFade:    gl.getUniformLocation(program, 'u_hueFade'),
    dispersion: gl.getUniformLocation(program, 'u_dispersion'),
    rivalCoverBody: gl.getUniformLocation(program, 'u_rivalCoverBody'),
    rivalCoverHalo: gl.getUniformLocation(program, 'u_rivalCoverHalo'),
    cardCenter: gl.getUniformLocation(program, 'u_cardCenter'),
    cardSize:   gl.getUniformLocation(program, 'u_cardSize'),

    threshold:  gl.getUniformLocation(program, 'u_threshold'),
    resolution: gl.getUniformLocation(program, 'u_resolution'),
    time:       gl.getUniformLocation(program, 'u_time'),
    debugDots:  gl.getUniformLocation(program, 'u_debugDots'),
    invis:      gl.getUniformLocation(program, 'u_invis'),
    dpr:        gl.getUniformLocation(program, 'u_dpr'),
  };

  // States/buffers indexed by card.
  const states = cards.map((_, i) => makeCardState(101 + i * 101));

  // Flat palette buffer: NCARDS × PALETTE_SIZE × 3.
  const paletteBuf = new Float32Array(NCARDS * PALETTE_SIZE * 3);
  cards.forEach((c, ci) => {
    c.palette.forEach((hex, i) => {
      const rgb = hexToRGB(hex);
      const base = (ci * PALETTE_SIZE + i) * 3;
      paletteBuf[base]     = rgb[0];
      paletteBuf[base + 1] = rgb[1];
      paletteBuf[base + 2] = rgb[2];
    });
  });

  gl.uniform3fv(u.palette, paletteBuf);
  gl.uniform1f(u.threshold, THRESHOLD);
  gl.uniform1f(u.debugDots, (DEBUG_DOTS || DEBUG_INVIS) ? 1 : 0);
  gl.uniform1f(u.invis, DEBUG_INVIS ? 1 : 0);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  let dpr = 1;
  let canvasW = 0;
  let canvasH = 0;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    canvasW = Math.round(window.innerWidth * dpr);
    canvasH = Math.round(window.innerHeight * dpr);
    canvas.width = canvasW;
    canvas.height = canvasH;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    gl.viewport(0, 0, canvasW, canvasH);
    gl.uniform2f(u.resolution, canvasW, canvasH);
    gl.uniform1f(u.dpr, dpr);
  }
  resize();
  window.addEventListener('resize', resize);

  // Flat point buffer: NCARDS × N × 3.
  const pointBuf = new Float32Array(NCARDS * N * 3);
  // Per-card scratch slice into pointBuf (avoids re-allocating).
  const cardSlices = states.map((_, ci) =>
    pointBuf.subarray(ci * N * 3, (ci + 1) * N * 3)
  );

  const centroidBuf = new Float32Array(NCARDS * 2);
  const radiusBuf   = new Float32Array(NCARDS);
  const hoverBuf    = new Float32Array(NCARDS);
  const fadeBuf     = new Float32Array(NCARDS);
  const hueFadeBuf  = new Float32Array(NCARDS);
  const dispersionBuf = new Float32Array(NCARDS);
  const rivalCoverBodyBuf = new Float32Array(NCARDS);
  const rivalCoverHaloBuf = new Float32Array(NCARDS);
  // Last forward-sampled coverage per rival. While no engulfer is
  // popping, this is updated every frame from totalField. When a pop
  // fires, the snapshot is held and just scaled down to 0 over the
  // pop window — i.e. the disappear curve played in reverse.
  const popSnapBody = new Float32Array(NCARDS);
  const popSnapHalo = new Float32Array(NCARDS);
  const centerBuf   = new Float32Array(NCARDS * 2);
  const sizeBuf     = new Float32Array(NCARDS * 2);

  function getCardCenter(el) {
    const r = el.getBoundingClientRect();
    return [(r.left + r.width / 2) * dpr, (r.top + r.height / 2) * dpr];
  }

  function getCardHalfSize(el) {
    const r = el.getBoundingClientRect();
    return [(r.width / 2) * dpr, (r.height / 2) * dpr];
  }

  function evalSlot(p, state, cx, cy, now) {
    // Per-dot tt + phase so each dot's breathing is on its own rhythm
    // — desyncs the cloud-wide "stop together" beats.
    const tt = (now + p.membraneTimeShift) * MEMBRANE_T_SCALE;
    const theta = p.slot + p.wiggleAmp * Math.sin(now * p.wiggleFreq + p.wigglePhase);
    const r = MEMBRANE_R_BASE_CSS *
      (1 + MEMBRANE_AMP * membraneDeform(theta, tt, state.phase + p.membranePhaseShift));

    const dom = Math.max(state.hover, state.sibHover);
    const flameStrength = Math.max(0, 1 - dom * 4);
    const upness = Math.max(0, -Math.sin(theta));
    const downness = Math.max(0, Math.sin(theta));
    const flicker = 1 + 0.18 * Math.sin(now * 0.0008 + state.phase * 1.3);
    const tip = upness * upness * flicker;
    const yStretch  = 1 + flameStrength * tip * 1.1;
    const xSqueeze  = 1 - flameStrength * tip * 0.45;
    const baseWiden = 1 + flameStrength * downness * 0.18;

    const rx = r * xSqueeze * baseWiden;
    const ry = r * yStretch;

    return [
      cx + Math.cos(theta) * rx * dpr,
      cy + Math.sin(theta) * ry * Y_COMPRESS * dpr,
    ];
  }

  function maxOutwardPx(selfCenter) {
    const [cx, cy] = selfCenter;
    const corners = [
      [0, 0], [canvasW, 0], [0, canvasH], [canvasW, canvasH],
    ];
    let maxD = 0;
    for (const [x, y] of corners) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > maxD) maxD = d;
    }
    return maxD + ENGULF_MARGIN_CSS * dpr;
  }

  function pickNextHop(p, state, selfCenter, now) {
    const [sx, sy] = selfCenter;
    const hover    = state.hover;
    const sibHover = state.sibHover;

    const [homeAbsX, homeAbsY] = evalSlot(p, state, sx, sy, now);
    const dxHome = homeAbsX - p.prevX;
    const dyHome = homeAbsY - p.prevY;
    const homeDist = Math.hypot(dxHome, dyHome);
    const homeUnitX = homeDist > 0.1 ? dxHome / homeDist : 0;
    const homeUnitY = homeDist > 0.1 ? dyHome / homeDist : 0;

    let driftTargetX = p.prevX;
    let driftTargetY = p.prevY;
    let driftStepLen = 0;

    if (hover > 0.05) {
      const dx = p.prevX - sx;
      const dy = p.prevY - sy;
      const len = Math.max(Math.hypot(dx, dy), 1);
      const reachWobble =
        1 + p.engulfDriftAmp *
            (0.65 * Math.sin(now * p.engulfDriftFq * 5.0 + p.engulfDriftPh) +
             0.35 * Math.sin(now * p.engulfDriftFq * 11.0 + p.engulfDriftPh * 1.7));
      // Cap the combined reach factor so dots stay within ~1.3×
      // viewport diagonal. Without this cap, engulfReach (≤2.40) ×
      // clusterScale (≤1.90) × reachWobble (≤2.8) compounds to ~12×,
      // sending dots far past the viewport — they cost compute, can
      // accumulate into floating-point edge cases, and produced the
      // visible "cloud blips in and out" frame corruption.
      const reachFactor = Math.min(
        p.engulfReach * p.clusterScale * Math.max(reachWobble, 0.15),
        1.30,
      );
      const cap = maxOutwardPx(selfCenter) * reachFactor;
      const baseAng = Math.atan2(dy, dx);
      const angWobble =
        p.engulfAngDriftAmp *
        (0.60 * Math.sin(now * p.engulfAngDriftFq * 4.5 + p.engulfAngDriftPh) +
         0.40 * Math.sin(now * p.engulfAngDriftFq * 9.0 + p.engulfAngDriftPh * 2.3));
      const ang = baseAng + p.engulfAngBias + angWobble;
      driftTargetX = sx + Math.cos(ang) * cap;
      driftTargetY = sy + Math.sin(ang) * cap;
      const dxD = driftTargetX - p.prevX;
      const dyD = driftTargetY - p.prevY;
      const distToDrift = Math.hypot(dxD, dyD);
      const baseStep = 35 + Math.random() * 110;
      const w = hover;
      driftStepLen = Math.min(baseStep * dpr * w, distToDrift * 0.6);
    } else if (sibHover > 0.05) {
      driftTargetX = sx;
      driftTargetY = sy;
      const dxD = sx - p.prevX;
      const dyD = sy - p.prevY;
      const distToDrift = Math.hypot(dxD, dyD);
      const baseStep = 8 + Math.random() * 14;
      const w = sibHover;
      driftStepLen = Math.min(baseStep * dpr * w, distToDrift * 0.6);
    }

    const dxDrift = driftTargetX - p.prevX;
    const dyDrift = driftTargetY - p.prevY;
    const distToDrift = Math.hypot(dxDrift, dyDrift);
    const driftDirX = distToDrift > 0.1 ? dxDrift / distToDrift : 0;
    const driftDirY = distToDrift > 0.1 ? dyDrift / distToDrift : 0;

    const dominantHover = Math.max(hover, sibHover);
    const homePullWeight = 1 - dominantHover;
    const homeStepLen = homeDist * 0.85 * homePullWeight;

    const wanderAngle = Math.random() * Math.PI * 2;
    const wanderMag = (4 + Math.random() * 8 + dominantHover * 75 * Math.random()) * dpr;
    const wanderX = Math.cos(wanderAngle) * wanderMag;
    const wanderY = Math.sin(wanderAngle) * wanderMag;

    let stepX = homeUnitX * homeStepLen + driftDirX * driftStepLen + wanderX;
    let stepY = homeUnitY * homeStepLen + driftDirY * driftStepLen + wanderY;

    const stepLen = Math.hypot(stepX, stepY);
    const stepUnitX = stepLen > 0.1 ? stepX / stepLen : 0;
    const stepUnitY = stepLen > 0.1 ? stepY / stepLen : 0;
    const tangAmt = (Math.random() - 0.5) * stepLen * (0.35 + dominantHover * 0.85);
    stepX += -stepUnitY * tangAmt;
    stepY +=  stepUnitX * tangAmt;

    p.nextX = p.prevX + stepX;
    p.nextY = p.prevY + stepY;

    const segDX = p.nextX - p.prevX;
    const segDY = p.nextY - p.prevY;
    const segLen = Math.max(Math.hypot(segDX, segDY), 1);
    const perpX = -segDY / segLen;
    const perpY =  segDX / segLen;
    const perpAmt = (Math.random() - 0.5) * segLen * 0.4;
    const freeCtrlX = (p.prevX + p.nextX) * 0.5 + perpX * perpAmt;
    const freeCtrlY = (p.prevY + p.nextY) * 0.5 + perpY * perpAmt;

    if (p.hadFirstHop) {
      const reflectX = 2 * p.prevX - p.ctrlX;
      const reflectY = 2 * p.prevY - p.ctrlY;
      p.ctrlX = reflectX * 0.7 + freeCtrlX * 0.3;
      p.ctrlY = reflectY * 0.7 + freeCtrlY * 0.3;
    } else {
      p.ctrlX = freeCtrlX;
      p.ctrlY = freeCtrlY;
      p.hadFirstHop = true;
    }

    p.timer = 0;
    if (hover > 0.05) {
      p.hopMs = 1800 + Math.random() * 2400;
    } else if (sibHover > 0.05) {
      p.hopMs = 2400 + Math.random() * 2400;
    } else {
      p.hopMs = 3200 + Math.random() * 2200;
    }
  }

  function ensureInitialized(state, selfCenter, now) {
    const [sx, sy] = selfCenter;
    for (const p of state.points) {
      if (!p.initialized) {
        const [hx, hy] = evalSlot(p, state, sx, sy, now);
        const initRadial   = (Math.random() - 0.5) * 60 * dpr;
        const initTangential = (Math.random() - 0.5) * 18 * dpr;
        const tx = Math.cos(p.slot);
        const ty = Math.sin(p.slot) * Y_COMPRESS;
        p.prevX = hx + tx * initRadial - ty * initTangential;
        p.prevY = hy + ty * initRadial + tx * initTangential;
        p.currentX = p.prevX;
        p.currentY = p.prevY;
        p.timer = Math.random();
        p.initialized = true;
        pickNextHop(p, state, selfCenter, now);
      }
    }
  }

  // Returns true if any state OTHER than `meIdx` has an active tear.
  function anyOtherTearing(meIdx) {
    for (let j = 0; j < NCARDS; j++) {
      if (j !== meIdx && states[j].tearActiveIdx >= 0) return j;
    }
    return -1;
  }

  function computePoints(state, stateIdx, selfCenter, dt, now, out) {
    ensureInitialized(state, selfCenter, now);

    if (state.respawning) {
      const k = Math.min(state.respawnT / POP_DURATION_MS, 1);
      const ease = 1 - Math.pow(1 - k, 1.8);
      for (let i = 0; i < N; i++) {
        const p = state.points[i];
        out[i * 3]     = p.popOriginX + p.popDirX * p.popReach * ease;
        out[i * 3 + 1] = p.popOriginY + p.popDirY * p.popReach * ease;
        out[i * 3 + 2] = p.radiusMul;
      }
      return;
    }

    const TEAR_FLY = 1700;
    const TEAR_GONE = 700;
    const TEAR_BACK = 700;
    const TEAR_TOTAL = TEAR_FLY + TEAR_GONE + TEAR_BACK;
    const cardAtRest = state.hover < 0.05 && state.sibHover < 0.05 && !state.respawning;

    const otherTearingIdx = anyOtherTearing(stateIdx);
    if (otherTearingIdx >= 0) {
      const sibRemaining = TEAR_TOTAL - states[otherTearingIdx].tearMs;
      const minWait = sibRemaining + 2000 + Math.random() * 1000;
      if (state.tearCooldown < minWait) state.tearCooldown = minWait;
    }

    if (state.tearActiveIdx >= 0) {
      state.tearMs += dt;
      if (state.tearMs >= TEAR_TOTAL) {
        state.tearActiveIdx = -1;
        state.tearMs = 0;
        state.tearCooldown = 4000 + Math.random() * 9000;
      }
    } else if (cardAtRest) {
      state.tearCooldown -= dt;
      if (state.tearCooldown <= 0) {
        let idx;
        do {
          idx = (Math.random() * state.points.length) | 0;
        } while (idx === state.lastTearIdx && state.points.length > 1);
        state.lastTearIdx = idx;
        const p = state.points[idx];
        const dx = p.currentX - selfCenter[0];
        const dy = p.currentY - selfCenter[1];
        const baseAng = Math.atan2(dy, dx);
        const ang = baseAng + (Math.random() - 0.5) * 0.8;
        p.tearDirX = Math.cos(ang);
        p.tearDirY = Math.sin(ang);
        p.tearReach = 280 + Math.random() * 200;
        state.tearActiveIdx = idx;
        state.tearMs = 0;
      }
    } else {
      state.tearCooldown = Math.max(state.tearCooldown, 6000 + Math.random() * 8000);
    }

    let cx = 0;
    let cy = 0;

    for (let i = 0; i < N; i++) {
      const p = state.points[i];

      p.timer += dt / p.hopMs;
      while (p.timer >= 1) {
        p.timer -= 1;
        p.prevX = p.nextX;
        p.prevY = p.nextY;
        pickNextHop(p, state, selfCenter, now);
      }

      const t = p.timer;
      const u_ = 1 - t;
      const x = u_ * u_ * p.prevX + 2 * u_ * t * p.ctrlX + t * t * p.nextX;
      const y = u_ * u_ * p.prevY + 2 * u_ * t * p.ctrlY + t * t * p.nextY;

      p.currentX = x;
      p.currentY = y;

      const dom = Math.max(state.hover, state.sibHover);
      const pulseScale = 1 + dom * 3;
      const pulse = 1 + p.pulseAmp * pulseScale * Math.sin(now * p.pulseFreq + p.pulsePhase);

      let tearScale = 1;
      let tearOffX = 0;
      let tearOffY = 0;
      let tearRadiusBoost = 1;
      if (state.tearActiveIdx === i) {
        if (state.tearMs < TEAR_FLY) {
          const k = state.tearMs / TEAR_FLY;
          const reach = (0.5 * k + 0.5 * Math.pow(k, 0.7)) * p.tearReach * dpr;
          tearOffX = p.tearDirX * reach;
          tearOffY = p.tearDirY * reach;
          tearScale = k < 0.6 ? 1 : 1 - Math.pow((k - 0.6) / 0.4, 1.6);
          tearRadiusBoost = 3.0;
        } else if (state.tearMs < TEAR_FLY + TEAR_GONE) {
          tearScale = 0;
        } else {
          const k = (state.tearMs - TEAR_FLY - TEAR_GONE) / TEAR_BACK;
          tearScale = k * k * (3 - 2 * k);
        }
      }

      out[i * 3]     = x + tearOffX;
      out[i * 3 + 1] = y + tearOffY;
      out[i * 3 + 2] = p.radiusMul * pulse * tearScale * tearRadiusBoost * p.popScale;

      cx += x;
      cy += y;
    }
    state.centroidX = cx / N;
    state.centroidY = cy / N;
  }

  // Helper: returns max hover/hoverTarget across all cards EXCEPT meIdx.
  function maxOtherHoverTarget(meIdx) {
    let m = 0;
    for (let j = 0; j < NCARDS; j++) {
      if (j !== meIdx && states[j].hoverTarget > m) m = states[j].hoverTarget;
    }
    return m;
  }

  let lastT = performance.now();
  function frame(now) {
    const dt = Math.min(now - lastT, 100);
    lastT = now;

    // Each card's sibHover follows the max hover-target across ALL OTHER
    // cards. With 3+ cards, "any other engulfing" triggers the converge.
    for (let i = 0; i < NCARDS; i++) {
      states[i].sibHoverTarget = maxOtherHoverTarget(i);
    }

    for (const s of states) {
      if (s.respawning) continue;
      // Re-hover during the pop-delay cancels it.
      if (s.popDelayT >= 0 && s.hoverTarget > 0) s.popDelayT = -1;
      // While the pop is held in delay, freeze hover at its engaged
      // level so the cloud lingers visibly instead of decaying away
      // before the snap fires.
      const inDelay = s.popDelayT >= 0;
      if (!inDelay) {
        const goingUp = s.hoverTarget > s.hover;
        const speed = goingUp ? dt / HOVER_UP_MS : dt / HOVER_DOWN_MS;
        if (goingUp) s.hover = Math.min(s.hover + speed, s.hoverTarget);
        else         s.hover = Math.max(s.hover - speed, s.hoverTarget);
      }

      const sibUp = s.sibHoverTarget > s.sibHover;
      const sibSpeed = sibUp ? dt / HOVER_UP_MS : dt / HOVER_DOWN_MS;
      if (sibUp) s.sibHover = Math.min(s.sibHover + sibSpeed, s.sibHoverTarget);
      else       s.sibHover = Math.max(s.sibHover - sibSpeed, s.sibHoverTarget);
    }

    const centers = cards.map(c => getCardCenter(c.el));

    for (let i = 0; i < NCARDS; i++) {
      const s = states[i];
      const center = centers[i];

      // Pop on unhover, after a brief hold. The moment own hoverTarget
      // transitions to 0 with the cloud meaningfully engaged (hover
      // above POP_THRESHOLD), we start a POP_DELAY_MS timer; when it
      // elapses the membrane "snaps" and dots scatter in random
      // directions. Sub-threshold hover (brief glances, mouseover-
      // and-leave) skips the pop entirely and decays via HOVER_DOWN_MS.
      const popCandidate = !s.respawning && s.hoverTarget === 0 && s.hover > POP_THRESHOLD;
      if (popCandidate) {
        if (s.popDelayT < 0) s.popDelayT = 0;
        else                 s.popDelayT += dt;
      }
      const ownReady = popCandidate && s.popDelayT >= POP_DELAY_MS;
      if (ownReady) {
        s.respawning = true;
        s.respawnT = 0;
        s.teleported = false;
        s.popDelayT = -1;
        s.popInitialHover = s.hover;
        for (const p of s.points) {
          // Pure random direction per dot — binding-force snap.
          const ang = Math.random() * Math.PI * 2;
          p.popDirX = Math.cos(ang);
          p.popDirY = Math.sin(ang);
          // Wide reach so the 28 dots fan out clearly across the
          // viewport rather than huddling near the chip.
          p.popReach = (320 + Math.random() * 520) * dpr;
          p.popOriginX = p.currentX;
          p.popOriginY = p.currentY;
          p.popScale = 1;
        }
      }

      if (!s.respawning) {
        s.respawnFade = 1;
        s.effHover = s.hover;
        s.dispersion = 1;
        for (const p of s.points) p.popScale = 1;
        continue;
      }
      // While the debug scrubber is driving respawnT, don't auto-advance.
      if (!s.respawnPaused) s.respawnT += dt;

      const k  = Math.min(s.respawnT / POP_DURATION_MS, 1);
      const kd = Math.min(s.respawnT / POP_DISPERSION_MS, 1);
      const kh = Math.min(s.respawnT / POP_HOVER_DECAY_MS, 1);
      // Per-dot alpha fades over the full pop window (slow), so dots
      // remain individually visible as they scatter before disappearing.
      s.respawnFade = 1 - k * k * (3 - 2 * k);
      // Dispersion (cohesion gate) collapses fast — the cohesive cloud
      // parts vanish in ~220ms, leaving individual dot kernels.
      s.dispersion = 1 - kd * kd * (3 - 2 * kd);
      // effHover for rival math: smooth drop over POP_HOVER_DECAY_MS.
      // Other cards' hueRival ramps back in over this window — still
      // feels like a snap to "engulfing card is gone" but doesn't
      // jump in a single frame.
      s.effHover = s.popInitialHover * (1 - kh * kh * (3 - 2 * kh));

      const allDone = !s.respawnPaused && s.respawnT >= POP_DURATION_MS + POP_HOLD_MS;

      if (allDone) {
        const [sx, sy] = center;
        for (const p of s.points) {
          const ox = (Math.random() - 0.5) * 22 * dpr;
          const oy = (Math.random() - 0.5) * 22 * dpr;
          p.prevX = sx + ox;
          p.prevY = sy + oy;
          p.currentX = p.prevX;
          p.currentY = p.prevY;
          p.hadFirstHop = false;
          p.timer = Math.random() * 0.3;
          p.popScale = 1;
          pickNextHop(p, s, center, now);
        }
        s.hover = 0;
        s.sibHover = 0;
        s.respawning = false;
        s.teleported = false;
        s.respawnFade = 1;
        s.effHover = 0;
        s.dispersion = 1;
        s.tearActiveIdx = -1;
        s.tearMs = 0;
        s.tearCooldown = 5000 + Math.random() * 9000;
      }
    }

    // Compute points + per-card uniform values.
    for (let i = 0; i < NCARDS; i++) {
      computePoints(states[i], i, centers[i], dt, now, cardSlices[i]);
    }

    // Reactive rival coverage — for each rival, sample the actual
    // engulfing cloud field at its chip center. Pure function of the
    // current dot positions / radius / hover, so if the engulf hover
    // pauses mid-ramp, the rival's fade pauses with it. No
    // pre-baked timing curves.
    //
    // Two thresholds against the same field magnitude:
    //   haloCov: low threshold (cloud's edge starting to touch) → fades
    //            the rival's soft outer halo before it gets revealed
    //   bodyCov: high threshold (cloud actually arriving on chip) →
    //            fades the rival's body / dots / color / text
    // If any engulfer is popping, use the most-advanced pop's progress
    // to drive the reverse animation for ALL rivals.
    let popReverseK = -1;
    for (let o = 0; o < NCARDS; o++) {
      if (states[o].respawning) {
        const k = Math.min(states[o].respawnT / POP_DURATION_MS, 1);
        if (k > popReverseK) popReverseK = k;
      }
    }
    for (let i = 0; i < NCARDS; i++) {
      const [tx, ty] = centers[i];
      const half = getCardHalfSize(cards[i].el);
      const hx = half[0], hy = half[1];
      // Sample at center + 4 corners — text fades when ANY part of the
      // chip is engulfed, matching the shader's per-pixel takeover
      // (which can erode the rectangle from the edge before the
      // engulfer's mass arrives at the chip center).
      const samples = [
        [tx, ty],
        [tx - hx, ty - hy],
        [tx + hx, ty - hy],
        [tx - hx, ty + hy],
        [tx + hx, ty + hy],
      ];
      let totalField = 0;
      for (let o = 0; o < NCARDS; o++) {
        if (o === i) continue;
        const sO = states[o];
        if (sO.respawning) continue;
        const eH = sO.hover;
        if (eH < 0.001) continue;
        const radius = BASE_RADIUS_CSS * dpr * (1 + eH * RADIUS_HOVER_SCALE);
        const maskScale = 1.0 + 1.6 * eH;
        for (let s = 0; s < samples.length; s++) {
          const sx = samples[s][0], sy = samples[s][1];
          let fieldAtSample = 0;
          for (const p of sO.points) {
            const r = radius * p.radiusMul;
            if (r < 0.5) continue;
            const dx = sx - p.currentX;
            const dy = sy - p.currentY;
            const dist = Math.hypot(dx, dy);
            const sig = r * 1.4;
            const m = 1 - smoothstep(r * 5 * maskScale, r * 7 * maskScale, dist);
            if (m <= 0) continue;
            fieldAtSample += Math.exp(-dist / sig) * m;
          }
          if (fieldAtSample > totalField) totalField = fieldAtSample;
        }
      }
      // Tunable thresholds — adjust if halo fades too early/late.
      // Lower thresholds — far rivals on edge cards (passport, lexicon)
      // get less totalField than the middle rival because half the
      // engulf cluster radiates off-canvas. Pulling the floors down
      // lets even partial coverage start fading the rival's hue body
      // and text. Tune higher if rivals start fading too early on
      // partial engulf.
      // Lowered bodyCov range so even partial engulf at long distances
      // (edge-to-edge cards) still triggers text fade — the shader-side
      // erosion now dissolves the blob much earlier than the old 0.20
      // floor was tuned for, so without lowering this the edge rivals'
      // blobs disappear but their text stays fully visible.
      let haloCov = smoothstep(0.02, 0.25, totalField);
      let bodyCov = smoothstep(0.05, 0.30, totalField);
      if (popReverseK >= 0) {
        // Pop active: hold the snapshot and play it in reverse.
        const ease = 1 - popReverseK * popReverseK * (3 - 2 * popReverseK);
        haloCov = popSnapHalo[i] * ease;
        bodyCov = popSnapBody[i] * ease;
      } else {
        // Forward: keep snapshot fresh so the next pop holds the right value.
        popSnapHalo[i] = haloCov;
        popSnapBody[i] = bodyCov;
      }
      rivalCoverHaloBuf[i] = haloCov;
      rivalCoverBodyBuf[i] = bodyCov;
      // Text follows body — only gone when chip body is engulfed.
      cards[i].el.style.opacity = String(1 - bodyCov);
    }

    // Pack uniforms.
    for (let i = 0; i < NCARDS; i++) {
      const s = states[i];
      centroidBuf[i * 2]     = s.centroidX;
      centroidBuf[i * 2 + 1] = s.centroidY;
      // Field radius:
      //   own hover up → expand (engulf)
      //   sib hover up → shrink (collapsing into chip while dots converge)
      const shrink = 1 - s.sibHover * 0.6;
      // Use effHover for both radius and the hover uniform so both
      // OWN rendering and OTHER cards' rival fades see a smooth
      // decay during pop, not a freeze-then-snap.
      const eff = s.respawning ? s.effHover : s.hover;
      radiusBuf[i] = BASE_RADIUS_CSS * dpr * (1 + eff * RADIUS_HOVER_SCALE) * shrink;
      hoverBuf[i] = eff;
      fadeBuf[i]  = s.respawnFade;
      hueFadeBuf[i] = 1;  // hue stays at full strength always
      dispersionBuf[i] = s.dispersion;
      const c = centers[i];
      centerBuf[i * 2]     = c[0];
      centerBuf[i * 2 + 1] = c[1];
      const half = getCardHalfSize(cards[i].el);
      sizeBuf[i * 2]     = half[0];
      sizeBuf[i * 2 + 1] = half[1];
    }

    gl.uniform3fv(u.points, pointBuf);
    gl.uniform2fv(u.centroid, centroidBuf);
    gl.uniform1fv(u.radius, radiusBuf);
    gl.uniform1fv(u.hover, hoverBuf);
    gl.uniform1fv(u.fade, fadeBuf);
    gl.uniform1fv(u.hueFade, hueFadeBuf);
    gl.uniform1fv(u.dispersion, dispersionBuf);
    gl.uniform1fv(u.rivalCoverBody, rivalCoverBodyBuf);
    gl.uniform1fv(u.rivalCoverHalo, rivalCoverHaloBuf);
    gl.uniform2fv(u.cardCenter, centerBuf);
    gl.uniform2fv(u.cardSize, sizeBuf);
    gl.uniform1f(u.time, now);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (!firstFrameDone) {
      firstFrameDone = true;
      canvas.dispatchEvent(new CustomEvent('field:ready'));
    }

    requestAnimationFrame(frame);
  }
  let firstFrameDone = false;
  requestAnimationFrame(frame);

  return {
    setHover(idx, on) {
      states[idx].hoverTarget = on ? 1 : 0;
    },
    // Debug scrubber: directly set hover and hoverTarget to a value,
    // bypassing the slow ramps. Cancels any in-flight pop or pop-delay.
    scrubHover(idx, value) {
      const s = states[idx];
      const v = Math.max(0, Math.min(1, value));
      s.hover = v;
      s.hoverTarget = v;
      s.popDelayT = -1;
      // If we were popping, abort and snap back to the scrubbed level.
      if (s.respawning) {
        s.respawning = false;
        s.respawnT = 0;
        s.respawnFade = 1;
        s.dispersion = 1;
        s.effHover = v;
      }
    },
    // Debug release: simulate a "let go of mouse" event. Sets
    // hoverTarget=0 only, leaving hover at its current level so the
    // existing pop-delay → pop pipeline fires naturally.
    releaseHover(idx) {
      states[idx].hoverTarget = 0;
    },
    // Debug: trigger pop immediately at the current hover and pause
    // the respawn timeline at t=0, ready to be scrubbed by scrubPop.
    // No-op if the card isn't hovered enough or is already popping.
    popPaused(idx) {
      const s = states[idx];
      if (s.respawning) return false;
      if (s.hover <= 0.001) return false;
      s.respawning = true;
      s.respawnT = 0;
      s.respawnPaused = true;
      s.teleported = false;
      s.popDelayT = -1;
      s.hoverTarget = 0;
      s.popInitialHover = s.hover;
      for (const p of s.points) {
        const ang = Math.random() * Math.PI * 2;
        p.popDirX = Math.cos(ang);
        p.popDirY = Math.sin(ang);
        p.popReach = (320 + Math.random() * 520) * dpr;
        p.popOriginX = p.currentX;
        p.popOriginY = p.currentY;
        p.popScale = 1;
      }
      return true;
    },
    // Debug scrubber for the pop timeline. value 0..1 maps to
    // respawnT in [0, POP_DURATION_MS + POP_HOLD_MS]. Only effective
    // while popPaused is in effect.
    scrubPop(idx, value) {
      const s = states[idx];
      if (!s.respawning || !s.respawnPaused) return;
      const v = Math.max(0, Math.min(1, value));
      s.respawnT = v * (POP_DURATION_MS + POP_HOLD_MS);
    },
    // Debug play: unpause an already-popping card so respawnT
    // auto-advances per frame at real-time pace. The natural
    // allDone reset will fire when respawnT reaches the end.
    playPop(idx) {
      const s = states[idx];
      if (!s.respawning) return;
      s.respawnPaused = false;
    },
    // Debug pause: re-pause an in-flight pop. Slider-driven scrubbing
    // requires this — playPop releases pause; pausePop re-locks it.
    pausePop(idx) {
      const s = states[idx];
      if (!s.respawning) return;
      s.respawnPaused = true;
    },
    // Debug getter: respawnT normalized to 0..1, or 0 when not popping.
    getPopT01(idx) {
      const s = states[idx];
      if (!s.respawning) return 0;
      return Math.min(1, s.respawnT / (POP_DURATION_MS + POP_HOLD_MS));
    },
    isRespawning(idx) {
      return states[idx].respawning;
    },
    popTotalMs: POP_DURATION_MS + POP_HOLD_MS,
    // Debug: leave release-mode and snap the card back to rest.
    endPop(idx) {
      const s = states[idx];
      s.respawning = false;
      s.respawnPaused = false;
      s.respawnT = 0;
      s.respawnFade = 1;
      s.dispersion = 1;
      s.effHover = 0;
      s.hover = 0;
      s.hoverTarget = 0;
      s.popDelayT = -1;
      s.teleported = false;
    },
    cardCount: NCARDS,
  };
}
