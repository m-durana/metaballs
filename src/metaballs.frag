#version 300 es
precision highp float;

#define N 20
#define NCARDS 3
#define PALETTE_SIZE 5

// All per-card uniforms are flat arrays indexed by card index. This
// lets the shader generalize over any number of cards (currently 3)
// without A/B/C duplication. Per-dot data is packed as
// u_points[card * N + i] = vec3(x, y, radiusMul).
uniform vec3  u_points[NCARDS * N];
uniform vec3  u_palette[NCARDS * PALETTE_SIZE];
uniform vec2  u_centroid[NCARDS];
uniform float u_radius[NCARDS];
uniform float u_hover[NCARDS];
uniform float u_fade[NCARDS];
uniform float u_hueFade[NCARDS];
// Cohesion gate — 1 at rest, drops to 0 fast at pop start. Multiplies
// the parts of the field that read as "one cloud" rather than as
// individual dots: baseline fill, centroid Gaussian, and the wide
// per-dot halo. With these silenced fast, the field collapses into
// 28 individual dot kernels that then scatter via popDir.
uniform float u_dispersion[NCARDS];
// Per-card coverage values, computed in JS by sampling the actual
// engulfing cloud field at each rival's chip center. Reactive — if
// the cloud's growth stalls, the rival's fade stalls with it.
//   bodyCov: drives dots / color / hue BODY / text — fades when
//            cloud is actually arriving at the chip body.
//   haloCov: drives hue HALO only — fades much earlier (low threshold)
//            so the rival's invisible halo never gets revealed by the
//            engulfing cloud's field amplifying it past alpha threshold.
uniform float u_rivalCoverBody[NCARDS];
uniform float u_rivalCoverHalo[NCARDS];
uniform vec2  u_cardCenter[NCARDS];
uniform vec2  u_cardSize[NCARDS];

uniform float u_threshold;
uniform vec2  u_resolution;
uniform float u_time;
uniform float u_debugDots;
uniform float u_invis;
uniform float u_dpr;

out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 78.233);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  return vnoise(p);
}

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec3 paletteAround(vec2 p, vec2 center, int cardIdx, float t) {
  vec2  d    = p - center;
  float soft = 90.0 * u_dpr;
  vec2  dir  = d / sqrt(dot(d, d) + soft * soft);
  float r    = length(d) * 0.0020;

  float ts = t * 0.00009;
  float ns = 0.0014 / u_dpr;

  vec2 turb = vec2(
    fbm(p * ns         + vec2(ts * 1.4,  ts * 0.7) +  3.1),
    fbm(p * ns * 1.7   + vec2(-ts * 0.6,  ts * 1.9) + 27.3)
  );

  // 2π-periodic angular harmonics — non-integer multipliers produced
  // a visible seam at the ±π wrap. 1× and 2× give chaotic sweep.
  float ang = atan(dir.y, dir.x);
  float u = clamp(
    0.5 + 0.35 * sin(ang + 1.7) + 0.20 * sin(ang * 2.0 + 0.3)
        + 0.55 * (turb.x - 0.5),
    0.0, 1.0);
  float v = clamp(
    r * 0.55 + 0.25 * cos(ang) + 0.65 * (turb.y - 0.5),
    0.0, 1.0);

  int base = cardIdx * PALETTE_SIZE;
  vec3 inner = mix(u_palette[base + 0], u_palette[base + 1], u);
  vec3 outer = mix(u_palette[base + 2], u_palette[base + 3], 1.0 - u);
  vec3 col   = mix(inner, outer, smoothstep(0.0, 1.0, v));

  col = mix(col, u_palette[base + 4],
            smoothstep(0.85, 1.0, 1.0 - clamp(r * 1.2, 0.0, 1.0)) * 0.4);
  return col;
}

