/**
 * `hud` — Halo CE combat HUD.
 *
 * Drawn into the existing `#hud` DOM overlay with a 2D canvas, at devicePixelRatio.
 * That choice is deliberate and has three consequences worth stating up front:
 *
 *   1. It costs **zero** GPU frame budget. Nothing here touches the renderer, the
 *      G-buffer, the post chain or the linear-HDR contract. The browser composites
 *      one extra layer.
 *   2. It is provably outside the measurement path. `__HALO__.screenshot()` reads
 *      `#view.toDataURL()`, i.e. the WebGL canvas alone, so the HUD cannot shift
 *      `lum_mean`, contaminate the grade, or move any metric — with or without
 *      `--skip hud` the captured bytes are identical. See the report.
 *   3. The HUD is therefore verified by full-page screenshots (compositor output),
 *      which is what a player actually sees.
 *
 * Design brief: in the reference clip the HUD is *not in frame at all*. Halo's
 * diegetic design puts the ammo count on the weapon, and everything else auto-hides.
 * So the default state here is: shield bar hidden (full, quiet), motion tracker
 * hidden (no contacts, no recent combat), no damage indicators — leaving only a
 * very thin, low-opacity MA5B reticle. Everything else appears on an event and
 * fades back out.
 *
 * Determinism: every animation phase is a pure function of `ctx.clock.t`, so two
 * captures of the same pose draw the same HUD. No Math.random / Date.now feeds a
 * pixel; performance.now is read only to report this module's own CPU cost.
 *
 * Implements the `hud` interface in docs/API.md:
 *   setHitMarker(kind)   'hit' | 'shield' | 'kill'
 *   showPickup(text)
 *   flashDamage(direction)
 *
 * Subscribes to: player:damaged, actor:damaged, actor:killed, weapon:fired,
 *                weapon:impact, camera:teleport, engine:resize.
 *
 * Runtime knobs on ctx.config (pokeable via __HALO__.setConfig):
 *   hud            false -> render nothing at all
 *   hudOpacity     master multiplier (default 1)
 *   hudReticle     false -> hide the reticle (the reference clip has none)
 *   hudScale       size multiplier (default 1)
 *   hudContacts    [{ position:{x,y,z}, faction:'hostile'|'ally', velocity? }]
 *                  test/debug source for the motion tracker when `ai` is a stub
 */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Frame-rate independent exponential approach. */
const approach = (cur, tgt, dt, tau) => cur + (tgt - cur) * (1 - Math.exp(-dt / (tau > 1e-4 ? tau : 1e-4)));

/* Halo HUD palette. The core of every emissive stroke reads near-white; the cyan
 * lives in the halo around it. That is what makes a thin HUD line look like light
 * rather than like a coloured pencil. */
const C_CORE = '234,249,255';
const C_CYAN = '127,216,255';
const C_DEEP = '58,150,196';
const C_RED = '255,74,51';
const C_AMBER = '255,201,74';
const C_HOSTILE = '255,86,62';
const C_ALLY = '255,214,86';

const rgba = (c, a) => `rgba(${c},${a})`;

