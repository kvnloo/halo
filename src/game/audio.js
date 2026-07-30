import * as THREE from 'three';
import { Rand } from '../core/Rand.js';

/**
 * `audio` — procedural audio graph and spatialisation.
 *
 * There are no sound files in this project. Every cue is synthesised at runtime from
 * filtered noise and enveloped oscillators, and every reverb impulse response is a
 * shaped noise burst generated in JS. Nothing is fetched, nothing is decoded.
 *
 * ## Graph
 *
 *      voice ─► airLP ─► preDelay ─► panner ─┬─► dryGain ──────────────┐
 *                                            └─► sendGain ─► revBus ─┐ │
 *                                                                    │ │
 *      revBus ─┬─► convolver(beach)  ─► wBeach  ─┐                    │ │
 *              ├─► convolver(bridge) ─► wBridge ─┼─► revReturn ───────┘ │
 *              └─► convolver(cliff)  ─► wCliff  ─┘                      │
 *                                                                       │
 *      ambience (surf / wind / wildlife) ─► ambBus ─────────────────────┤
 *                                                                       ▼
 *                                            mixBus ─► comp ─► softClip ─► master ─► out
 *
 * The three convolvers run continuously and are crossfaded from the listener's
 * position, so walking under the bridge or up against the cliff changes the space
 * rather than switching it. Their IRs differ in length, early-reflection pattern and
 * HF damping — the bridge deck sits 21.5 m up (a ~126 ms slap), the cliff face is
 * ~46 m behind the spawn (a ~268 ms discrete echo).
 *
 * ## Capture mode
 *
 * Completely inert. `create()` is told `capture` by the manifest and `init()` also
 * checks `engine.opts.deterministic`; in either case no AudioContext is constructed,
 * no listeners are attached and every hook returns immediately. Headless Chrome has
 * no audio device, and a capture must never block, throw or cost a millisecond on it.
 *
 * ## Determinism
 *
 * Nothing here touches a captured frame, but every random decision still comes from
 * `ctx.rand.fork()` so a session replays identically and `renderOffline()` is
 * reproducible for measurement.
 */

/* =========================================================================
 * Constants
 * ========================================================================= */

const SPEED_OF_SOUND = 343;

/**
 * Bed levels at the waterline. Set so the full ambience sits around -26 dBFS RMS,
 * leaving ~20 dB of headroom under a close rifle shot. Loud ambience is the classic
 * way to make a mix feel small: everything else has to fight it.
 */
const SURF_BASE = 0.082;
const WIND_BASE = 0.16;
const WATERLINE_Z = -6.5;          // docs/WORLD.md: mean waterline at Z = -6.5
const CLIFF_Z = 62;                // cliff face
const BRIDGE_A = [54, 60];         // deck anchor  (x, z)
const BRIDGE_B = [-34, -4];        // deck tip
const BRIDGE_DECK_Y = 21.5;

/** Reverb impulse responses, one per acoustic environment. */
const IR_SPECS = {
  // Open beach: almost no late field, just a short bright wash off the sand and the
  // back-beach berm. Short tau, little HF damping.
  beach: {
    dur: 0.85, tau: 0.155, rise: 0.006, k0: 0.78, k1: 0.24, gain: 0.80, diff: 1.0,
    early: [{ t: 0.021, g: 0.30, w: 0.004 }, { t: 0.047, g: 0.17, w: 0.005 }],
  },
  // Under the Forerunner span: a hard flat deck 21.5 m overhead and two strut pairs.
  // 2 x 21.5 / 343 = 125 ms slap, plus its first repeat.
  bridge: {
    dur: 1.45, tau: 0.33, rise: 0.008, k0: 0.66, k1: 0.13, gain: 1.20, diff: 0.70,
    early: [{ t: 0.013, g: 0.55, w: 0.003 }, { t: 0.126, g: 0.90, w: 0.006 },
            { t: 0.252, g: 0.42, w: 0.009 }, { t: 0.378, g: 0.20, w: 0.011 }],
  },
  // Against the cliff face at Z = +62: from the spawn that is ~46 m, so 2 x 46 / 343
  // = 268 ms of flight before the slapback returns. Outdoors there is almost nothing
  // in between, so the diffuse floor is held well down (`diff`) — otherwise the tail
  // buries its own echo and the space stops reading as a cliff at all.
  cliff: {
    dur: 2.10, tau: 0.50, rise: 0.010, k0: 0.58, k1: 0.09, gain: 1.05, diff: 0.30,
    early: [{ t: 0.268, g: 1.45, w: 0.010 }, { t: 0.404, g: 0.34, w: 0.012 },
            { t: 0.536, g: 0.62, w: 0.014 }, { t: 0.802, g: 0.26, w: 0.018 }],
  },
};

/* =========================================================================
 * Buffer generation — pure JS, no fetch, no decode
 * ========================================================================= */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function fillWhite(out, rnd) {
  for (let i = 0; i < out.length; i++) out[i] = rnd.next() * 2 - 1;
}

/** Paul Kellet's refined pink-noise filter — -3 dB/octave, the shape of surf and wind. */
function fillPink(out, rnd) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rnd.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
}

/** Remove DC, then normalise to a target peak. */
function condition(d, peak) {
  const n = d.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += d[i];
  mean /= n;
  let mx = 0;
  for (let i = 0; i < n; i++) { d[i] -= mean; const a = d[i] < 0 ? -d[i] : d[i]; if (a > mx) mx = a; }
  if (mx > 1e-9) { const s = peak / mx; for (let i = 0; i < n; i++) d[i] *= s; }
}

/**
 * Stereo noise buffer whose end splices seamlessly into its start.
 * Without the wrap-crossfade a looping bed clicks once per period — audible, and
 * visible in the measurement as a periodic transient.
 */
function makeLoopNoise(ac, seconds, kind, rnd, fade = 0.4) {
  const sr = ac.sampleRate;
  const n = Math.max(64, Math.floor(seconds * sr));
  const f = Math.min(n >> 1, Math.floor(fade * sr));
  const buf = ac.createBuffer(2, n, sr);
  const tmp = new Float32Array(n + f);
  for (let ch = 0; ch < 2; ch++) {
    (kind === 'pink' ? fillPink : fillWhite)(tmp, rnd);
    const d = buf.getChannelData(ch);
    d.set(tmp.subarray(0, n));
    for (let i = 0; i < f; i++) {
      const w = i / f;
      d[i] = d[i] * w + tmp[n + i] * (1 - w);
    }
    condition(d, 0.92);
  }
  return buf;
}

/**
 * Procedural impulse response: exponentially decaying noise with an onset rise,
 * explicit early reflections, a time-varying one-pole lowpass (HF dies first, as it
 * does in air and against sand) and a DC-blocking highpass.
 */
function makeIR(ac, spec, rnd) {
  const sr = ac.sampleRate;
  const n = Math.max(64, Math.floor(spec.dur * sr));
  const buf = ac.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rise = Math.max(1e-4, spec.rise);
    const diff = spec.diff ?? 1;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const a = Math.exp(-t / spec.tau) * (1 - Math.exp(-t / rise));
      d[i] = (rnd.next() * 2 - 1) * a * diff;
    }
    for (const r of spec.early) {
      // Skew the two channels apart so the early field is decorrelated (wide), not
      // a mono thump in the middle of the head.
      const t0 = r.t * (ch === 0 ? 1 : 1.041) + (ch === 1 ? 0.0007 : 0);
      const i0 = Math.floor(t0 * sr);
      const w = Math.max(4, Math.floor(r.w * sr));
      for (let i = 0; i < w && i0 + i < n; i++) {
        d[i0 + i] += (rnd.next() * 2 - 1) * r.g * Math.exp(-i / (w * 0.34));
      }
    }
    let y = 0;
    for (let i = 0; i < n; i++) {
      const k = spec.k0 + (spec.k1 - spec.k0) * (i / n);
      y += k * (d[i] - y);
      d[i] = y;
    }
    let hp = 0, prev = 0;
    for (let i = 0; i < n; i++) { hp = 0.9965 * (hp + d[i] - prev); prev = d[i]; d[i] = hp; }
    let e = 0;
    for (let i = 0; i < n; i++) e += d[i] * d[i];
    const g = e > 1e-12 ? spec.gain / Math.sqrt(e) : 0;
    for (let i = 0; i < n; i++) d[i] *= g;
  }
  return buf;
}

/** Soft-knee saturator curve. Transparent below 0.62, asymptotic to 0.95. */
function makeClipCurve(n = 2048) {
  const c = new Float32Array(n);
  const K = 0.62, C = 0.95 - K;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = a <= K ? x : Math.sign(x) * (K + C * Math.tanh((a - K) / C));
  }
  return c;
}

/* =========================================================================
 * Voice primitives
 * ========================================================================= */

/** Looping noise source, started at a random offset so no two shots share a grain. */
function noise(V, when, dur, rate = 1, pink = false) {
  const s = V.ac.createBufferSource();
  s.buffer = pink ? V.buf.pink : V.buf.white;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(when, V.rnd.next() * (s.buffer.duration - 0.05));
  s.stop(when + dur + 0.02);
  return s;
}

function bq(V, type, freq, q = 1, gain = 0) {
  const f = V.ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  if (gain) f.gain.value = gain;
  return f;
}

function osc(V, type, freq, when, dur) {
  const o = V.ac.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.start(when);
  o.stop(when + dur + 0.02);
  return o;
}