// Max hover across all cards EXCEPT `me` — used for rival fades.
float otherMaxHover(int me) {
  float m = 0.0;
  for (int j = 0; j < NCARDS; j++) {
    if (j != me) m = max(m, u_hover[j]);
  }
  return m;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);

  // ?invis debug — three rings per dot (inner solid disc + 5×r and 7×r masks).
  if (u_invis > 0.5) {
    vec3 col = vec3(0.0);
    float a = 0.0;
    for (int c = 0; c < NCARDS; c++) {
      float maskScale = mix(1.0, 2.6, u_hover[c]);
      vec3 paletteSample = u_palette[c * PALETTE_SIZE];
      for (int i = 0; i < N; i++) {
        vec3 pt = u_points[c * N + i];
        vec2 d = p - pt.xy;
        float r = u_radius[c] * pt.z;
        float dist = length(d);
        if (r > 0.5) {
          if (dist < r) {
            col = mix(col, vec3(1.0), 0.45);
            a = max(a, 0.45);
          }
          float midR = r * 5.0 * maskScale;
          float ringMid = (1.0 - smoothstep(midR - 1.5*u_dpr, midR + 1.5*u_dpr, dist))
                        * smoothstep(midR - 3.0*u_dpr, midR - 1.5*u_dpr, dist);
          if (ringMid > 0.0) { col = mix(col, paletteSample, ringMid * 0.7); a = max(a, ringMid * 0.50); }
          float outR = r * 7.0 * maskScale;
          float ringOut = (1.0 - smoothstep(outR - 1.0*u_dpr, outR + 1.0*u_dpr, dist))
                        * smoothstep(outR - 2.0*u_dpr, outR - 1.0*u_dpr, dist);
          if (ringOut > 0.0) { col = mix(col, paletteSample, ringOut * 0.5); a = max(a, ringOut * 0.30); }
        }
      }
    }
    if (a < 0.001) discard;
    fragColor = vec4(col, a);
    return;
  }

  // ?dots — canonical render.
  if (u_debugDots > 0.5) {
    float warpScale = 0.0035 / u_dpr;
    float warpT = u_time * 0.00012;
    vec2 warp1 = vec2(
      fbm(p * warpScale + vec2(warpT,        0.0)),
      fbm(p * warpScale + vec2(0.0,         -warpT) + 11.4)
    );
    vec2 wDelta = (warp1 - 0.5) * u_dpr;

    // Per-card field accumulators.
    float fArr[NCARDS];
    float haloArr[NCARDS];
    for (int c = 0; c < NCARDS; c++) {
      fArr[c] = 0.0;
      haloArr[c] = 0.0;
    }

    // Dot contribution per card. Single math path for both rest and
    // pop — the prior branch on `u_fade < 0.999` produced a hard
    // snap (rendering instantly switched to inverse-square fallback
    // the moment respawnT crossed ~12ms, making the blob look 50%
    // smaller in one frame). Pop visibility is now driven smoothly
    // via dotShow (forced to 1 during pop) and u_fade (alpha decay).
    for (int c = 0; c < NCARDS; c++) {
      float maskScale = mix(1.0, 2.6, u_hover[c]);
      vec2 q = p + wDelta * (38.0 + 280.0 * u_hover[c]);
      float fc = 0.0;
      float hc = 0.0;
      for (int i = 0; i < N; i++) {
        vec3 pt = u_points[c * N + i];
        vec2 d = q - pt.xy;
        float r = u_radius[c] * pt.z;
        float dist = length(d);
        float sig = r * 1.4;
        float mask = 1.0 - smoothstep(r * 5.0 * maskScale, r * 7.0 * maskScale, dist);
        fc += exp(-dist / sig) * mask;
        float hSig = r * 3.0;
        float hMask = 1.0 - smoothstep(r * 8.0 * maskScale, r * 11.0 * maskScale, dist);
        hc += exp(-dist / hSig) * hMask;
      }
      fArr[c] = fc;
      // Halo gated by dispersion: at pop start it dies fast so the
      // wide soft glue between dots disappears, leaving sharper
      // per-dot kernels visible as individuals.
      haloArr[c] = hc * u_dispersion[c];
    }

    // Centroid Gaussian per card — fades across mid-hover, AND gated
    // by dispersion so it doesn't pop back in as hover decays during
    // the pop (which previously made the dispersion read as "membrane
    // shrinking back to chip" instead of "dots scattering").
    for (int c = 0; c < NCARDS; c++) {
      vec2 q = p + wDelta * (38.0 + 280.0 * u_hover[c]);
      vec2 dc = q - u_centroid[c];
      float coreSig = 60.0 * u_dpr;
      float core = exp(-dot(dc, dc) / (coreSig * coreSig));
      fArr[c] += core * (1.0 - smoothstep(0.30, 0.85, u_hover[c])) * u_dispersion[c];
    }

    // Apply gating: dotShow gates dots in by hover, rival fades dots
    // out as ANY other card engages, u_fade handles pop dissipate.
    // During pop, dotShow is forced to 1 via max(..., 1 - u_fade) so
    // per-dot kernels remain rendered as they scatter (otherwise the
    // u_hover decay would kill them via the smoothstep before the
    // scatter is visible). At rest u_fade=1, so the max collapses to
    // the original hover-driven smoothstep — rest behavior unchanged.
    for (int c = 0; c < NCARDS; c++) {
      float baseDotShow = smoothstep(0.0, 0.25, u_hover[c]);
      float dotShow = max(baseDotShow, 1.0 - u_fade[c]);
      float rival   = 1.0 - u_rivalCoverBody[c];
      float dotMask = dotShow * rival * u_fade[c];
      fArr[c]    *= dotMask;
      haloArr[c] *= dotMask;
      // Baseline fill at full engulf — gated by dispersion so it
      // collapses with the rest of the cohesive cloud when popping.
      fArr[c] += smoothstep(0.45, 1.0, u_hover[c]) * 0.95 * rival * u_fade[c] * u_dispersion[c];
    }

    // Hue rectangle — split into a tight BODY and a wide FEATHER so
    // we can knock out the feather (the wide transition zone that any
    // approaching engulfer's field could amplify past alpha threshold,
    // tracing the chip outline as a visible border) per-pixel under
    // takeover, while keeping the body and the *active* card's feather
    // fully alive. fArr/haloArr at this point hold dots+centroid only
    // — the engulfer's non-rect field — so they ARE the takeover
    // signal. Active card is exempt so its own feather can still warp
    // outward into the blob.
    vec2  hueWarpDelta = (warp1 - 0.5) * 12.0 * u_dpr;
    vec2  hueInflate   = vec2(4.0, -6.0) * u_dpr;
    float hueCorner    = 24.0 * u_dpr;
    for (int c = 0; c < NCARDS; c++) {
      // Per-pixel "other field" strength — how strongly some OTHER
      // engaged card's non-rect field is reaching this pixel. fArr/
      // haloArr at this loop point hold dots+centroid only (rectangle
      // not added yet), so they're a clean takeover signal. Active
      // card is exempted so its own rectangle stays intact for the
      // organic outward morph.
      float otherTakeover = 0.0;
      for (int j = 0; j < NCARDS; j++) {
        if (j == c) continue;
        float hj = smoothstep(0.04, 0.20, u_hover[j]);
        float threat = fArr[j] + haloArr[j] * 1.25;
        float popDecay = u_fade[j] * u_fade[j];
        otherTakeover = max(otherTakeover, hj * threat * popDecay);
      }
      float isActive = smoothstep(0.05, 0.25, u_hover[c]);
      float erodeAmount = otherTakeover * 60.0 * u_dpr * (1.0 - isActive);

      float dC = sdRoundBox(p - u_cardCenter[c] + hueWarpDelta,
                            u_cardSize[c] + hueInflate, hueCorner);
      float hue = 1.0 - smoothstep(-30.0 * u_dpr, 20.0 * u_dpr, dC + erodeAmount);

      float bodyRival = 1.0 - u_rivalCoverBody[c];
      float haloRival = 1.0 - u_rivalCoverHalo[c];
      fArr[c]    += hue * 1.6 * bodyRival * u_hueFade[c];
      haloArr[c] += hue * 1.4 * haloRival * u_hueFade[c];
    }

    // Combine — max field across cards drives alpha.
    float maxF = 0.0;
    float maxH = 0.0;
    for (int c = 0; c < NCARDS; c++) {
      maxF = max(maxF, fArr[c]);
      maxH = max(maxH, haloArr[c]);
    }
    if (maxF < 0.002 && maxH < 0.002) discard;

    const vec3 BG = vec3(0.055, 0.055, 0.063);

    // Per-card color (palette evaluated around centroid), weighted by
    // f² so the dominant card's color owns the pixel.
    vec3 col = vec3(0.0);
    float wSum = 0.0;
    float effDom = 0.0;
    for (int c = 0; c < NCARDS; c++) {
      vec3 colc = paletteAround(p, u_centroid[c], c, u_time);
      // Per-card desat + BG mix at rest, easing to 0 with hover.
      float lum = dot(colc, vec3(0.299, 0.587, 0.114));
      colc = mix(colc, vec3(lum), mix(0.25, 0.0, u_hover[c]));
      colc = mix(BG, colc, mix(0.85, 1.00, u_hover[c]));
      // Rival fade — dims this card's color as another dominates.
      float rival = 1.0 - u_rivalCoverBody[c];
      colc *= rival;

      float w = fArr[c] * fArr[c];
      col   += colc * w;
      wSum  += w;
      effDom += u_hover[c] * w;
    }
    col   /= (wSum + 1e-6);
    effDom /= (wSum + 1e-6);

    float peak = mix(0.72, 0.98, effDom);

    float densityScale = 0.0028 / u_dpr;
    float densityT = u_time * 0.00007;
    float density = 0.30 + 1.30 * fbm(p * densityScale + vec2(densityT, -densityT * 0.6) + 51.2);

    float coreWeight = mix(0.18, 1.20, effDom);
    float haloWeight = mix(1.40, 0.55, effDom);

    const float FALLOFF = 1.6;
    float fieldTotal = maxF * coreWeight + maxH * haloWeight;
    float aRaw = smoothstep(0.0, FALLOFF, fieldTotal);
    float alpha = pow(aRaw, 1.4) * peak * density;

    float dith = hash21(floor(p / max(u_dpr, 1.0)) + floor(u_time * 0.012));
    float tailMask = smoothstep(0.04, 0.32, alpha) * (1.0 - smoothstep(0.32, 0.55, alpha));
    alpha = mix(alpha, alpha * (0.55 + 0.9 * dith), tailMask * 0.55);

    col = mix(BG, col, smoothstep(0.0, 0.45, alpha));

    fragColor = vec4(col, alpha);
    return;
  }

  // Fallback path (no ?dots): plain metaball with shared threshold.
  float fSum = 0.0;
  float maxF = 0.0;
  vec3 colA = vec3(0.0);
  float wSum = 0.0;
  for (int c = 0; c < NCARDS; c++) {
    float fc = 0.0;
    for (int i = 0; i < N; i++) {
      vec3 pt = u_points[c * N + i];
      vec2 d = p - pt.xy;
      float r = u_radius[c] * pt.z;
      float d2 = max(dot(d, d), 1.0);
      fc += (r * r) / d2;
    }
    maxF = max(maxF, fc);
    vec3 col = paletteAround(p, u_centroid[c], c, u_time);
    float w = fc * fc;
    colA += col * w;
    wSum += w;
  }

  if (maxF < u_threshold * 0.04) discard;
  vec3 col = colA / (wSum + 1e-6);
  float alpha = smoothstep(u_threshold * 0.08, u_threshold * 0.85, maxF);
  fragColor = vec4(col, alpha);
}