export function create(opts = {}) {
  /* ------------------------------------------------------------------ config */
  const CFG = {
    shieldHold: 3.4,        // s the bar stays up after the last change
    shieldRechargeDelay: 3.0,
    shieldRechargeRate: 0.40,   // 1/s  -> 2.5 s from empty
    trackerRange: 25.0,     // metres
    trackerHold: 6.0,       // s of "combat recent" after the last event
    sweepPeriod: 2.0,       // s per revolution
    reticleBase: 11.0,      // px at 1080p
    movingOnly: true,       // Halo: stationary contacts vanish from the tracker
  };

  /* ------------------------------------------------------------------- state */
  const S = {
    ready: false,
    cw: 0, ch: 0, dpr: 1, u: 1,
    t: 0, dt: 0,
    // shield / health
    shield: 1, shieldGhost: 1, shieldVis: 0, shieldLastChange: -99,
    shieldOwned: true,          // true while no `player` module supplies the value
    rechargeAt: -99, recharging: false, brokeAt: -99,
    health: 1, healthVis: 0,
    // combat recency
    combat: -99,
    // reticle
    bloom: 0, hostileTint: 0, hitKind: 0, hitAt: -99,
    // damage
    arcs: [], vignette: 0, dmgFrame: -1, dmgDir: undefined,
    // tracker
    contacts: [], trackerVis: 0, seen: new Map(), pingRim: 0,
    // text
    lines: [],
    // perf — EMA plus a 128-frame ring so the report can quote a p95 rather than a
    // peak that is really just first-frame font shaping or a GC
    ms: 0, msPeak: 0, drawn: 0, skipped: 0,
    msRing: new Float32Array(128), msRingN: 0,
    cleared: true,
  };

  let host = null, cv = null, g = null;
  let L = null;                 // layout, rebuilt on resize
  let chromeTracker = null;     // cached static tracker ring
  let barFx = null, barG = null;  // scratch canvas for the punched-gap shield bar
  let vignGrad = null;
  let unsub = [];
  let ctxRef = null;

  /* ================================================================== layout */

  function buildLayout(cw, ch) {
    const scale = Number(ctxRef?.config?.hudScale) || 1;
    // Keep apparent size constant across resolutions; on ultrawide, key off the
    // 16:9 sub-frame so the tracker does not drift into the far corner.
    const u = clamp(Math.min(ch, cw * 0.5625) / 1080, 0.42, 3.0) * scale;

    // --- shield: shallow dome arc, top centre
    const sHalf = 232 * u;
    const sSag = 19 * u;
    const sTop = 40 * u;
    const sR = (sHalf * sHalf + sSag * sSag) / (2 * sSag);
    const sA = Math.asin(clamp(sHalf / sR, -1, 1));
    const barW = 12.5 * u;
    const hBarW = 4.0 * u;
    const hGap = 6.5 * u;

    // --- motion tracker: bottom-left disc
    const tR = 84 * u;
    const tM = 48 * u;

    L = {
      u, cw, ch,
      cx: cw * 0.5, cy: ch * 0.5,
      shield: {
        cx: cw * 0.5, top: sTop, R: sR, A: sA, half: sHalf, sag: sSag,
        barW, hBarW, hGap, notches: 18, pad: 14 * u,
      },
      tracker: { x: tM + tR, y: ch - tM - tR, r: tR },
      reticle: { x: cw * 0.5, y: ch * 0.5 },
      arcR: 196 * u,
      text: { x: 56 * u, y: 78 * u, size: 15 * u, lh: 25 * u },
    };
  }

  /** Point on the shield dome at parameter k in [-1, 1] (left -> right). */
  function domePt(sh, k, rOff = 0) {
    const ang = -Math.PI * 0.5 + k * sh.A;
    const R = sh.R + rOff;
    return [sh.cx + R * Math.cos(ang), sh.top + sh.R + R * Math.sin(ang)];
  }
  function domeArc(ctx2d, sh, k0, k1, rOff = 0) {
    const cyc = sh.top + sh.R;
    ctx2d.beginPath();
    ctx2d.arc(sh.cx, cyc, sh.R + rOff,
      -Math.PI * 0.5 + k0 * sh.A, -Math.PI * 0.5 + k1 * sh.A, false);
  }

  /* ============================================================ static cache */

  /** The motion tracker's chrome never changes; draw it once per resize. */
  function buildTrackerChrome() {
    const r = L.tracker.r, u = L.u;
    const pad = 16 * u;
    const size = Math.ceil((r + pad) * 2 * S.dpr);
    if (!chromeTracker) chromeTracker = document.createElement('canvas');
    chromeTracker.width = size; chromeTracker.height = size;
    const c = chromeTracker.getContext('2d');
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    c.translate(r + pad, r + pad);

    // Interior: dark teal, translucent. Kept light on purpose — a Halo tracker is a
    // pane of tinted glass, and an opaque disc reads as a grey sticker over the frame.
    const gr = c.createRadialGradient(0, 0, r * 0.05, 0, 0, r);
    gr.addColorStop(0.0, 'rgba(10,34,46,0.115)');
    gr.addColorStop(0.74, 'rgba(8,28,38,0.145)');
    gr.addColorStop(0.95, 'rgba(5,20,28,0.225)');
    gr.addColorStop(1.0, 'rgba(4,16,22,0.27)');
    c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fillStyle = gr; c.fill();

    // A dark ring just inside the rim: this is what keeps the tracker readable over
    // sunlit sand without turning it into a grey disc over sky.
    c.beginPath(); c.arc(0, 0, r - 1.6 * u, 0, TAU);
    c.lineWidth = 3.2 * u; c.strokeStyle = 'rgba(2,10,15,0.22)'; c.stroke();

    c.globalCompositeOperation = 'lighter';

    // Range rings.
    c.lineWidth = 1 * u;
    for (const f of [0.34, 0.67]) {
      c.beginPath(); c.arc(0, 0, r * f, 0, TAU);
      c.strokeStyle = rgba(C_CYAN, 0.085); c.stroke();
    }
    // Faint cross graticule.
    c.beginPath();
    c.moveTo(-r * 0.94, 0); c.lineTo(r * 0.94, 0);
    c.moveTo(0, -r * 0.94); c.lineTo(0, r * 0.94);
    c.strokeStyle = rgba(C_CYAN, 0.05); c.stroke();

    // Outer ring: four arcs with small gaps at the diagonals.
    const gap = 0.052;
    for (let i = 0; i < 4; i++) {
      const a0 = -Math.PI * 0.75 + i * (Math.PI * 0.5) + gap;
      const a1 = a0 + Math.PI * 0.5 - gap * 2;
      c.beginPath(); c.arc(0, 0, r, a0, a1);
      c.lineWidth = 5.0 * u; c.strokeStyle = rgba(C_CYAN, 0.075); c.stroke();
      c.beginPath(); c.arc(0, 0, r, a0, a1);
      c.lineWidth = 1.9 * u; c.strokeStyle = rgba(C_DEEP, 0.34); c.stroke();
      c.beginPath(); c.arc(0, 0, r, a0, a1);
      c.lineWidth = 1.0 * u; c.strokeStyle = rgba(C_CORE, 0.40); c.stroke();
    }
    // Cardinal ticks, outside the ring. Forward (up) is longer.
    c.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const a = -Math.PI * 0.5 + i * Math.PI * 0.5;
      const len = i === 0 ? 8.5 * u : 5.0 * u;
      const x0 = Math.cos(a) * (r + 2.5 * u), y0 = Math.sin(a) * (r + 2.5 * u);
      const x1 = Math.cos(a) * (r + 2.5 * u + len), y1 = Math.sin(a) * (r + 2.5 * u + len);
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1);
      c.lineWidth = 3.6 * u; c.strokeStyle = rgba(C_CYAN, 0.075); c.stroke();
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1);
      c.lineWidth = 1.4 * u; c.strokeStyle = rgba(C_CORE, 0.36); c.stroke();
    }
    c.globalCompositeOperation = 'source-over';
    L.tracker.pad = pad;
  }

  function buildBarScratch() {
    const sh = L.shield;
    const w = Math.ceil((sh.half * 2 + sh.pad * 2) * S.dpr);
    const h = Math.ceil((sh.sag + sh.barW + sh.hGap + sh.hBarW + sh.pad * 2) * S.dpr);
    if (!barFx) barFx = document.createElement('canvas');
    barFx.width = Math.max(2, w); barFx.height = Math.max(2, h);
    barG = barFx.getContext('2d');
    sh.fxW = w / S.dpr; sh.fxH = h / S.dpr;
    sh.fxX = sh.cx - sh.half - sh.pad;
    sh.fxY = sh.top - sh.pad;
  }

  function buildVignette() {
    const r0 = Math.min(L.cw, L.ch) * 0.22;
    const r1 = Math.hypot(L.cw, L.ch) * 0.50;
    const gr = g.createRadialGradient(L.cx, L.cy, r0, L.cx, L.cy, r1);
    gr.addColorStop(0.00, 'rgba(198,30,20,0)');
    gr.addColorStop(0.40, 'rgba(192,26,18,0.16)');
    gr.addColorStop(0.74, 'rgba(178,22,15,0.52)');
    gr.addColorStop(1.00, 'rgba(138,14,10,0.98)');
    vignGrad = gr;
  }

  /* ================================================================= drawing */

  /** Emissive stroke: wide dim halo + narrow bright core, added together. */
  function emissive(path, coreW, coreA, haloW, haloA, core = C_CORE, halo = C_CYAN, ctx2d = g) {
    const prev = ctx2d.globalCompositeOperation;
    ctx2d.globalCompositeOperation = 'lighter';
    ctx2d.lineWidth = haloW; ctx2d.strokeStyle = rgba(halo, haloA); path(); ctx2d.stroke();
    ctx2d.lineWidth = coreW; ctx2d.strokeStyle = rgba(core, coreA); path(); ctx2d.stroke();
    ctx2d.globalCompositeOperation = prev;
  }

  /**
   * Dark contrast underlay. A near-white 1 px line over sunlit sand is invisible —
   * this beach is the brightest background in the game and the reticle has to survive
   * it. Every real Halo HUD element carries this outline for the same reason.
   */
  function shade(path, w, a, ctx2d = g) {
    ctx2d.globalCompositeOperation = 'source-over';
    ctx2d.lineWidth = w;
    ctx2d.strokeStyle = `rgba(2,9,14,${a})`;
    path(); ctx2d.stroke();
  }

  /* ---------------------------------------------------------------- shield */

  function drawShield(alpha) {
    const sh = L.shield, u = L.u, t = S.t;
    const c = barG;
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    c.clearRect(0, 0, sh.fxW, sh.fxH);
    c.translate(sh.pad + sh.half, sh.pad);      // local origin = dome apex
    const cyc = sh.R;                            // circle centre in local space
    const arc = (k0, k1, rOff = 0) => {
      c.beginPath();
      c.arc(0, cyc, sh.R + rOff, -Math.PI * 0.5 + k0 * sh.A, -Math.PI * 0.5 + k1 * sh.A, false);
    };
    c.lineCap = 'butt';

    // Trough. Deliberately light: an empty Halo shield bar is a dark translucent
    // channel you can still see the world through, not a row of grey tiles.
    c.lineWidth = sh.barW + 2.4 * u; arc(-1, 1);
    c.strokeStyle = 'rgba(2,10,15,0.16)'; c.stroke();
    c.lineWidth = sh.barW; arc(-1, 1);
    c.strokeStyle = 'rgba(16,46,60,0.15)'; c.stroke();
    // trough rails — give the empty bar a shape without giving it weight
    c.globalCompositeOperation = 'lighter';
    c.lineWidth = 1.0 * u;
    arc(-1, 1, sh.barW * 0.5); c.strokeStyle = rgba(C_CYAN, 0.24); c.stroke();
    arc(-1, 1, -sh.barW * 0.5); c.strokeStyle = rgba(C_CYAN, 0.17); c.stroke();
    c.globalCompositeOperation = 'source-over';

    const f = clamp(S.shield, 0, 1);
    const fg = clamp(S.shieldGhost, 0, 1);

    // residual "ghost" of the shield just lost — drains a beat behind the real value
    if (fg > f + 0.002) {
      c.globalCompositeOperation = 'lighter';
      c.lineWidth = sh.barW * 0.86;
      arc(-1 + 2 * f, -1 + 2 * fg);
      c.strokeStyle = rgba(C_CORE, 0.22 * clamp((fg - f) * 6, 0, 1));
      c.stroke();
      c.globalCompositeOperation = 'source-over';
    }

    if (f > 0.0015) {
      // Recharge pulse: whole bar breathes; a bright head sits at the fill edge.
      const pulse = S.recharging ? 0.80 + 0.20 * Math.sin(t * 8.6) : 1.0;
      // Cyan body with a real blurred halo (a wide flat stroke reads as a rectangle,
      // not as light), then a bright filament down the middle.
      c.save();
      c.shadowColor = rgba(C_CYAN, 0.85);
      c.shadowBlur = sh.barW * 1.6;
      c.lineWidth = sh.barW * 0.80;
      c.strokeStyle = rgba('122,212,255', 0.88 * pulse);
      arc(-1, -1 + 2 * f); c.stroke();
      arc(-1, -1 + 2 * f); c.stroke();      // second pass deepens the halo
      c.restore();
      c.globalCompositeOperation = 'lighter';
      c.lineWidth = sh.barW * 0.24; arc(-1, -1 + 2 * f);
      c.strokeStyle = rgba(C_CORE, 0.58 * pulse); c.stroke();
      c.globalCompositeOperation = 'source-over';

      // travelling shimmer while charging
      if (S.recharging) {
        const p = ((t * 0.9) % 1);
        const k = -1 + 2 * f * p;
        const wid = 0.16 * f;
        const gA = clamp(Math.sin(p * Math.PI), 0, 1) * 0.30;
        c.globalCompositeOperation = 'lighter';
        c.lineWidth = sh.barW * 0.70;
        arc(Math.max(-1, k - wid), Math.min(-1 + 2 * f, k + wid));
        c.strokeStyle = rgba(C_CORE, gA); c.stroke();
        c.globalCompositeOperation = 'source-over';
      }
      // charge head
      if (S.recharging && f < 0.995) {
        const [hx, hy] = [
          Math.cos(-Math.PI * 0.5 + (-1 + 2 * f) * sh.A) * sh.R,
          cyc + Math.sin(-Math.PI * 0.5 + (-1 + 2 * f) * sh.A) * sh.R,
        ];
        c.globalCompositeOperation = 'lighter';
        c.beginPath(); c.arc(hx, hy, sh.barW * 0.52, 0, TAU);
        c.fillStyle = rgba(C_CORE, 0.30); c.fill();
        c.globalCompositeOperation = 'source-over';
      }
    }

    // shield down: the trough itself alarms
    const sinceBroke = t - S.brokeAt;
    if (f <= 0.0015 && sinceBroke >= 0) {
      const fast = sinceBroke < 0.75 ? (Math.sin(sinceBroke * 46) * 0.5 + 0.5) : 0;
      const slow = 0.35 + 0.35 * (Math.sin(t * 8.0) * 0.5 + 0.5);
      const a = clamp(Math.max(fast, slow) * 0.62, 0, 1);
      c.save();
      c.shadowColor = rgba(C_RED, 0.8);
      c.shadowBlur = sh.barW * 1.5;
      c.lineWidth = sh.barW * 0.62; arc(-1, 1);
      c.strokeStyle = rgba(C_RED, a * 0.82); c.stroke();
      c.restore();
      c.globalCompositeOperation = 'lighter';
      c.lineWidth = sh.barW * 0.20; arc(-1, 1);
      c.strokeStyle = rgba('255,204,190', a * 0.55); c.stroke();
      c.globalCompositeOperation = 'source-over';
    }

    // health rail, only ever visible when hurt
    if (S.healthVis > 0.004) {
      const hOff = -(sh.barW * 0.5 + sh.hGap + sh.hBarW * 0.5);
      const lowPulse = S.health < 0.34 ? 0.62 + 0.38 * (Math.sin(t * 6.4) * 0.5 + 0.5) : 1;
      c.globalAlpha = S.healthVis;
      c.lineWidth = sh.hBarW + 1.6 * u; arc(-1, 1, hOff);
      c.strokeStyle = 'rgba(3,10,14,0.34)'; c.stroke();
      const col = S.health < 0.34 ? C_RED : C_AMBER;
      emissive(() => arc(-1, -1 + 2 * clamp(S.health, 0, 1), hOff),
        sh.hBarW * 0.8, 0.80 * lowPulse, sh.hBarW * 2.0, 0.14 * lowPulse, C_CORE, col, c);
      c.globalAlpha = 1;
    }

    // Punch the segment gaps straight through — Halo's segments are voids, not
    // painted lines, so the scene shows between them.
    c.globalCompositeOperation = 'destination-out';
    c.lineWidth = 2.0 * u; c.lineCap = 'butt';
    c.strokeStyle = 'rgba(0,0,0,1)';
    const inner = -(sh.barW * 0.5 + sh.hGap + sh.hBarW + 2 * u);
    const outer = sh.barW * 0.62;
    for (let i = 1; i < sh.notches; i++) {
      const k = -1 + (2 * i) / sh.notches;
      const a = -Math.PI * 0.5 + k * sh.A;
      const ca = Math.cos(a), sa = Math.sin(a);
      c.beginPath();
      c.moveTo(ca * (sh.R + inner), cyc + sa * (sh.R + inner));
      c.lineTo(ca * (sh.R + outer), cyc + sa * (sh.R + outer));
      c.stroke();
    }
    c.globalCompositeOperation = 'source-over';

    g.globalAlpha = alpha;
    g.drawImage(barFx, sh.fxX, sh.fxY, sh.fxW, sh.fxH);
    g.globalAlpha = 1;

    // End brackets, drawn on the main canvas so the notch punch cannot touch them.
    const capA = alpha * 0.55;
    for (const s of [-1, 1]) {
      const a = -Math.PI * 0.5 + s * sh.A;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ox = sh.cx + ca * sh.R, oy = sh.top + sh.R + sa * sh.R;
      const nx = ca, ny = sa;              // outward radial
      const tx = -sa * s, ty = ca * s;     // outward tangential
      const half = sh.barW * 0.72;
      const lead = 7.5 * u;
      const bracket = () => {
        g.beginPath();
        g.moveTo(ox + nx * -half + tx * 1.5 * u, oy + ny * -half + ty * 1.5 * u);
        g.lineTo(ox + nx * -half + tx * lead, oy + ny * -half + ty * lead);
        g.lineTo(ox + nx * half + tx * lead * 0.45, oy + ny * half + ty * lead * 0.45);
        g.lineTo(ox + nx * half + tx * 1.5 * u, oy + ny * half + ty * 1.5 * u);
      };
      shade(bracket, 3.0 * u, capA * 0.42);
      emissive(bracket, 1.3 * u, capA * 0.9, 3.4 * u, capA * 0.22);
    }
  }

  /* --------------------------------------------------------------- tracker */

  function drawTracker(alpha) {
    const tr = L.tracker, u = L.u, r = tr.r, t = S.t;
    g.save();
    g.globalAlpha = alpha;
    g.drawImage(chromeTracker, tr.x - r - tr.pad, tr.y - r - tr.pad,
      (r + tr.pad) * 2, (r + tr.pad) * 2);
    g.globalAlpha = 1;
    g.translate(tr.x, tr.y);

    const sweep = (t / CFG.sweepPeriod) * TAU;

    // sweep wedge, clipped to the disc
    g.save();
    g.beginPath(); g.arc(0, 0, r * 0.985, 0, TAU); g.clip();
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = alpha;
    if (g.createConicGradient) {
      // p=1 is immediately *behind* the head, p=0 is at it: a hard leading edge with
      // a long soft tail, which is exactly how a radar sweep reads.
      const cg = g.createConicGradient(sweep, 0, 0);
      cg.addColorStop(0.000, rgba(C_CYAN, 0.000));
      cg.addColorStop(0.560, rgba(C_CYAN, 0.022));
      cg.addColorStop(0.840, rgba(C_CYAN, 0.090));
      cg.addColorStop(0.965, rgba(C_CYAN, 0.230));
      cg.addColorStop(1.000, rgba(C_CORE, 0.420));
      g.fillStyle = cg; g.fillRect(-r, -r, r * 2, r * 2);
    } else {
      for (let i = 0; i < 14; i++) {
        const a0 = sweep - (i + 1) * 0.075, a1 = sweep - i * 0.075;
        g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, r, a0, a1); g.closePath();
        g.fillStyle = rgba(C_CYAN, 0.30 * Math.pow(1 - i / 14, 2.2)); g.fill();
      }
    }
    // leading edge line
    g.beginPath(); g.moveTo(0, 0);
    g.lineTo(Math.cos(sweep) * r, Math.sin(sweep) * r);
    g.lineWidth = 2.6 * u; g.strokeStyle = rgba(C_CYAN, 0.16); g.stroke();
    g.beginPath(); g.moveTo(0, 0);
    g.lineTo(Math.cos(sweep) * r, Math.sin(sweep) * r);
    g.lineWidth = 1.0 * u; g.strokeStyle = rgba(C_CORE, 0.38); g.stroke();
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.restore();

    // contacts
    g.globalCompositeOperation = 'lighter';
    for (const ct of S.contacts) {
      const a = alpha * ct.vis * (0.50 + 0.50 * ct.ping);
      if (a <= 0.004) continue;
      const col = ct.hostile ? C_HOSTILE : C_ALLY;
      const rad = ct.size * u;
      g.globalAlpha = a;
      // soft bloom
      const gr = g.createRadialGradient(ct.px, ct.py, 0, ct.px, ct.py, rad * 3.0);
      gr.addColorStop(0, rgba(col, 0.55));
      gr.addColorStop(1, rgba(col, 0));
      g.beginPath(); g.arc(ct.px, ct.py, rad * 3.0, 0, TAU);
      g.fillStyle = gr; g.fill();
      // core
      g.beginPath(); g.arc(ct.px, ct.py, rad, 0, TAU);
      g.fillStyle = rgba(col, 0.95); g.fill();
      g.beginPath(); g.arc(ct.px, ct.py, rad * 0.44, 0, TAU);
      g.fillStyle = rgba('255,240,232', 0.85); g.fill();
      g.globalAlpha = 1;
    }
    g.globalCompositeOperation = 'source-over';

    // player wedge — always points up; the tracker is view-relative
    const ws = 5.6 * u;
    const wedge = () => {
      g.beginPath();
      g.moveTo(0, -ws * 1.15); g.lineTo(ws * 0.82, ws * 0.72);
      g.lineTo(0, ws * 0.34); g.lineTo(-ws * 0.82, ws * 0.72);
      g.closePath();
    };
    shade(wedge, 2.8 * u, alpha * 0.45);
    emissive(wedge, 1.25 * u, alpha * 0.80, 3.2 * u, alpha * 0.20);

    // rim brightens when something is close
    if (S.pingRim > 0.01) {
      emissive(() => { g.beginPath(); g.arc(0, 0, r, 0, TAU); },
        1.4 * u, alpha * S.pingRim * 0.35, 6 * u, alpha * S.pingRim * 0.10, C_HOSTILE, C_HOSTILE);
    }
    g.restore();
  }

  /* --------------------------------------------------------------- reticle */

  function drawReticle(alpha) {
    const u = L.u, t = S.t;
    const cam = ctxRef.camera;
    // Project the weapon's cone half-angle to pixels: physically the right way to
    // make the reticle "expand with spread" at any FOV or resolution.
    const w = ctxRef.get('weapons');
    let rad = CFG.reticleBase * u;
    const spread = w && w.current && Number.isFinite(w.current.spread) ? w.current.spread : null;
    if (spread !== null && cam) {
      const focal = (L.ch * 0.5) / Math.tan((cam.fov * Math.PI / 180) * 0.5);
      rad = clamp(focal * Math.tan(clamp(spread, 0, 0.35)) * 0.5, 7 * u, 70 * u);
    }
    rad += S.bloom * 9 * u;
    const ads = w && Number.isFinite(w.adsAmount) ? w.adsAmount : 0;
    const a = alpha * (0.50 - 0.14 * ads);

    const tint = S.hostileTint;
    const core = tint > 0.01
      ? `${Math.round(234 + (255 - 234) * tint)},${Math.round(249 - 149 * tint)},${Math.round(255 - 196 * tint)}`
      : C_CORE;
    const halo = tint > 0.01 ? C_RED : C_CYAN;

    const len = 7.0 * u;
    g.lineCap = 'round';
    const ticks = () => {
      g.beginPath();
      for (let i = 0; i < 4; i++) {
        const an = i * Math.PI * 0.5;
        const cx = Math.cos(an), cy = Math.sin(an);
        g.moveTo(L.cx + cx * rad, L.cy + cy * rad);
        g.lineTo(L.cx + cx * (rad + len), L.cy + cy * (rad + len));
      }
    };
    shade(ticks, 3.0 * u, a * 0.62);
    emissive(ticks, 1.3 * u, a, 3.4 * u, a * 0.30, core, halo);

    // centre dot
    g.beginPath(); g.arc(L.cx, L.cy, 2.3 * u, 0, TAU);
    g.fillStyle = `rgba(2,9,14,${a * 0.55})`; g.fill();
    g.globalCompositeOperation = 'lighter';
    g.beginPath(); g.arc(L.cx, L.cy, 1.15 * u, 0, TAU);
    g.fillStyle = rgba(core, a * 1.15); g.fill();
    g.globalCompositeOperation = 'source-over';

    // reload sweep — a thin arc winding round the reticle
    if (w && w.isReloading) {
      const p = clamp(Number(w.reloadProgress), 0, 1) || ((t * 0.4) % 1);
      emissive(() => { g.beginPath(); g.arc(L.cx, L.cy, rad + len * 2.1, -Math.PI * 0.5, -Math.PI * 0.5 + p * TAU); },
        1.2 * u, a * 0.9, 3.0 * u, a * 0.25);
    }

    // hit marker
    const dtHit = t - S.hitAt;
    if (dtHit >= 0 && dtHit < 0.42) {
      const k = 1 - dtHit / 0.42;
      const ease = k * k;
      const kind = S.hitKind;   // 0 hit, 1 shield, 2 kill
      const hc = kind === 2 ? C_RED : kind === 1 ? C_CYAN : C_CORE;
      const r0 = rad + len * 1.5 + (1 - ease) * 5 * u;
      const r1 = r0 + 7.5 * u * (0.6 + 0.4 * ease);
      g.lineCap = 'butt';
      const spurs = () => {
        g.beginPath();
        for (let i = 0; i < 4; i++) {
          const an = Math.PI * 0.25 + i * Math.PI * 0.5;
          const cx = Math.cos(an), cy = Math.sin(an);
          g.moveTo(L.cx + cx * r0, L.cy + cy * r0);
          g.lineTo(L.cx + cx * r1, L.cy + cy * r1);
        }
      };
      shade(spurs, 3.6 * u, alpha * 0.45 * ease);
      emissive(spurs, 1.7 * u, alpha * 0.85 * ease, 4.2 * u, alpha * 0.28 * ease, hc, hc);
      if (kind === 2) {
        emissive(() => {
          g.beginPath();
          const s = 4.6 * u;
          g.moveTo(L.cx - s, L.cy - s); g.lineTo(L.cx + s, L.cy + s);
          g.moveTo(L.cx + s, L.cy - s); g.lineTo(L.cx - s, L.cy + s);
        }, 1.6 * u, alpha * 0.9 * ease, 4.0 * u, alpha * 0.3 * ease, C_RED, C_RED);
      }
    }
  }

  /* ------------------------------------------------- damage arcs + vignette */

  /**
   * Halo's damage indicator is a blade of light, not a line.
   *
   * Segmenting an arc and fading each segment's alpha leaves a visible rib at every
   * seam, so the feather is geometric instead: one closed path whose radial thickness
   * tapers to a point at both ends, filled with a radial gradient that runs
   * transparent -> red -> white -> red -> transparent across the band. Two 1-D ramps,
   * one fill, no seams. shadowBlur supplies the outer bloom.
   */
  function drawDamage(alpha) {
    const u = L.u;
    const halfW = 10.5 * u;
    const span = 0.74;                 // radians, ~42 deg
    const K = 24;
    for (const d of S.arcs) {
      const a = alpha * d.a;
      if (a <= 0.005) continue;
      const R = L.arcR + (1 - d.a) * 26 * u;
      const a0 = d.ang - span * 0.5;
      const band = g.createRadialGradient(L.cx, L.cy, Math.max(0, R - halfW), L.cx, L.cy, R + halfW);
      band.addColorStop(0.00, 'rgba(255,58,34,0)');
      band.addColorStop(0.22, 'rgba(255,74,44,0.34)');
      band.addColorStop(0.42, 'rgba(255,110,72,0.80)');
      band.addColorStop(0.50, 'rgba(255,232,216,1)');
      band.addColorStop(0.58, 'rgba(255,110,72,0.80)');
      band.addColorStop(0.78, 'rgba(255,74,44,0.34)');
      band.addColorStop(1.00, 'rgba(255,58,34,0)');

      g.beginPath();
      for (let i = 0; i <= K; i++) {
        const p = i / K;
        const rr = R + halfW * Math.pow(Math.sin(p * Math.PI), 0.58);
        const an = a0 + span * p;
        const x = L.cx + Math.cos(an) * rr, y = L.cy + Math.sin(an) * rr;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      for (let i = K; i >= 0; i--) {
        const p = i / K;
        const rr = R - halfW * Math.pow(Math.sin(p * Math.PI), 0.58);
        const an = a0 + span * p;
        g.lineTo(L.cx + Math.cos(an) * rr, L.cy + Math.sin(an) * rr);
      }
      g.closePath();

      g.save();
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = a * 0.92;
      g.shadowColor = 'rgba(255,72,46,0.7)';
      g.shadowBlur = 15 * u;
      g.fillStyle = band;
      g.fill();
      g.restore();
    }
  }

  function drawVignette(alpha) {
    if (!vignGrad) buildVignette();
    g.globalAlpha = clamp(S.vignette, 0, 1) * alpha;
    g.fillStyle = vignGrad;
    g.fillRect(0, 0, L.cw, L.ch);
    g.globalAlpha = 1;
  }

  /* ------------------------------------------------------------------ text */

  function drawText(alpha) {
    const T = L.text, u = L.u;
    g.textBaseline = 'alphabetic';
    g.font = `500 ${T.size.toFixed(1)}px "Segoe UI", Roboto, system-ui, sans-serif`;
    try { g.letterSpacing = `${(T.size * 0.16).toFixed(2)}px`; } catch { /* older engines */ }
    for (let i = 0; i < S.lines.length; i++) {
      const ln = S.lines[i];
      const a = alpha * ln.a;
      if (a <= 0.006) continue;
      const y = T.y + i * T.lh - (1 - ln.a) * 4 * u;
      // chevron
      g.globalCompositeOperation = 'lighter';
      g.beginPath();
      g.moveTo(T.x - 14 * u, y - T.size * 0.62);
      g.lineTo(T.x - 8 * u, y - T.size * 0.32);
      g.lineTo(T.x - 14 * u, y - T.size * 0.02);
      g.lineWidth = 1.3 * u; g.strokeStyle = rgba(C_CYAN, a * 0.65); g.stroke();
      g.globalCompositeOperation = 'source-over';
      // legibility shadow, then the emissive glyphs
      g.fillStyle = `rgba(2,7,11,${a * 0.55})`;
      g.fillText(ln.text, T.x + 1.2 * u, y + 1.2 * u);
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = rgba(C_CYAN, a * 0.22);
      g.fillText(ln.text, T.x, y);
      g.fillStyle = rgba(C_CORE, a * 0.80);
      g.fillText(ln.text, T.x, y);
      g.globalCompositeOperation = 'source-over';
    }
    try { g.letterSpacing = '0px'; } catch { /* noop */ }
  }

  /* ================================================================ sim step */

  /** Camera yaw straight off the quaternion — no Vector3 allocation per frame. */
  function camYaw(cam) {
    const q = cam.quaternion;
    const fx = -2 * (q.x * q.z + q.w * q.y);
    const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    return Math.atan2(-fx, -fz);
  }

  /**
   * The HUD's animation clock, read live.
   *
   * `S.t` is only refreshed in update(), so an event that arrives between two frames
   * would be stamped with the *previous* frame's time. Normally that is a sub-frame
   * error and invisible — but the capture harness can jump `clock.t` by seconds with
   * setTime(), and a stale stamp then makes every timer (pickup lifetime, recharge
   * delay, shield hold) fire instantly. Public entry points resync through this.
   */
  function hudNow() {
    if (ctxRef?.config?.frozen) return S.t;
    const t = ctxRef?.clock?.t;
    return Number.isFinite(t) ? t : S.t;
  }

  /**
   * The whole damage reaction, shared by the bus handler and the public API.
   * `direction` points FROM the player TOWARD the source (Vector3-ish), or is a
   * world bearing in radians, or null for an omnidirectional hit.
   */
  function applyDamageFx(direction, amount) {
    const t = S.t = hudNow();
    S.combat = t;
    S.shieldLastChange = t;
    S.rechargeAt = t + CFG.shieldRechargeDelay;
    S.vignette = clamp(S.vignette + clamp(amount * 1.7, 0.07, 0.45), 0, 0.62);
    S.cleared = false;

    if (S.shieldOwned) {
      const before = S.shield;
      S.shield = clamp(S.shield - amount, 0, 1);
      if (before > 0.0015 && S.shield <= 0.0015) S.brokeAt = t;
      if (S.shield <= 0 && before <= 0.0015) S.health = clamp(S.health - amount * 0.8, 0, 1);
    }

    if (direction === null || direction === undefined) return;
    let bearing;
    if (typeof direction === 'number') bearing = direction;
    else if (Number.isFinite(direction.x)) {
      const player = livePlayer(ctxRef);
      const yaw = (player && Number.isFinite(player.yaw)) ? player.yaw : camYaw(ctxRef.camera);
      const dx = direction.x, dz = direction.z;
      const fwd = -dx * Math.sin(yaw) - dz * Math.cos(yaw);
      const rgt = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      bearing = Math.atan2(rgt, fwd);            // 0 = dead ahead, +ve = to the right
    } else return;
    // canvas angles start at +X (screen right); dead ahead belongs at the top
    const ang = bearing - Math.PI * 0.5;
    const near = S.arcs.find((d) => Math.abs(((d.ang - ang + Math.PI) % TAU + TAU) % TAU - Math.PI) < 0.30);
    if (near) { near.a = 1; near.ang = ang; }
    else {
      S.arcs.push({ ang, a: 1 });
      while (S.arcs.length > 4) S.arcs.shift();
    }
  }

  /** The `player` module, but only while it is actually live and authoritative. */
  function livePlayer(ctx) {
    const p = ctx.get('player');
    return (p && p.enabled !== false) ? p : null;
  }

  function refreshContacts(ctx, dt) {
    const t = S.t;
    const player = livePlayer(ctx);
    const cam = ctx.camera;
    let px, py, pz, yaw;
    if (player && player.position && Number.isFinite(player.position.x)) {
      // feet, so contact elevation compares like-for-like against actor origins
      px = player.position.x; py = player.position.y; pz = player.position.z;
      yaw = Number.isFinite(player.yaw) ? player.yaw : camYaw(cam);
    } else {
      px = cam.position.x; py = cam.position.y - 1.72; pz = cam.position.z;
      yaw = camYaw(cam);
    }

    const ai = ctx.get('ai');
    const cfgList = ctx.config?.hudContacts;
    const src = Array.isArray(cfgList) ? cfgList
      : (ai && Array.isArray(ai.actors) ? ai.actors : null);

    S.contacts.length = 0;
    S.pingRim = approach(S.pingRim, 0, dt, 0.35);
    if (!src || src.length === 0) { S.seen.clear(); return; }

    const range = CFG.trackerRange;
    const r = L.tracker.r;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const sweep = ((t / CFG.sweepPeriod) % 1) * TAU;
    const prevSweep = (((t - dt) / CFG.sweepPeriod) % 1) * TAU;

    for (let i = 0; i < src.length; i++) {
      const act = src[i];
      if (!act) continue;
      const p = act.position || act.pos;
      if (!p || !Number.isFinite(p.x)) continue;
      if (act.alive === false || act.health === 0) { S.seen.delete(act.id ?? i); continue; }

      const dx = p.x - px, dz = p.z - pz, dy = (p.y ?? py) - py;
      const dist = Math.hypot(dx, dz);
      if (dist > range * 1.06) { S.seen.delete(act.id ?? i); continue; }

      // world -> view-relative (forward = -Z at yaw 0, so forward = (-sin, -cos))
      const fwd = -dx * sy - dz * cy;
      const rgt = dx * cy - dz * sy;
      const k = Math.min(dist, range) / range;
      const rr = k * r * 0.955;
      const inv = dist > 1e-4 ? 1 / dist : 0;
      const ux = rgt * inv, uy = -fwd * inv;

      const key = act.id ?? i;
      let st = S.seen.get(key);
      if (!st) { st = { vis: 0, ping: 1, ang: 0, x: p.x, z: p.z, spd: 1, first: true }; S.seen.set(key, st); }

      // speed: prefer a supplied velocity, else difference the position
      let spd;
      const v = act.velocity;
      if (v && Number.isFinite(v.x)) spd = Math.hypot(v.x, v.z);
      else if (st.first) spd = 1;
      else spd = dt > 1e-5 ? Math.hypot(p.x - st.x, p.z - st.z) / dt : st.spd;
      st.spd = approach(st.spd, spd, dt, 0.18);
      st.x = p.x; st.z = p.z; st.first = false;

      const moving = !CFG.movingOnly || st.spd > 0.35 || act.firing === true;
      const edgeFade = clamp((range * 1.02 - dist) / (range * 0.10), 0, 1);
      st.vis = approach(st.vis, moving ? edgeFade : 0, dt, moving ? 0.10 : 0.42);

      // sweep ping: fire when the sweep line crosses this bearing
      const ang = Math.atan2(uy, ux);
      const norm = (a) => (a % TAU + TAU) % TAU;
      const na = norm(ang), ns = norm(sweep), nps = norm(prevSweep);
      const crossed = ns >= nps ? (na > nps && na <= ns) : (na > nps || na <= ns);
      if (crossed) st.ping = 1;
      st.ping = approach(st.ping, 0, dt, 0.62);

      if (st.vis <= 0.004) continue;
      const hostile = act.faction ? (act.faction !== 'ally' && act.faction !== 'friendly' && act.faction !== 'unsc')
        : act.hostile !== false;
      // elevation is carried by dot size, Halo-style
      const size = 5.2 * (1 + clamp(dy / 7, -0.42, 0.62));
      S.contacts.push({ px: ux * rr, py: uy * rr, vis: st.vis, ping: st.ping, hostile, size });
      if (hostile && dist < range * 0.34) S.pingRim = Math.max(S.pingRim, st.vis * (1 - dist / (range * 0.34)));
    }
  }

  /* ================================================================== module */

  const mod = {
    name: 'hud',
    order: 85,
    enabled: true,

    /** Live cost + visibility, for the report and for debugging. */
    stats: S,

    async init(ctx) {
      ctxRef = ctx;
      if (typeof document === 'undefined') return;
      host = document.getElementById('hud');
      if (!host) { console.warn('[hud] no #hud element; HUD disabled'); return; }

      cv = document.createElement('canvas');
      cv.id = 'hud-canvas';
      cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:block';
      host.appendChild(cv);
      g = cv.getContext('2d', { alpha: true });
      if (!g) { console.warn('[hud] no 2d context; HUD disabled'); return; }

      const on = (e, f) => unsub.push(ctx.on(e, f));

      // `player` both emits this AND calls hud.flashDamage(direction) straight after,
      // so the same hit would land twice. The event carries the real amount, so take
      // it and fingerprint the (frame, direction) pair; the follow-up direct call
      // with the identical direction reference is then ignored.
      on('player:damaged', (p) => {
        const dir = p?.direction ?? p?.dir ?? p?.source ?? null;
        applyDamageFx(dir, Number(p?.amount) || 0.12);
        S.dmgFrame = ctx.clock.frame; S.dmgDir = dir;
      });
      on('actor:damaged', (p) => {
        const dead = p?.actor && (p.actor.alive === false || p.actor.health <= 0);
        mod.setHitMarker(dead ? 'kill' : (p?.shield ? 'shield' : 'hit'));
      });
      on('actor:killed', () => mod.setHitMarker('kill'));
      // `player` emits these too; they give an exact break instant rather than one
      // inferred from a sampled value.
      on('player:shieldBroken', () => { S.brokeAt = S.shieldLastChange = S.t = hudNow(); S.cleared = false; });
      on('player:shieldFull', () => { S.shieldLastChange = S.t = hudNow(); });
      on('player:died', () => { S.vignette = 0.62; S.brokeAt = S.t = hudNow(); });
      on('player:respawn', () => {
        S.arcs.length = 0; S.vignette = 0; S.brokeAt = -99;
        S.shield = 1; S.shieldGhost = 1; S.health = 1;
      });
      on('weapon:fired', () => {
        S.combat = S.t = hudNow();
        S.bloom = clamp(S.bloom + 0.34, 0, 1.6);
        S.cleared = false;
      });
      on('weapon:impact', () => { S.combat = S.t = hudNow(); });
      on('camera:teleport', () => {
        S.seen.clear(); S.contacts.length = 0;
        S.arcs.length = 0; S.vignette = 0; S.lines.length = 0;
        S.bloom = 0; S.hostileTint = 0; S.hitAt = -99;
      });
      on('engine:resize', ({ w, h }) => mod.resize(w, h, ctx));

      S.ready = true;
      mod.resize(ctx.size.w, ctx.size.h, ctx);
    },

    resize(w, h, ctx) {
      if (!g) return;
      const dpr = clamp(globalThis.devicePixelRatio || 1, 1, 2);
      const cw = Math.max(2, Math.round(host.clientWidth || w || 1920));
      const ch = Math.max(2, Math.round(host.clientHeight || h || 1080));
      const bw = Math.max(2, Math.round(cw * dpr));
      const bh = Math.max(2, Math.round(ch * dpr));
      if (cw === S.cw && ch === S.ch && dpr === S.dpr && cv.width === bw) return;
      S.cw = cw; S.ch = ch; S.dpr = dpr;
      cv.width = bw; cv.height = bh;
      buildLayout(cw, ch);
      buildTrackerChrome();
      buildBarScratch();
      vignGrad = null;
      // Shape the HUD font once here rather than paying ~10 ms of first-layout cost
      // on whichever frame happens to show the first pickup line.
      g.font = `500 ${L.text.size.toFixed(1)}px "Segoe UI", Roboto, system-ui, sans-serif`;
      try { g.letterSpacing = `${(L.text.size * 0.16).toFixed(2)}px`; } catch { /* noop */ }
      g.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
      try { g.letterSpacing = '0px'; } catch { /* noop */ }
      S.cleared = false;
    },

    update(dt, ctx) {
      if (!S.ready || !g) return;
      if (!(dt > 0)) dt = 1 / 60;
      S.dt = dt;
      if (!ctx.config?.frozen) S.t = ctx.clock.t;

      const t = S.t;

      // --- shield / health: mirror `player` when it exists, simulate otherwise
      const player = livePlayer(ctx);
      const hasShield = player && Number.isFinite(player.shield);
      if (hasShield) {
        if (Math.abs(player.shield - S.shield) > 0.0015) S.shieldLastChange = t;
        if (player.shield < S.shield - 0.002) S.rechargeAt = t + CFG.shieldRechargeDelay;
        if (player.shield <= 0.0015 && S.shield > 0.0015) S.brokeAt = t;
        S.shield = clamp(player.shield, 0, 1);
        S.shieldOwned = false;
      } else {
        S.shieldOwned = true;
        if (S.shield < 1 && t >= S.rechargeAt) {
          S.shield = clamp(S.shield + dt * CFG.shieldRechargeRate, 0, 1);
          S.shieldLastChange = t;
        }
      }
      S.recharging = S.shield < 0.998 && t >= S.rechargeAt && S.shield > 0;
      if (player && Number.isFinite(player.health)) S.health = clamp(player.health, 0, 1);

      // residual ghost drains a beat behind
      if (S.shieldGhost > S.shield) {
        if (t - S.shieldLastChange > 0.22) S.shieldGhost = Math.max(S.shield, S.shieldGhost - dt * 0.85);
      } else S.shieldGhost = S.shield;

      const shieldActive = S.shield < 0.995 || S.health < 0.999
        || (t - S.shieldLastChange) < CFG.shieldHold
        || (t - S.combat) < CFG.shieldHold;
      S.shieldVis = approach(S.shieldVis, shieldActive ? 1 : 0, dt, shieldActive ? 0.09 : 0.30);
      S.healthVis = approach(S.healthVis, S.health < 0.999 ? 1 : 0, dt, S.health < 0.999 ? 0.12 : 0.45);

      // --- reticle
      S.bloom = approach(S.bloom, 0, dt, 0.26);
      S.hostileTint = approach(S.hostileTint, 0, dt, 0.30);

      // --- damage arcs + vignette
      for (let i = S.arcs.length - 1; i >= 0; i--) {
        const d = S.arcs[i];
        d.a = approach(d.a, 0, dt, 0.42);
        if (d.a < 0.004) S.arcs.splice(i, 1);
      }
      const lowHealth = S.health < 0.34 ? (0.34 - S.health) / 0.34 : 0;
      const floorV = lowHealth * (0.10 + 0.07 * Math.sin(t * 7.0));
      S.vignette = Math.max(approach(S.vignette, floorV, dt, 0.42), floorV);

      // --- pickup / objective text
      for (let i = S.lines.length - 1; i >= 0; i--) {
        const ln = S.lines[i];
        const age = t - ln.t0;
        ln.a = age < 0.18 ? age / 0.18
          : age < 3.4 ? 1
            : 1 - (age - 3.4) / 0.9;
        if (ln.a <= 0.004) S.lines.splice(i, 1);
      }

      // --- tracker
      refreshContacts(ctx, dt);
      const trackerActive = S.contacts.length > 0 || (t - S.combat) < CFG.trackerHold;
      S.trackerVis = approach(S.trackerVis, trackerActive ? 1 : 0, dt, trackerActive ? 0.18 : 0.55);
    },

    prerender(ctx) {
      if (!S.ready || !g || !L) return;
      const t0 = performance.now();

      // cheap guard against a CSS-driven resize the engine never saw
      if (host.clientWidth !== S.cw || host.clientHeight !== S.ch) mod.resize(S.cw, S.ch, ctx);

      const cfg = ctx.config || {};
      const master = cfg.hud === false ? 0 : clamp(Number(cfg.hudOpacity ?? 1), 0, 1);
      const reticleOn = cfg.hudReticle !== false && master > 0;

      const hitLive = S.hitAt > -1 && (S.t - S.hitAt) < 0.42;
      const anything = master > 0 && (reticleOn
        || S.shieldVis > 0.004 || S.trackerVis > 0.004 || S.vignette > 0.004
        || S.arcs.length > 0 || S.lines.length > 0 || hitLive);

      if (!anything) {
        // Fully idle: clear once, then do literally nothing per frame.
        if (!S.cleared) { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); S.cleared = true; }
        S.skipped++;
        return;
      }

      g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      g.clearRect(0, 0, S.cw, S.ch);
      S.cleared = false;
      g.lineJoin = 'round';

      if (S.vignette > 0.004) drawVignette(master);
      if (S.shieldVis > 0.004) drawShield(master * S.shieldVis);
      if (S.trackerVis > 0.004) drawTracker(master * S.trackerVis);
      if (reticleOn) drawReticle(master);
      if (S.arcs.length) drawDamage(master);
      if (S.lines.length) drawText(master);

      const ms = performance.now() - t0;
      S.ms = S.ms * 0.9 + ms * 0.1;
      if (ms > S.msPeak) S.msPeak = ms;
      S.msRing[S.msRingN++ & 127] = ms;
      S.drawn++;
    },

    /** { ms (EMA), p50, p95, peak, drawn, skipped } — draw cost in milliseconds. */
    timing() {
      const n = Math.min(S.msRingN, 128);
      if (!n) return { ms: 0, p50: 0, p95: 0, peak: 0, drawn: S.drawn, skipped: S.skipped };
      const a = Array.from(S.msRing.slice(0, n)).sort((x, y) => x - y);
      return {
        ms: +S.ms.toFixed(4),
        p50: +a[(n * 0.50) | 0].toFixed(4),
        p95: +a[Math.min(n - 1, (n * 0.95) | 0)].toFixed(4),
        peak: +S.msPeak.toFixed(4),
        drawn: S.drawn, skipped: S.skipped,
      };
    },

    /* ------------------------------------------------------- docs/API.md */

    /** kind: 'hit' | 'shield' | 'kill' */
    setHitMarker(kind = 'hit') {
      const t = S.t = hudNow();
      S.hitKind = kind === 'kill' ? 2 : kind === 'shield' ? 1 : 0;
      S.hitAt = t;
      S.combat = t;
      S.hostileTint = 1;
      S.cleared = false;
    },

    showPickup(text) {
      if (!text) return;
      S.t = hudNow();
      S.lines.push({ text: String(text).toUpperCase(), t0: S.t, a: 0 });
      while (S.lines.length > 3) S.lines.shift();
      S.cleared = false;
    },

    /**
     * direction: THREE.Vector3-ish pointing FROM the player TOWARD the source,
     * a number (world bearing in radians), or null for an omnidirectional hit.
     */
    flashDamage(direction, amount = 0.18) {
      // `player` fires the bus event and then calls this with the same direction
      // reference in the same frame; that second call is the duplicate, drop it.
      if (S.dmgFrame === (ctxRef?.clock?.frame ?? -1) && S.dmgDir === direction) return;
      applyDamageFx(direction, amount);
    },

    dispose() {
      for (const f of unsub) { try { f(); } catch { /* noop */ } }
      unsub = [];
      if (cv && cv.parentNode) cv.parentNode.removeChild(cv);
      cv = null; g = null; chromeTracker = null; barFx = null; barG = null; vignGrad = null;
      S.ready = false;
    },
  };

  return mod;
}