/**
 * attack → (hold) → exponential release with time constant `tau`.
 * T60 ≈ atk + hold + 6.9·tau; the caller's returned duration uses 8·tau so the node
 * is not cut while still audible.
 */
function envGain(V, when, peak, atk, tau, hold = 0) {
  const g = V.ac.createGain();
  const p = g.gain;
  p.setValueAtTime(0, when);
  p.linearRampToValueAtTime(peak, when + atk);
  if (hold > 0) p.setValueAtTime(peak, when + atk + hold);
  p.setTargetAtTime(0, when + atk + hold, Math.max(1e-4, tau));
  return g;
}

/**
 * One filtered, enveloped noise burst — the workhorse behind clicks and footfalls.
 *
 * `lp` is not optional decoration. A single highpass or wide bandpass on white noise
 * leaves flat energy all the way to Nyquist, and since there are four octaves above
 * 2 kHz and only three below it, that one layer captures the spectral centroid no
 * matter how quiet it is. Measured: a sand footstep whose loudest layer was a 1.4 kHz
 * lowpass still read a centroid of 2528 Hz, and a wet-sand step read 9240 Hz. Every
 * broadband layer here is banded top and bottom.
 */
function burst(V, when, o) {
  const dur = o.atk + (o.hold || 0) + 8 * o.tau;
  const n = noise(V, when, dur, o.rate || 1, !!o.pink);
  const f = bq(V, o.type || 'bandpass', o.f, o.q ?? 1);
  if (o.f2) {
    f.frequency.setValueAtTime(o.f, when);
    f.frequency.exponentialRampToValueAtTime(o.f2, when + (o.sweep ?? (o.atk + 4 * o.tau)));
  }
  const g = envGain(V, when, o.g, o.atk, o.tau, o.hold || 0);
  let tail = n.connect(f);
  if (o.hp) tail = tail.connect(bq(V, 'highpass', o.hp, 0.7));
  if (o.lp) tail = tail.connect(bq(V, 'lowpass', o.lp, 0.7));
  tail.connect(g).connect(o.to || V.out);
  return dur;
}

/** Enveloped sine/triangle body with an optional downward pitch sweep. */
function body(V, when, o) {
  const dur = o.atk + 8 * o.tau;
  const b = osc(V, o.type || 'sine', o.f, when, dur);
  if (o.f2) {
    b.frequency.setValueAtTime(o.f, when);
    b.frequency.exponentialRampToValueAtTime(o.f2, when + (o.sweep ?? 4 * o.tau));
  }
  const g = envGain(V, when, o.g, o.atk, o.tau);
  b.connect(g).connect(o.to || V.out);
  return dur;
}

/* =========================================================================
 * Voices
 *
 * Each returns its duration in seconds. `V` = { ac, out, send, buf, rnd, t }.
 * `out` is already routed through the distance / panning chain, so a voice only
 * ever describes the sound at its own source.
 * ========================================================================= */

const VOICES = {
  /**
   * MA5B. Four elements: the crack (noise through a collapsing resonant lowpass),
   * a low body thump, a set of metallic ring modes, and a long low tail that feeds
   * the reverb. Everything is jittered per shot — pitch, resonance, ring frequencies,
   * relative level and the noise grain — so a 15 rps burst never repeats a grain.
   */
  rifle(V, o) {
    const t = V.t, R = V.rnd;
    const k = 1 + R.sym(0.055);                       // per-shot pitch/formant scatter
    const lvl = (o.volume ?? 1) * (1 + R.sym(0.09));

    // 1. crack — the transient that carries the whole sound
    const n = noise(V, t, 0.30);
    const lp = bq(V, 'lowpass', 7600 * k, 5.5 + R.sym(1.6));
    lp.frequency.setValueAtTime(7600 * k, t);
    lp.frequency.exponentialRampToValueAtTime(1150 * k, t + 0.038);
    lp.frequency.exponentialRampToValueAtTime(430 * k, t + 0.15);
    const hp = bq(V, 'highpass', 190, 0.8);
    const gc = V.ac.createGain();
    gc.gain.setValueAtTime(0, t);
    gc.gain.linearRampToValueAtTime(0.70 * lvl, t + 0.0011);
    gc.gain.setTargetAtTime(0, t + 0.0011, 0.0165);
    n.connect(lp).connect(hp).connect(gc).connect(V.out);

    // 2. body — the thump you feel; without it the shot is a hiss
    body(V, t, { type: 'triangle', f: 176 * k, f2: 58 * k, sweep: 0.055,
                 g: 0.40 * lvl, atk: 0.0035, tau: 0.020, to: V.out });

    // 3. receiver ring — three short modes, the metal in "metallic"
    const modes = [[1810, 0.098, 0.016], [3160, 0.066, 0.011], [5350, 0.038, 0.0075]];
    for (const [f, g, tau] of modes) {
      burst(V, t + 0.0009, { f: f * k * (1 + R.sym(0.04)), q: 19, g: g * lvl,
                             atk: 0.0009, tau, to: V.out });
    }

    // 4. bolt clack, 4 ms behind the crack
    burst(V, t + 0.004, { f: 2650 * k, q: 2.4, g: 0.13 * lvl, atk: 0.0008, tau: 0.007,
                          hp: 900, lp: 8000, to: V.out });

    // 5. low tail — the part that decays into the environment
    burst(V, t + 0.006, { type: 'lowpass', f: 900 * k, q: 1.1, g: 0.13 * lvl,
                          atk: 0.004, tau: 0.032, hp: 90, to: V.out });

    // 6. shell casing, tumbling out to the right a beat later
    if (o.casing !== false) {
      const ct = t + 0.34 + R.range(0, 0.09);
      for (let i = 0; i < 2 + (R.next() < 0.5 ? 1 : 0); i++) {
        burst(V, ct + i * R.range(0.045, 0.085), {
          f: R.range(3800, 6900), q: 13, g: 0.030 * lvl * (1 - i * 0.3),
          atk: 0.0006, tau: 0.010, to: V.out });
      }
    }

    V.send.gain.value = (V.send.gain.value || 0) + 0.10;
    return 0.85;
  },

  /**
   * Plasma bolt. Ring-modulated pair with a downward pitch drop plus an HF sizzle —
   * brighter and thinner than the rifle, no low body at all.
   */
  plasma(V, o) {
    const t = V.t, R = V.rnd;
    const k = 1 + R.sym(0.07);
    const lvl = o.volume ?? 1;
    const dur = 0.34;

    const car = osc(V, 'sine', 1240 * k, t, dur);
    car.frequency.setValueAtTime(1240 * k, t);
    car.frequency.exponentialRampToValueAtTime(430 * k, t + 0.135);
    const mod = osc(V, 'sine', 815 * k, t, dur);
    mod.frequency.setValueAtTime(815 * k, t);
    mod.frequency.exponentialRampToValueAtTime(268 * k, t + 0.135);

    const modAmt = V.ac.createGain(); modAmt.gain.value = 0.80;
    const ring = V.ac.createGain(); ring.gain.value = 0.24;   // DC offset -> AM + ring
    mod.connect(modAmt).connect(ring.gain);
    car.connect(ring);

    const bp = bq(V, 'bandpass', 1700 * k, 1.15);
    bp.frequency.setValueAtTime(2800 * k, t);
    bp.frequency.exponentialRampToValueAtTime(1150 * k, t + 0.14);
    const ge = envGain(V, t, 0.88 * lvl, 0.0018, 0.033);
    ring.connect(bp).connect(ge).connect(V.out);

    // sizzle: the ionised-air hiss riding on top. This is what keeps plasma brighter
    // and thinner than the rifle — measured centroid must land above it, not below.
    burst(V, t, { f: 5200, q: 0.7, g: 0.44 * lvl, hp: 2200, lp: 11000,
                  atk: 0.0012, tau: 0.020, to: V.out });
    // zap: a fast descending edge that gives it its "pew"
    const z = osc(V, 'sawtooth', 3100 * k, t, 0.10);
    z.frequency.setValueAtTime(3100 * k, t);
    z.frequency.exponentialRampToValueAtTime(760 * k, t + 0.055);
    const zf = bq(V, 'lowpass', 4200, 1.0);
    const zg = envGain(V, t, 0.16 * lvl, 0.0015, 0.014);
    z.connect(zf).connect(zg).connect(V.out);

    V.send.gain.value = (V.send.gain.value || 0) + 0.14;
    return 0.42;
  },

  /** Plasma weapon overheat vent — steam and a falling whine. */
  plasma_vent(V, o) {
    const t = V.t;
    burst(V, t, { f: 3000, q: 0.8, g: 0.24 * (o.volume ?? 1), hp: 1800, lp: 7000,
                  atk: 0.02, tau: 0.10, to: V.out });
    body(V, t, { type: 'sine', f: 1500, f2: 380, sweep: 0.32, g: 0.10 * (o.volume ?? 1),
                 atk: 0.01, tau: 0.09, to: V.out });
    return 0.85;
  },

  /**
   * MA5B reload — 2.6 s of mechanism, per docs/WEAPON.md. Seven events at different
   * filter centres; the mag seat at 1.42 s is the loud one.
   */
  reload(V, o) {
    const t = V.t, R = V.rnd, lvl = o.volume ?? 1;
    const j = () => R.sym(0.012);

    // mag release catch
    burst(V, t + 0.00 + j(), { f: 2750, q: 2.2, g: 0.46 * lvl, atk: 0.0006, tau: 0.006, hp: 800, lp: 9000, to: V.out });
    // magazine breaks free of the well
    burst(V, t + 0.16 + j(), { type: 'lowpass', f: 620, q: 2.2, g: 0.34 * lvl, atk: 0.001, tau: 0.014, hp: 110, to: V.out });
    body(V, t + 0.16, { f: 138, f2: 84, sweep: 0.03, g: 0.20 * lvl, atk: 0.002, tau: 0.014, to: V.out });
    // it drops away, rattling
    for (let i = 0; i < 3; i++) {
      burst(V, t + 0.55 + i * R.range(0.05, 0.10), {
        f: R.range(760, 1500), q: 6, g: 0.10 * lvl, atk: 0.0006, tau: 0.008, to: V.out });
    }
    // fresh mag comes up — glove on polymer, soft and broadband
    burst(V, t + 1.05 + j(), { f: 2800, q: 0.9, g: 0.11 * lvl, hp: 1500, lp: 6000, atk: 0.008, tau: 0.024, to: V.out });
    // seated hard
    burst(V, t + 1.42 + j(), { type: 'lowpass', f: 780, q: 2.6, g: 0.52 * lvl, atk: 0.0008, tau: 0.017, hp: 120, to: V.out });
    body(V, t + 1.42, { f: 152, f2: 76, sweep: 0.035, g: 0.30 * lvl, atk: 0.0018, tau: 0.019, to: V.out });
    burst(V, t + 1.425, { f: 2100, q: 14, g: 0.09 * lvl, atk: 0.0006, tau: 0.013, to: V.out });
    // charging handle drawn back — a scrape, not a click
    burst(V, t + 1.85 + j(), { f: 1750, f2: 2450, sweep: 0.08, q: 3.2, g: 0.17 * lvl,
                               atk: 0.010, tau: 0.020, hp: 600, lp: 7000, to: V.out });
    // bolt released
    burst(V, t + 2.13 + j(), { f: 3500, q: 2.6, g: 0.54 * lvl, atk: 0.0005, tau: 0.0075, hp: 1200, lp: 9000, to: V.out });
    burst(V, t + 2.134, { f: 2360, q: 17, g: 0.13 * lvl, atk: 0.0005, tau: 0.019, to: V.out });
    body(V, t + 2.132, { f: 210, f2: 110, sweep: 0.025, g: 0.14 * lvl, atk: 0.0012, tau: 0.011, to: V.out });

    V.send.gain.value = (V.send.gain.value || 0) + 0.05;
    return 2.62;
  },

  /* ------------------------------------------------------------ impacts */

  impact_sand(V, o) {
    const t = V.t, lvl = o.volume ?? 1;
    // Sand is the most absorbent surface in the level; cascade two poles so there is
    // genuinely nothing above 2 kHz.
    burst(V, t, { type: 'lowpass', f: 900, q: 1.4, g: 0.52 * lvl, atk: 0.0012, tau: 0.014, hp: 120, lp: 1900, to: V.out });
    body(V, t, { f: 120, f2: 62, sweep: 0.03, g: 0.18 * lvl, atk: 0.002, tau: 0.014, to: V.out });
    burst(V, t + 0.012, { f: 2600, q: 0.8, g: 0.040 * lvl, hp: 1600, lp: 3800, atk: 0.006, tau: 0.030, to: V.out });
    return 0.30;
  },

  impact_rock(V, o) {
    const t = V.t, R = V.rnd, lvl = o.volume ?? 1;
    burst(V, t, { f: 2900 * (1 + R.sym(0.1)), q: 2.0, g: 0.62 * lvl, atk: 0.0006, tau: 0.0085, hp: 700, lp: 7000, to: V.out });
    burst(V, t + 0.001, { f: 5200, q: 12, g: 0.14 * lvl, atk: 0.0005, tau: 0.012, to: V.out });
    body(V, t, { f: 240, f2: 120, sweep: 0.02, g: 0.20 * lvl, atk: 0.0012, tau: 0.010, to: V.out });
    // grit spray
    burst(V, t + 0.010, { f: 5000, q: 0.9, g: 0.08 * lvl, hp: 3200, lp: 9000, atk: 0.004, tau: 0.038, to: V.out });
    // ricochet whine, some of the time
    if (R.next() < 0.30) {
      const w = osc(V, 'sine', 3300, t + 0.004, 0.5);
      w.frequency.setValueAtTime(3300 * (1 + R.sym(0.2)), t + 0.004);
      w.frequency.exponentialRampToValueAtTime(950, t + 0.34);
      const wf = bq(V, 'bandpass', 2200, 3);
      const wg = envGain(V, t + 0.004, 0.075 * lvl, 0.006, 0.075);
      w.connect(wf).connect(wg).connect(V.out);
      V.send.gain.value = (V.send.gain.value || 0) + 0.25;
    }
    return 0.62;
  },

  impact_metal(V, o) {
    const t = V.t, R = V.rnd, lvl = o.volume ?? 1;
    burst(V, t, { f: 3200, q: 1.7, g: 0.86 * lvl, atk: 0.0005, tau: 0.007, hp: 900, lp: 9000, to: V.out });
    body(V, t, { f: 210, f2: 118, sweep: 0.02, g: 0.20 * lvl, atk: 0.001, tau: 0.010, to: V.out });
    for (const [f, g, tau] of [[1420, 0.32, 0.075], [2870, 0.24, 0.055], [4610, 0.15, 0.035], [7300, 0.07, 0.02]]) {
      burst(V, t + 0.0006, { f: f * (1 + R.sym(0.05)), q: 26, g: g * lvl, atk: 0.0006, tau, to: V.out });
    }
    V.send.gain.value = (V.send.gain.value || 0) + 0.20;
    return 0.70;
  },

  impact_water(V, o) {
    const t = V.t, lvl = o.volume ?? 1;
    // the plop: a fast upward-swept resonance (the cavity closing)
    const b = osc(V, 'sine', 340, t, 0.14);
    b.frequency.setValueAtTime(340, t);
    b.frequency.exponentialRampToValueAtTime(980, t + 0.055);
    const bg = envGain(V, t, 0.34 * lvl, 0.002, 0.016);
    b.connect(bg).connect(V.out);
    // the splash
    burst(V, t, { type: 'bandpass', f: 1400, f2: 2600, sweep: 0.09, q: 0.8, g: 0.42 * lvl,
                  lp: 5000, atk: 0.003, tau: 0.045, to: V.out });
    return 0.45;
  },

  impact_flesh(V, o) {
    const t = V.t, lvl = o.volume ?? 1;
    burst(V, t, { type: 'lowpass', f: 620, q: 1.4, g: 0.50 * lvl, atk: 0.001, tau: 0.013, hp: 90, to: V.out });
    body(V, t, { f: 96, f2: 54, sweep: 0.03, g: 0.30 * lvl, atk: 0.002, tau: 0.018, to: V.out });
    burst(V, t + 0.008, { f: 1700, q: 2.0, g: 0.09 * lvl, atk: 0.002, tau: 0.020, to: V.out });
    return 0.32;
  },

  impact_shield(V, o) {
    const t = V.t, lvl = o.volume ?? 1;
    const s = osc(V, 'sine', 2400, t, 0.3);
    s.frequency.setValueAtTime(2400, t);
    s.frequency.exponentialRampToValueAtTime(5200, t + 0.09);
    const sg = envGain(V, t, 0.28 * lvl, 0.002, 0.030);
    s.connect(sg).connect(V.out);
    burst(V, t, { type: 'bandpass', f: 3200, f2: 6400, sweep: 0.08, q: 1.4, g: 0.30 * lvl,
                  lp: 11000, atk: 0.0015, tau: 0.028, to: V.out });
    return 0.35;
  },

  /* ---------------------------------------------------------- footsteps */

  /**
   * Dry sand: soft, dark, no transient edge at all. Grain rustle sits under 2 kHz —
   * this is the dullest cue in the game and it has to measure that way.
   */
  step_sand(V, o) {
    const t = V.t, R = V.rnd;
    const lvl = (o.volume ?? 1) * (o.running ? 1.35 : 1) * (1 + R.sym(0.12));
    const k = 1 + R.sym(0.10);
    burst(V, t, { type: 'lowpass', f: 1150 * k, q: 1.15, g: 0.50 * lvl,
                  atk: 0.0055, tau: 0.0155, hp: 130, lp: 2000 * k, to: V.out });
    burst(V, t + 0.006, { type: 'bandpass', f: 2300 * k, q: 0.9, g: 0.055 * lvl,
                          atk: 0.008, tau: 0.020, lp: 4200, to: V.out });
    body(V, t, { f: 118 * k, f2: 66, sweep: 0.035, g: 0.17 * lvl, atk: 0.006, tau: 0.016, to: V.out });
    return 0.24;
  },

  /** Wet sand: a resonant slap plus a splash that outlasts it. */
  step_wet(V, o) {
    const t = V.t, R = V.rnd;
    const lvl = (o.volume ?? 1) * (o.running ? 1.35 : 1) * (1 + R.sym(0.12));
    const k = 1 + R.sym(0.09);
    burst(V, t, { f: 640 * k, q: 5.5, g: 0.72 * lvl, atk: 0.0016, tau: 0.0125, hp: 150, to: V.out });
    burst(V, t + 0.002, { type: 'lowpass', f: 1900 * k, q: 1.0, g: 0.36 * lvl,
                          atk: 0.0022, tau: 0.011, hp: 200, lp: 3200, to: V.out });
    body(V, t, { f: 132 * k, f2: 70, sweep: 0.03, g: 0.22 * lvl, atk: 0.0025, tau: 0.014, to: V.out });
    // splash: brighter than the slap and decaying a good deal slower, but banded —
    // water spray is 2-6 kHz, not everything above 3 kHz
    burst(V, t + 0.008, { f: 3000, q: 0.85, g: 0.075 * lvl, hp: 2000, lp: 5000,
                          atk: 0.006, tau: 0.032, to: V.out });
    return 0.36;
  },

  /** Shin-deep water: mostly splash, very little impact. */
  step_water(V, o) {
    const t = V.t, R = V.rnd;
    const lvl = (o.volume ?? 1) * (o.running ? 1.4 : 1);
    burst(V, t, { type: 'bandpass', f: 900 * (1 + R.sym(0.1)), f2: 3000, sweep: 0.10,
                  q: 0.75, g: 0.50 * lvl, lp: 6000, atk: 0.004, tau: 0.042, to: V.out });
    body(V, t, { f: 190, f2: 420, sweep: 0.05, g: 0.13 * lvl, atk: 0.004, tau: 0.020, to: V.out });
    return 0.42;
  },

  /** Rock: a sharp, short, bright click and almost nothing else. */
  step_rock(V, o) {
    const t = V.t, R = V.rnd;
    const lvl = (o.volume ?? 1) * (o.running ? 1.3 : 1) * (1 + R.sym(0.1));
    const k = 1 + R.sym(0.12);
    burst(V, t, { f: 2950 * k, q: 1.9, g: 0.58 * lvl, atk: 0.0008, tau: 0.0055, hp: 900, lp: 7500, to: V.out });
    burst(V, t + 0.0008, { f: 5400 * k, q: 9, g: 0.13 * lvl, atk: 0.0006, tau: 0.006, to: V.out });
    body(V, t, { f: 168 * k, f2: 96, sweep: 0.018, g: 0.15 * lvl, atk: 0.0012, tau: 0.0085, to: V.out });
    burst(V, t + 0.006, { f: 6000, q: 0.9, g: 0.045 * lvl, hp: 4000, lp: 10000, atk: 0.004, tau: 0.016, to: V.out });
    return 0.16;
  },

  step_metal(V, o) {
    const t = V.t, R = V.rnd;
    const lvl = (o.volume ?? 1) * (o.running ? 1.3 : 1);
    burst(V, t, { f: 2200 * (1 + R.sym(0.1)), q: 2.2, g: 0.76 * lvl, atk: 0.0008, tau: 0.007, hp: 700, lp: 8000, to: V.out });
    body(V, t, { f: 176, f2: 104, sweep: 0.02, g: 0.16 * lvl, atk: 0.001, tau: 0.009, to: V.out });
    for (const [f, g, tau] of [[880, 0.22, 0.09], [1960, 0.16, 0.06], [3480, 0.09, 0.04]]) {
      burst(V, t + 0.0006, { f, q: 22, g: g * lvl, atk: 0.0006, tau, to: V.out });
    }
    V.send.gain.value = (V.send.gain.value || 0) + 0.10;
    return 0.55;
  },

  /* ----------------------------------------------------- player feedback */

  /** Shield down: three urgent pulses of a detuned two-tone alarm, then a fall. */
  shield_down(V, o) {
    const t = V.t, lvl = o.volume ?? 1;
    const outG = V.ac.createGain(); outG.gain.value = 1; outG.connect(V.out);
    const lp = bq(V, 'lowpass', 2300, 0.9); lp.connect(outG);

    for (let i = 0; i < 3; i++) {
      const ts = t + i * 0.205;
      const g = envGain(V, ts, (0.34 - i * 0.04) * lvl, 0.006, 0.030, 0.045);
      g.connect(lp);
      for (const [f, det] of [[452, 1], [676, 0.72], [904, 0.34]]) {
        const a = osc(V, 'square', f, ts, 0.30);
        a.frequency.setValueAtTime(f, ts);
        a.frequency.linearRampToValueAtTime(f * 0.93, ts + 0.16);
        const ag = V.ac.createGain(); ag.gain.value = det * 0.34;
        a.connect(ag).connect(g);
      }
      // sub thump under each pulse
      body(V, ts, { f: 92, f2: 62, sweep: 0.05, g: 0.22 * lvl, atk: 0.003, tau: 0.022, to: outG });
    }
    // final descending tail
    const tail = osc(V, 'sawtooth', 420, t + 0.62, 0.55);
    tail.frequency.setValueAtTime(420, t + 0.62);
    tail.frequency.exponentialRampToValueAtTime(148, t + 1.00);
    const tf = bq(V, 'lowpass', 1300, 1.4);
    const tg = envGain(V, t + 0.62, 0.20 * lvl, 0.020, 0.085);
    tail.connect(tf).connect(tg).connect(outG);

    V.send.gain.value = (V.send.gain.value || 0) + 0.06;
    return 1.35;
  },

  /** Recharge: a rising filtered shimmer with tremolo, closed by a small ping. */
  shield_recharge(V, o) {
    const t = V.t, lvl = o.volume ?? 1;
    const dur = 1.30;
    const outG = V.ac.createGain(); outG.gain.value = 1; outG.connect(V.out);

    // tremolo, shared by every layer
    const trem = V.ac.createGain(); trem.gain.value = 1;
    const lfo = osc(V, 'sine', 8.5, t, dur);
    const lfoA = V.ac.createGain(); lfoA.gain.value = 0.34;
    lfo.connect(lfoA).connect(trem.gain);
    trem.connect(outG);

    const n = noise(V, t, dur);
    const sw = bq(V, 'bandpass', 780, 3.4);
    sw.frequency.setValueAtTime(780, t);
    sw.frequency.exponentialRampToValueAtTime(5400, t + 0.98);
    const ng = V.ac.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.30 * lvl, t + 0.42);
    ng.gain.setValueAtTime(0.30 * lvl, t + 0.80);
    ng.gain.linearRampToValueAtTime(0, t + 1.10);
    n.connect(sw).connect(ng).connect(trem);

    for (const [f, g] of [[2090, 0.075], [2655, 0.055], [3140, 0.040]]) {
      const s = osc(V, 'sine', f, t, dur);
      s.frequency.setValueAtTime(f * 0.985, t);
      s.frequency.linearRampToValueAtTime(f * 1.012, t + 1.0);
      const sg = V.ac.createGain();
      sg.gain.setValueAtTime(0, t);
      sg.gain.linearRampToValueAtTime(g * lvl, t + 0.5);
      sg.gain.linearRampToValueAtTime(0, t + 1.12);
      s.connect(sg).connect(trem);
    }
    // the "full" ping
    const p = osc(V, 'sine', 3480, t + 1.02, 0.4);
    const pg = envGain(V, t + 1.02, 0.16 * lvl, 0.004, 0.055);
    p.connect(pg).connect(outG);
    body(V, t + 1.02, { f: 1740, g: 0.07 * lvl, atk: 0.004, tau: 0.05, to: outG });

    V.send.gain.value = (V.send.gain.value || 0) + 0.10;
    return 1.55;
  },

  /** Hit confirmed on flesh — a dry, close, unmistakable tick. */
  hit(V, o) {
    const t = V.t;
    burst(V, t, { f: 2500, q: 3.0, g: 0.50 * (o.volume ?? 1), atk: 0.0006, tau: 0.0055, hp: 1100, lp: 8000, to: V.out });
    body(V, t, { f: 900, f2: 620, sweep: 0.012, g: 0.16 * (o.volume ?? 1), atk: 0.001, tau: 0.008, to: V.out });
    return 0.10;
  },

  /** Hit on a shielded target — brighter, with a small upward chirp. */
  hit_shield(V, o) {
    const t = V.t, lvl = o.volume ?? 1;
    const s = osc(V, 'sine', 2900, t, 0.12);
    s.frequency.setValueAtTime(2900, t);
    s.frequency.exponentialRampToValueAtTime(4900, t + 0.045);
    const sg = envGain(V, t, 0.26 * lvl, 0.0012, 0.0125);
    s.connect(sg).connect(V.out);
    burst(V, t, { f: 4200, q: 5, g: 0.20 * lvl, atk: 0.0006, tau: 0.008, to: V.out });
    return 0.14;
  },

  /** Kill — two descending ticks. */
  hit_kill(V, o) {
    const t = V.t, lvl = o.volume ?? 1;
    burst(V, t, { f: 2900, q: 4, g: 0.34 * lvl, atk: 0.0006, tau: 0.0055, hp: 1200, to: V.out });
    burst(V, t + 0.072, { f: 1750, q: 4, g: 0.30 * lvl, atk: 0.0006, tau: 0.0075, hp: 800, to: V.out });
    body(V, t + 0.072, { f: 620, f2: 400, sweep: 0.05, g: 0.13 * lvl, atk: 0.0015, tau: 0.022, to: V.out });
    return 0.28;
  },

  /** Taking damage: a chest thump plus a short crunch. */
  damage(V, o) {
    const t = V.t, lvl = clamp(o.volume ?? 1, 0.25, 1.6);
    body(V, t, { f: 88, f2: 46, sweep: 0.06, g: 0.52 * lvl, atk: 0.0025, tau: 0.032, to: V.out });
    burst(V, t, { type: 'lowpass', f: 420, q: 1.5, g: 0.34 * lvl, atk: 0.0018, tau: 0.020, hp: 60, to: V.out });
    burst(V, t + 0.004, { f: 1350, q: 1.8, g: 0.13 * lvl, atk: 0.0018, tau: 0.017, to: V.out });
    V.send.gain.value = (V.send.gain.value || 0) + 0.06;
    return 0.42;
  },

  /* --------------------------------------------------------- wildlife */

  /** Gull. Two to four chirps, each an up-then-down glide, pitch falling across the call. */
  gull(V, o) {
    const t = V.t, R = V.rnd;
    const lvl = o.volume ?? 1;
    const base = R.range(0.86, 1.22);
    const n = 2 + Math.floor(R.next() * 3);
    let ct = t;
    for (let i = 0; i < n; i++) {
      const k = base * (1 - i * 0.055);
      const d = R.range(0.10, 0.17);
      const f0 = 880 * k, f1 = 2250 * k, f2 = 1320 * k;
      const s = osc(V, 'sawtooth', f0, ct, d + 0.05);
      s.frequency.setValueAtTime(f0, ct);
      s.frequency.exponentialRampToValueAtTime(f1, ct + d * 0.38);
      s.frequency.exponentialRampToValueAtTime(f2, ct + d);
      const bp = bq(V, 'bandpass', 1900 * k, 2.6);
      bp.frequency.setValueAtTime(1500 * k, ct);
      bp.frequency.exponentialRampToValueAtTime(2600 * k, ct + d * 0.38);
      bp.frequency.exponentialRampToValueAtTime(1700 * k, ct + d);
      const g = envGain(V, ct, 0.30 * lvl * (1 - i * 0.10), 0.014, 0.026, d * 0.55);
      s.connect(bp).connect(g).connect(V.out);
      // breath rasp
      burst(V, ct, { f: 2600 * k, q: 1.6, g: 0.035 * lvl, atk: 0.012, tau: 0.020, to: V.out });
      ct += d + R.range(0.10, 0.20);
    }
    V.send.gain.value = (V.send.gain.value || 0) + 0.42;
    return ct - t + 0.4;
  },

  /** A small shore bird up near the dune grass — a fast trill. */
  bird(V, o) {
    const t = V.t, R = V.rnd, lvl = o.volume ?? 1;
    const n = 4 + Math.floor(R.next() * 5);
    const k = R.range(0.9, 1.15);
    let ct = t;
    for (let i = 0; i < n; i++) {
      const d = 0.032;
      const f0 = 3100 * k * (1 + R.sym(0.08));
      const s = osc(V, 'triangle', f0, ct, d + 0.03);
      s.frequency.setValueAtTime(f0, ct);
      s.frequency.exponentialRampToValueAtTime(f0 * 1.35, ct + d);
      const g = envGain(V, ct, 0.14 * lvl, 0.004, 0.011);
      const bp = bq(V, 'bandpass', f0 * 1.1, 3.0);
      s.connect(bp).connect(g).connect(V.out);
      ct += d + R.range(0.02, 0.045);
    }
    V.send.gain.value = (V.send.gain.value || 0) + 0.34;
    return ct - t + 0.3;
  },

  /** Sea spray / a wave breaking close by — used by particles if it wants it. */
  splash(V, o) {
    const t = V.t, lvl = o.volume ?? 1;
    burst(V, t, { type: 'bandpass', f: 700, f2: 2400, sweep: 0.22, q: 0.6, g: 0.62 * lvl,
                  lp: 5000, atk: 0.020, tau: 0.075, pink: true, to: V.out });
    burst(V, t + 0.03, { f: 3600, q: 0.9, g: 0.08 * lvl, hp: 2400, lp: 6500, atk: 0.05, tau: 0.11, to: V.out });
    V.send.gain.value = (V.send.gain.value || 0) + 0.18;
    return 1.0;
  },

  /** UI blip, for pickups. */
  pickup(V, o) {
    const t = V.t, lvl = o.volume ?? 1;
    for (let i = 0; i < 2; i++) {
      const f = i === 0 ? 1180 : 1770;
      const s = osc(V, 'sine', f, t + i * 0.07, 0.2);
      const g = envGain(V, t + i * 0.07, 0.20 * lvl, 0.003, 0.035);
      s.connect(g).connect(V.out);
    }
    return 0.35;
  },
};

const VOICE_IDS = Object.keys(VOICES);

/* =========================================================================
 * Graph — everything downstream of a voice, for any BaseAudioContext.
 *
 * Built identically for the live AudioContext and for the OfflineAudioContext used
 * by renderOffline(), so a measurement is taken through the real signal path
 * including the reverb, the bus compressor and the output saturator.
 * ========================================================================= */

function createGraph(ac, rand, opts = {}) {
  const rnd = rand;

  const master = ac.createGain();
  master.gain.value = opts.master ?? 0.85;

  const shaper = ac.createWaveShaper();
  shaper.curve = makeClipCurve();
  shaper.oversample = '2x';

  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 8;
  comp.ratio.value = 6;
  comp.attack.value = 0.004;
  comp.release.value = 0.20;

  const mix = ac.createGain();
  mix.connect(comp).connect(shaper).connect(master).connect(ac.destination);

  const dry = ac.createGain(); dry.gain.value = 1; dry.connect(mix);
  const amb = ac.createGain(); amb.gain.value = 1; amb.connect(mix);
  const revBus = ac.createGain(); revBus.gain.value = 1;
  const revReturn = ac.createGain(); revReturn.gain.value = (opts.wet ?? 1) * 1.0;
  revReturn.connect(mix);

  const buf = {
    white: makeLoopNoise(ac, 2.0, 'white', rnd.fork(0x11)),
    pink: makeLoopNoise(ac, 5.0, 'pink', rnd.fork(0x22)),
  };

  // three spaces, crossfaded from the listener's position
  const envs = {};
  for (const key of Object.keys(IR_SPECS)) {
    const c = ac.createConvolver();
    c.normalize = false;
    c.buffer = makeIR(ac, IR_SPECS[key], rnd.fork(hashStr(key)));
    const w = ac.createGain();
    w.gain.value = key === 'beach' ? 1 : 0;
    revBus.connect(c).connect(w).connect(revReturn);
    envs[key] = { conv: c, gain: w };
  }

  /* ---- per-voice chain: air absorption, propagation delay, panning, sends ---- */

  function setPos(node, x, y, z) {
    if (node.positionX) { node.positionX.value = x; node.positionY.value = y; node.positionZ.value = z; }
    else if (node.setPosition) node.setPosition(x, y, z);
  }

  function makeChain(o, listener) {
    const nodes = [];
    const input = ac.createGain(); input.gain.value = 1; nodes.push(input);

    let dist = o.distance ?? 0;
    if (o.position && listener) {
      const dx = o.position[0] - listener[0], dy = o.position[1] - listener[1], dz = o.position[2] - listener[2];
      dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    dist = clamp(dist, 0, 3000);

    let tail = input;

    // air + ground absorption: -6 dB/45 m at HF, floored so it never vanishes
    if (dist > 4) {
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(19000 * Math.pow(0.5, dist / 46), 380, 20000);
      lp.Q.value = 0.5;
      tail = tail.connect(lp); nodes.push(lp);
    }
    // Propagation delay is applied by scheduling the voice later (see spawn), not by
    // a DelayNode. Measured: a DelayNode whose delayTime exceeds ~0.63 s stops
    // producing output once its upstream source finishes — Chrome stops pulling it —
    // so every cue past ~217 m was silently dropped. Scheduling is exact, free, and
    // has no such edge.
    let post;
    if (o.position && o.spatial !== false) {
      const p = ac.createPanner();
      p.panningModel = o.hrtf === false ? 'equalpower' : 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = o.refDistance ?? 6;
      p.rolloffFactor = o.rolloff ?? 0.9;
      p.maxDistance = 4000;
      setPos(p, o.position[0], o.position[1], o.position[2]);
      post = tail.connect(p); nodes.push(p);
    } else if (o.pan) {
      const p = ac.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      post = tail.connect(p); nodes.push(p);
    } else {
      post = tail;
    }

    // manual distance gain when the caller gave a distance but no position
    const dg = ac.createGain();
    dg.gain.value = (o.position && o.spatial !== false)
      ? 1
      : (dist > 0 ? 6 / (6 + 0.9 * Math.max(0, dist - 6)) : 1);
    post.connect(dg); nodes.push(dg);

    const dryG = ac.createGain(); dryG.gain.value = o.dry ?? 1;
    dg.connect(dryG).connect(dry); nodes.push(dryG);

    // Far sources are mostly reverb: the direct path loses HF and the reflected
    // field does not, which is what makes distance read as distance.
    const send = ac.createGain();
    send.gain.value = clamp((o.send ?? 0.10) + 0.62 * clamp01(dist / 150), 0, 1.4);
    dg.connect(send).connect(revBus); nodes.push(send);

    return { input, send, nodes, dist };
  }

  const active = new Set();

  function spawn(id, when, o = {}, rndOverride = null) {
    const fn = VOICES[id];
    if (!fn) return null;
    const chain = makeChain(o, opts.listener ? opts.listener() : null);
    // Sound travels at 343 m/s: a shot 200 m away is heard 0.58 s after it is fired.
    const t0 = when + (chain.dist > 12 ? Math.min(3.0, chain.dist / SPEED_OF_SOUND) : 0);
    const V = { ac, out: chain.input, send: chain.send, buf, rnd: rndOverride || rnd, t: t0 };
    let dur = 1;
    try { dur = fn(V, o) || 1; } catch (e) { /* never let one bad cue kill the frame */ }
    const handle = {
      id,
      endsAt: t0 + dur + 2.2,
      _stopped: false,
      stop(fade = 0.03) {
        if (this._stopped) return;
        this._stopped = true;
        const now = ac.currentTime;
        try {
          chain.input.gain.cancelScheduledValues(now);
          chain.input.gain.setValueAtTime(chain.input.gain.value, now);
          chain.input.gain.linearRampToValueAtTime(0, now + fade);
        } catch (e) { /* offline contexts have no meaningful currentTime here */ }
        this.endsAt = Math.min(this.endsAt, now + fade + 0.05);
      },
      _free() { for (const n of chain.nodes) { try { n.disconnect(); } catch (e) {} } active.delete(handle); },
    };
    active.add(handle);
    return handle;
  }

  /** Disconnect anything whose tail has finished. Called from update(); O(active). */
  function reap(now) {
    for (const h of active) if (now > h.endsAt) h._free();
  }

  /* ------------------------------- ambience ------------------------------- */

  const ambNodes = [];
  let ambience = null;

  function startAmbience(when = 0) {
    if (ambience) return ambience;
    const out = ac.createGain(); out.gain.value = 1; out.connect(amb);

    /* --- surf: pink noise band-split into rumble and hiss, two wide halves --- */
    const surf = { out: ac.createGain(), halves: [] };
    surf.out.gain.value = 0;
    surf.out.connect(out);
    for (let i = 0; i < 2; i++) {
      const s = ac.createBufferSource();
      s.buffer = buf.pink; s.loop = true;
      s.playbackRate.value = 0.88 + i * 0.19;
      const pan = ac.createStereoPanner(); pan.pan.value = i ? 0.78 : -0.78;

      // low rumble — the break. Two poles, and a 26 Hz highpass so the bed carries
      // no DC into the master (a lowpass on pink noise otherwise leaves a slow drift).
      const dcb = ac.createBiquadFilter(); dcb.type = 'highpass'; dcb.frequency.value = 26; dcb.Q.value = 0.7;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 210; lp.Q.value = 0.8;
      const lp2 = ac.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 300; lp2.Q.value = 0.6;
      const lg = ac.createGain(); lg.gain.value = 0.0;
      s.connect(dcb).connect(lp).connect(lp2).connect(lg).connect(pan);

      // hiss — the swash over sand. Banded 700 Hz .. 6 kHz: an open highpass here put
      // the whole bed's centroid at 3.4 kHz, which reads as static, not as water.
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 700; hp.Q.value = 0.7;
      const pk = ac.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 2000; pk.Q.value = 0.8; pk.gain.value = 3.0;
      const hcap = ac.createBiquadFilter(); hcap.type = 'lowpass'; hcap.frequency.value = 6000; hcap.Q.value = 0.7;
      const hg = ac.createGain(); hg.gain.value = 0.0;
      s.connect(hp).connect(pk).connect(hcap).connect(hg).connect(pan);

      // mid body so the two bands are not a hole in the middle
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 0.5;
      const mg = ac.createGain(); mg.gain.value = 0.0;
      s.connect(bp).connect(mg).connect(pan);

      pan.connect(surf.out);
      s.start(when, i * 1.9);
      surf.halves.push({ s, lg, hg, mg, lp, hp });
      ambNodes.push(s, pan, dcb, lp, lp2, lg, hp, pk, hcap, hg, bp, mg);
    }

    /* --- wind: resonant band of noise plus a high whistle --- */
    const wind = { out: ac.createGain() };
    wind.out.gain.value = 0;
    wind.out.connect(out);
    {
      const s = ac.createBufferSource(); s.buffer = buf.white; s.loop = true;
      s.playbackRate.value = 0.72;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 380; bp.Q.value = 1.15;
      const lo = ac.createBiquadFilter(); lo.type = 'lowpass'; lo.frequency.value = 1400; lo.Q.value = 0.6;
      const g = ac.createGain(); g.gain.value = 0.9;
      const pan = ac.createStereoPanner(); pan.pan.value = -0.28;
      s.connect(bp).connect(lo).connect(g).connect(pan).connect(wind.out);
      s.start(when, 0.31);

      // low buffet against the body / mic
      const s2 = ac.createBufferSource(); s2.buffer = buf.pink; s2.loop = true;
      s2.playbackRate.value = 0.5;
      const dcb2 = ac.createBiquadFilter(); dcb2.type = 'highpass'; dcb2.frequency.value = 24; dcb2.Q.value = 0.7;
      const lp2 = ac.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 120; lp2.Q.value = 0.9;
      const g2 = ac.createGain(); g2.gain.value = 0.55;
      s2.connect(dcb2).connect(lp2).connect(g2).connect(wind.out);
      s2.start(when, 1.7);

      // whistle over rock and rail edges — only present in real gusts
      const s3 = ac.createBufferSource(); s3.buffer = buf.white; s3.loop = true;
      s3.playbackRate.value = 1.0;
      const w1 = ac.createBiquadFilter(); w1.type = 'bandpass'; w1.frequency.value = 1900; w1.Q.value = 11;
      const w2 = ac.createBiquadFilter(); w2.type = 'bandpass'; w2.frequency.value = 2850; w2.Q.value = 15;
      const g3 = ac.createGain(); g3.gain.value = 0.0;
      const pan3 = ac.createStereoPanner(); pan3.pan.value = 0.42;
      s3.connect(w1).connect(g3);
      s3.connect(w2).connect(g3);
      g3.connect(pan3).connect(wind.out);
      s3.start(when, 0.77);

      wind.bp = bp; wind.g = g; wind.lo = lo; wind.g2 = g2;
      wind.w1 = w1; wind.w2 = w2; wind.g3 = g3;
      ambNodes.push(s, bp, lo, g, pan, s2, dcb2, lp2, g2, s3, w1, w2, g3, pan3);
    }

    const wildlife = { out: ac.createGain() };
    wildlife.out.gain.value = 0;
    wildlife.out.connect(out);

    ambNodes.push(out, surf.out, wind.out, wildlife.out);
    ambience = { out, surf, wind, wildlife };
    return ambience;
  }

  function dispose() {
    for (const h of Array.from(active)) h._free();
    for (const n of ambNodes) { try { n.stop && n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} }
    for (const k of Object.keys(envs)) { try { envs[k].conv.disconnect(); } catch (e) {} }
    try { mix.disconnect(); comp.disconnect(); shaper.disconnect(); master.disconnect(); } catch (e) {}
  }

  return {
    ac, buf, envs, master, mix, dry, amb, revBus, revReturn, comp, shaper,
    spawn, reap, startAmbience, dispose, active,
    get ambience() { return ambience; },
  };
}

/* =========================================================================
 * Module
 * ========================================================================= */

export function create(opts = {}) {
  /** Capture mode is decided here and never revisited: nothing below allocates. */
  let inert = !!opts.capture;

  let ctx = null;
  let ac = null;
  let G = null;
  let rand = null;
  let shotRnd = null;
  let ambRnd = null;

  let resumed = false;
  let revealedOverlay = false;
  let gestureCleanup = null;
  let ready = false;

  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  const listenerPos = [0, 1.72, 0];

  // ambience simulation state
  let ambT = 0;
  let accum = 0;
  let nextGull = 5.5;
  let nextBird = 14.0;
  let surfPrevH = 0;
  let surfBreak = 0;
  let oceanOk = true;
  let shieldWasUp = true;
  let updMs = 0;
  /** Live drivers, for the debug UI and for verifying the ocean sync is really on. */
  const dbg = { boom: 0, hiss: 0, gust: 0, oceanSynced: false, env: null };

  const busOff = [];

  /* ---------------------------------------------------------------- audio */

  function resume() {
    if (!ac || resumed) return;
    const p = ac.resume?.();
    if (p && p.then) p.then(onResumed, () => {});
    else onResumed();
  }

  function onResumed() {
    if (resumed) return;
    if (ac.state !== 'running') return;
    resumed = true;
    if (revealedOverlay) {
      const el = globalThis.document?.getElementById('click');
      if (el) el.classList.add('hidden');
      revealedOverlay = false;
    }
    if (G) {
      G.startAmbience(ac.currentTime + 0.02);
      const now = ac.currentTime;
      G.ambience.out.gain.setValueAtTime(0, now);
      G.ambience.out.gain.linearRampToValueAtTime(1, now + 2.0);
    }
    gestureCleanup?.();
    gestureCleanup = null;
  }

  function attachGesture() {
    const doc = globalThis.document;
    if (!doc) return;
    const onGesture = () => resume();
    const evts = ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'click'];
    for (const e of evts) globalThis.addEventListener(e, onGesture, { passive: true });
    doc.addEventListener('visibilitychange', onGesture, { passive: true });
    gestureCleanup = () => {
      for (const e of evts) globalThis.removeEventListener(e, onGesture);
      doc.removeEventListener('visibilitychange', onGesture);
    };
    // Only take the overlay if nobody else is already using it.
    const el = doc.getElementById('click');
    if (el && el.classList.contains('hidden')) {
      el.classList.remove('hidden');
      revealedOverlay = true;
    }
  }

  /* ------------------------------------------------------- world queries */

  function distToBridge(x, z) {
    const ax = BRIDGE_A[0], az = BRIDGE_A[1], bx = BRIDGE_B[0], bz = BRIDGE_B[1];
    const vx = bx - ax, vz = bz - az;
    const L2 = vx * vx + vz * vz;
    const t = clamp01(((x - ax) * vx + (z - az) * vz) / L2);
    const px = ax + vx * t, pz = az + vz * t;
    return Math.hypot(x - px, z - pz);
  }

  /** Crossfade weights for the three impulse responses. */
  function envWeights(p) {
    const underBridge = smoothstep(16, 6, distToBridge(p[0], p[2]))
      * smoothstep(BRIDGE_DECK_Y + 1.5, BRIDGE_DECK_Y - 4, p[1]);
    const nearCliff = smoothstep(52, 16, Math.abs(CLIFF_Z - p[2]));
    const b = clamp01(underBridge);
    const c = clamp01(nearCliff) * (1 - b);
    return { bridge: b, cliff: c, beach: clamp01(1 - b - c) };
  }

  function param(p, v, dt) {
    // exponential approach on the audio thread; cheap and click-free
    try { p.setTargetAtTime(v, ac.currentTime, Math.max(0.02, dt)); } catch (e) { p.value = v; }
  }

  /** 0..1 amplitude envelope of the surf, free-running or synced to `ocean`. */
  function surfEnvelope(t, ctx2, px, pz) {
    let boom = 0;
    const ocean = ctx2.get('ocean');
    if (oceanOk && ocean && typeof ocean.heightAt === 'function') {
      try {
        // sample the swash zone 8 m seaward of the player and differentiate
        const h = ocean.heightAt(px, Math.min(pz, WATERLINE_Z) - 8, t);
        if (Number.isFinite(h)) {
          const dh = (h - surfPrevH) * 20;
          surfPrevH = h;
          surfBreak = Math.max(surfBreak * 0.90, clamp01(-dh * 1.5));
          boom = surfBreak;
        } else oceanOk = false;
      } catch (e) { oceanOk = false; }
    }
    if (!boom) {
      // free-running: three incommensurate sets so the pattern never repeats audibly
      const g = (ph, c, w) => Math.exp(-((ph - c) * (ph - c)) / (2 * w * w));
      const p1 = (t / 7.3) % 1, p2 = (t / 11.7) % 1, p3 = (t / 17.9) % 1;
      boom = clamp01(0.62 * g(p1, 0.12, 0.075) + 0.48 * g(p2, 0.55, 0.10) + 0.34 * g(p3, 0.30, 0.13));
    }
    // the hiss of the swash lags the break and outlasts it
    const hp1 = (Math.max(0, t - 0.85) / 7.3) % 1, hp2 = (Math.max(0, t - 1.1) / 11.7) % 1;
    const gh = (ph, c, w) => Math.exp(-((ph - c) * (ph - c)) / (2 * w * w));
    const hiss = clamp01(0.55 * gh(hp1, 0.16, 0.14) + 0.45 * gh(hp2, 0.60, 0.17));
    return { boom, hiss };
  }

  /* --------------------------------------------------------------- events */

  function surfaceVoice(material, wetness) {
    if (typeof material === 'string') {
      const m = material.toLowerCase();
      if (m.startsWith('rock') || m === 'stone' || m === 'cliff') return 'step_rock';
      if (m === 'metal' || m.startsWith('forerunner')) return 'step_metal';
      if (m === 'water') return 'step_water';
      if (m === 'wet' || m === 'wetsand' || m === 'wet_sand') return 'step_wet';
      return 'step_sand';
    }
    // numeric MAT_ID from src/gfx/GBufferMaterial.js
    switch (material) {
      case 3: return 'step_rock';
      case 4: case 9: return 'step_metal';
      case 6: return 'step_water';
      case 2: return 'step_wet';
      case 1: default:
        return (wetness ?? 0) > 0.55 ? 'step_wet' : 'step_sand';
    }
  }

  function impactVoice(material, surface) {
    const s = typeof surface === 'string' ? surface.toLowerCase() : null;
    if (s) {
      if (s.includes('rock') || s.includes('stone')) return 'impact_rock';
      if (s.includes('metal') || s.includes('forerunner')) return 'impact_metal';
      if (s.includes('water')) return 'impact_water';
      if (s.includes('flesh') || s.includes('skin') || s.includes('body')) return 'impact_flesh';
      if (s.includes('shield')) return 'impact_shield';
      if (s.includes('sand') || s.includes('terrain')) return 'impact_sand';
    }
    switch (material) {
      case 3: return 'impact_rock';
      case 4: case 9: return 'impact_metal';
      case 6: return 'impact_water';
      case 7: return 'impact_flesh';
      case 5: return 'impact_sand';
      default: return 'impact_sand';
    }
  }

  const mod = {
    name: 'audio',
    order: 90,
    enabled: true,

    /* ------------------------------------------------------------- init */
    async init(c) {
      ctx = c;
      // Second gate: the harness sets deterministic even without ?capture=1.
      if (inert || c.engine?.opts?.deterministic || c.config?.frozen) { inert = true; return; }

      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) { inert = true; return; }

      rand = c.rand.fork(0xA0D10);
      shotRnd = rand.fork(0x51);
      ambRnd = rand.fork(0x52);

      try {
        ac = new AC({ latencyHint: 'interactive' });
        G = createGraph(ac, rand.fork(0x01), {
          master: 0.85,
          listener: () => listenerPos,
        });
      } catch (e) {
        // No device (headless), or the context was refused. Stay silent, stay alive.
        console.warn('[audio] no audio device — running silent:', e && e.message);
        inert = true;
        ac = null; G = null;
        return;
      }

      ready = true;
      c.config.audioVolume = c.config.audioVolume ?? 0.85;

      if (ac.state === 'running') onResumed();
      else attachGesture();

      /* ----------------------------------------------------- bus wiring */
      const on = (evt, fn) => busOff.push(c.on(evt, fn));

      on('weapon:fired', (e) => {
        if (!e) return;
        const id = /plasma|needler|fuel/i.test(e.weapon?.id || e.weapon?.name || e.weapon || '') ? 'plasma' : 'rifle';
        mod.play(id, {
          position: e.origin ? [e.origin.x, e.origin.y, e.origin.z] : null,
          distance: e.origin ? undefined : 0,
          volume: e.volume ?? 1,
        });
      });

      on('weapon:impact', (e) => {
        if (!e || !e.point) return;
        mod.play(impactVoice(e.material, e.surface), {
          position: [e.point.x, e.point.y, e.point.z],
          volume: e.volume ?? 1,
        });
      });

      on('actor:damaged', (e) => {
        if (!e) return;
        mod.play(e.shielded ? 'hit_shield' : 'hit', { volume: 0.85 });
        if (e.point) mod.play(e.shielded ? 'impact_shield' : 'impact_flesh',
          { position: [e.point.x, e.point.y, e.point.z], volume: 0.8 });
      });

      on('actor:killed', (e) => { mod.play('hit_kill', { volume: 0.95 }); });

      on('player:damaged', (e) => {
        const amt = clamp((e?.amount ?? 0.2) * 3.2, 0.35, 1.5);
        mod.play('damage', { volume: amt });
        // duck the beds briefly so the hit reads
        if (G?.ambience) {
          const p = G.ambience.out.gain, now = ac.currentTime;
          p.cancelScheduledValues(now);
          p.setValueAtTime(p.value, now);
          p.linearRampToValueAtTime(0.55, now + 0.03);
          p.linearRampToValueAtTime(1.0, now + 0.55);
        }
      });

      on('player:footstep', (e) => {
        if (!e) return;
        mod.play(surfaceVoice(e.material, e.wetness), {
          volume: e.running ? 0.9 : 0.7,
          running: !!e.running,
          pan: e.pan ?? (shotRnd.sym(0.14)),
          send: 0.09,
        });
      });

      on('weapon:reload', () => mod.play('reload', { volume: 0.9, send: 0.05 }));
      on('camera:teleport', () => { surfBreak = 0; });
    },

    /* ----------------------------------------------------------- update */
    update(dt, c) {
      if (inert || !ready) return;
      const t0 = performance.now();

      // Listener follows the camera every frame — cheap direct AudioParam writes.
      const cam = c.camera;
      cam.getWorldPosition(tmpV);
      cam.getWorldQuaternion(tmpQ);
      listenerPos[0] = tmpV.x; listenerPos[1] = tmpV.y; listenerPos[2] = tmpV.z;
      const L = ac.listener;
      if (L.positionX) {
        L.positionX.value = tmpV.x; L.positionY.value = tmpV.y; L.positionZ.value = tmpV.z;
        fwd.set(0, 0, -1).applyQuaternion(tmpQ);
        up.set(0, 1, 0).applyQuaternion(tmpQ);
        L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
        L.upX.value = up.x; L.upY.value = up.y; L.upZ.value = up.z;
      } else if (L.setPosition) {
        fwd.set(0, 0, -1).applyQuaternion(tmpQ);
        up.set(0, 1, 0).applyQuaternion(tmpQ);
        L.setPosition(tmpV.x, tmpV.y, tmpV.z);
        L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
      }

      if (!resumed) { updMs = performance.now() - t0; return; }

      // Everything else runs at 20 Hz: none of it needs frame resolution.
      accum += dt;
      if (accum < 0.05) { updMs = performance.now() - t0; return; }
      const step = accum; accum = 0;
      ambT += step;

      const A = G.ambience;
      if (A) {
        const time = c.get('time');
        const gust = clamp01(time?.state?.gust ?? 0.62);
        const wind = clamp(time?.state?.windSpeed ?? 5.4, 0, 30) / 12;

        /* --- surf ------------------------------------------------------- */
        const { boom, hiss } = surfEnvelope(ambT, c, listenerPos[0], listenerPos[2]);
        dbg.boom = boom; dbg.hiss = hiss; dbg.gust = gust;
        // Loudest at the waterline; falls off inland and with height.
        const dz = Math.abs(listenerPos[2] - WATERLINE_Z);
        const near = lerp(1.0, 0.30, smoothstep(4, 120, dz)) * lerp(1.0, 0.62, smoothstep(2, 26, listenerPos[1]));
        param(A.surf.out.gain, SURF_BASE * near, 0.25);
        for (let i = 0; i < A.surf.halves.length; i++) {
          const h = A.surf.halves[i];
          const ph = i ? 0.85 : 1.0;                // the two halves are not in step
          // A breaking wave must *darken* the bed, not just get louder: the rumble
          // scales hard with boom while the hiss tracks only the swash that follows.
          param(h.lg.gain, (1.55 + 4.40 * boom) * ph, 0.22);
          param(h.mg.gain, (0.30 + 0.75 * (boom * 0.5 + hiss * 0.5)) * ph, 0.22);
          param(h.hg.gain, (0.055 + 0.30 * hiss) * ph, 0.30);
          param(h.lp.frequency, 190 + 120 * boom, 0.3);
        }

        /* --- wind ------------------------------------------------------- */
        param(A.wind.out.gain, WIND_BASE * lerp(0.75, 1.35, gust) * lerp(0.85, 1.25, wind), 0.35);
        param(A.wind.bp.frequency, 280 + 520 * gust, 0.4);
        param(A.wind.lo.frequency, 900 + 1900 * gust, 0.4);
        param(A.wind.g2.gain, 0.35 + 0.55 * gust, 0.4);
        param(A.wind.w1.frequency, 1500 + 900 * gust, 0.5);
        param(A.wind.w2.frequency, 2500 + 1100 * gust, 0.5);
        param(A.wind.g3.gain, 0.055 * Math.pow(gust, 3.0), 0.5);

        /* --- wildlife --------------------------------------------------- */
        if (ambT > nextGull) {
          nextGull = ambT + ambRnd.range(7, 26);
          const a = ambRnd.range(0, Math.PI * 2), d = ambRnd.range(35, 150);
          mod.play('gull', {
            position: [listenerPos[0] + Math.sin(a) * d, ambRnd.range(14, 46), listenerPos[2] + Math.cos(a) * d],
            volume: ambRnd.range(0.5, 1.0),
          });
        }
        if (ambT > nextBird) {
          nextBird = ambT + ambRnd.range(16, 48);
          mod.play('bird', {
            // up in the dune grass / scrub, inland of the listener
            position: [listenerPos[0] + ambRnd.sym(50), 6 + ambRnd.range(0, 10), listenerPos[2] + 24],
            volume: ambRnd.range(0.3, 0.6),
          });
        }
      }

      /* --- acoustic environment crossfade ------------------------------- */
      const w = envWeights(listenerPos);
      param(G.envs.beach.gain.gain, w.beach, 0.30);
      param(G.envs.bridge.gain.gain, w.bridge, 0.30);
      param(G.envs.cliff.gain.gain, w.cliff, 0.30);

      /* --- shield state ------------------------------------------------- */
      const pl = c.get('player');
      if (pl && typeof pl.shield === 'number') {
        if (shieldWasUp && pl.shield <= 0.01) { shieldWasUp = false; mod.play('shield_down', { volume: 1 }); }
        else if (!shieldWasUp && pl.shield >= 0.99) { shieldWasUp = true; mod.play('shield_recharge', { volume: 1 }); }
      }

      param(G.master.gain, clamp(c.config.audioVolume ?? 0.85, 0, 1.5), 0.15);
      G.reap(ac.currentTime);
      updMs = performance.now() - t0;
    },

    prerender() {},
    resize() {},

    dispose() {
      for (const off of busOff) { try { off(); } catch (e) {} }
      busOff.length = 0;
      gestureCleanup?.();
      try { G?.dispose(); } catch (e) {}
      try { ac?.close(); } catch (e) {}
      ac = null; G = null; ready = false;
    },

    /* ------------------------------------------------------- docs/API.md */

    /** play(id, opts) -> handle | null. opts: { position, volume, pitch, loop, pan, distance } */
    play(id, o = {}) {
      if (inert || !ready || !resumed) return null;
      const when = ac.currentTime + 0.004;
      return G.spawn(id, when, o, shotRnd);
    },

    stop(handle) { if (handle && handle.stop) handle.stop(); },

    setListener(position, quaternion, velocity) {
      if (inert || !ready || !position) return;
      const L = ac.listener;
      listenerPos[0] = position.x ?? position[0];
      listenerPos[1] = position.y ?? position[1];
      listenerPos[2] = position.z ?? position[2];
      if (L.positionX) { L.positionX.value = listenerPos[0]; L.positionY.value = listenerPos[1]; L.positionZ.value = listenerPos[2]; }
      else L.setPosition?.(listenerPos[0], listenerPos[1], listenerPos[2]);
      if (quaternion) {
        tmpQ.set(quaternion.x ?? quaternion[0], quaternion.y ?? quaternion[1],
                 quaternion.z ?? quaternion[2], quaternion.w ?? quaternion[3]);
        fwd.set(0, 0, -1).applyQuaternion(tmpQ);
        up.set(0, 1, 0).applyQuaternion(tmpQ);
        if (L.forwardX) {
          L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
          L.upX.value = up.x; L.upY.value = up.y; L.upZ.value = up.z;
        } else L.setOrientation?.(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
      }
    },

    /** ambience(id, volume) — 'surf' | 'wind' | 'wildlife' | 'all'. */
    ambience(id, volume) {
      if (inert || !ready || !G?.ambience) return;
      const v = clamp(volume ?? 1, 0, 2);
      const A = G.ambience;
      if (id === 'all' || !id) param(A.out.gain, v, 0.3);
      else if (A[id]) param(A[id].out.gain, v, 0.3);
    },

    /* ------------------------------------------------- diagnostics / test */

    get voices() { return VOICE_IDS.slice(); },
    get inert() { return inert; },
    get state() { return ac ? ac.state : 'none'; },
    get costMs() { return updMs; },

    /**
     * Render one cue (or the ambience beds) through an identical offline graph and
     * return the raw AudioBuffer. This is how the cues are verified without ears:
     * peak, RMS, spectral centroid and decay are all measurable from it, and it goes
     * through the same reverb, compressor and output saturator as the live path.
     */
    async renderOffline(id, o = {}) {
      const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (!OAC) throw new Error('no OfflineAudioContext');
      const sr = o.sampleRate ?? 48000;
      const secs = o.seconds ?? 3;
      const oac = new OAC(2, Math.ceil(secs * sr), sr);
      const seed = (o.seed ?? 1337) ^ hashStr(String(id));
      const g = createGraph(oac, new Rand(seed >>> 0), {
        master: o.master ?? 0.85,
        wet: o.wet === false ? 0 : 1,
        listener: () => [0, 1.72, 0],
      });
      if (o.env) {
        for (const k of Object.keys(g.envs)) g.envs[k].gain.gain.value = k === o.env ? 1 : 0;
      }
      if (id === 'ambience' || o.ambience) {
        // Mirrors the live update() mapping exactly, so a measurement here is a
        // measurement of what the game actually plays.
        const boom = o.boom ?? 0.5, hiss = o.hiss ?? 0.5;
        const A = g.startAmbience(0);
        A.out.gain.value = 1;
        A.surf.out.gain.value = o.surf ?? SURF_BASE;
        for (const h of A.surf.halves) {
          h.lg.gain.value = 1.55 + 4.40 * boom;
          h.mg.gain.value = 0.30 + 0.75 * (boom * 0.5 + hiss * 0.5);
          h.hg.gain.value = 0.055 + 0.30 * hiss;
        }
        A.wind.out.gain.value = o.wind ?? WIND_BASE;
        A.wind.g3.gain.value = 0.03;
      }
      if (o.burst) {
        // Sustained fire through the real master chain: the check that a magazine
        // dumped at 900 rpm does not pin the limiter or clip the output.
        const gap = 60 / (o.rpm ?? 900);
        const r = new Rand((seed + 4231) >>> 0);
        const vid = id === 'rifle_burst' ? 'rifle' : id;
        for (let i = 0; i < o.burst; i++) g.spawn(vid, (o.at ?? 0.05) + i * gap, o.opts || {}, r);
      } else if (id !== 'ambience') {
        g.spawn(id, o.at ?? 0.05, o.opts || {}, new Rand((seed + 991) >>> 0));
      }
      const buf = await oac.startRendering();
      // Tear the offline graph down explicitly. Without this, successive renders
      // progressively lost their reverb tail and then went fully silent — three
      // convolvers per graph pile up and nothing releases them.
      g.dispose();
      return buf;
    },
  };

  return mod;
}
