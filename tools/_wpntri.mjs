/**
 * weapons-agent scratch tool: geometry diagnostics WITHOUT the GPU.
 *
 * `passes/scene.js` renders the viewmodel with `pipe.viewCamera`, whose world matrix
 * is copied from the main camera. root.matrixWorld = cam.matrixWorld * M_mount, and
 * the view matrix is cam.matrixWorld^-1, so a vertex's VIEW-space position is exactly
 * M_mount * v — independent of where the player is standing. That means the whole
 * viewmodel screen layout can be computed in bare node, which is how the mount pose
 * and the surviving sliver were solved without burning a 2-minute capture per guess.
 *
 *   node tools/_wpntri.mjs slivers     # triangles that draw as a hairline on screen
 *   node tools/_wpntri.mjs screen      # per-scanline silhouette coverage, projected
 */
import * as THREE from 'three';
import { Rand } from '../src/core/Rand.js';
import { __dbg, __mount } from '../src/game/weapons.js';

const mode = process.argv[2] || 'screen';
const W = 1920, H = 1080, FOV = 55, ASPECT = 16 / 9;

const rand = new Rand(12345);
const { G, parts } = __dbg.buildRifle(rand);
__dbg.buildHands(G, parts);
const all = { ...G, ...parts };

const M = new THREE.Matrix4();
{
  const e = new THREE.Euler(__mount.rot.pitch, __mount.rot.yaw, __mount.rot.roll, 'YXZ');
  const q = new THREE.Quaternion().setFromEuler(e);
  const p = __mount.pos.clone();
  p.add(__mount.pivot.clone().applyQuaternion(q).sub(__mount.pivot));
  M.compose(p, q, new THREE.Vector3(1, 1, 1));
}
const TAN = Math.tan(FOV * Math.PI / 360);

function toScreen(v) {
  const p = v.clone().applyMatrix4(M);
  const z = -p.z;
  if (z < 1e-4) return null;
  return [(p.x / (z * TAN * ASPECT) * 0.5 + 0.5) * W, (0.5 - p.y / (z * TAN) * 0.5) * H, z];
}

if (mode === 'slivers') {
  for (const [k, list] of Object.entries(all)) {
    if (!list.length) continue;
    const worst = [];
    for (const geo of list) {
      const pos = geo.getAttribute('position');
      for (let t = 0; t < pos.count / 3; t++) {
        const i = t * 3;
        const s = [0, 1, 2].map((j) => toScreen(new THREE.Vector3().fromBufferAttribute(pos, i + j)));
        if (s.some((x) => !x)) continue;
        const area = Math.abs((s[1][0] - s[0][0]) * (s[2][1] - s[0][1])
          - (s[2][0] - s[0][0]) * (s[1][1] - s[0][1])) * 0.5;
        const L = Math.max(Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]),
          Math.hypot(s[2][0] - s[0][0], s[2][1] - s[0][1]),
          Math.hypot(s[2][0] - s[1][0], s[2][1] - s[1][1]));
        if (L < 40) continue;                    // only long things can draw a hairline
        const width = 2 * area / L;
        if (width > (+process.argv[3] || 1.6)) continue;
        if (process.argv[4]) {
          const [bx0, by0, bx1, by1] = process.argv[4].split(',').map(Number);
          const cx = (s[0][0] + s[1][0] + s[2][0]) / 3, cy = (s[0][1] + s[1][1] + s[2][1]) / 3;
          if (cx < bx0 || cx > bx1 || cy < by0 || cy > by1) continue;
        }
        worst.push({ L, width, s, o: [0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(pos, i + j).toArray().map((v) => +v.toFixed(4))) });
      }
    }
    if (!worst.length) continue;
    worst.sort((x, y) => y.L - x.L);
    console.log('==', k, 'hairline tris:', worst.length);
    for (const w of worst.slice(0, 6)) {
      console.log(`   len ${w.L.toFixed(0)}px width ${w.width.toFixed(2)}px  `
        + w.s.map((p) => `(${p[0].toFixed(0)},${p[1].toFixed(0)})`).join(' ') + '  obj ' + JSON.stringify(w.o));
    }
  }
} else {
  const cov = new Uint8Array(W * H);
  const GROUP = { body: 1, rail: 1, poly: 1, plate: 2, glove: 3, screen: 1, engrave: 1, led: 1,
    mag: 1, bolt: 1, boltPoly: 1, handL: 3, armR: 3 };
  for (const [gname, list] of Object.entries(all)) {
    const tag = GROUP[gname] ?? 1;
    for (const geo of list) {
      const pos = geo.getAttribute('position');
      for (let t = 0; t < pos.count / 3; t++) {
        const i = t * 3;
        const s = [0, 1, 2].map((j) => toScreen(new THREE.Vector3().fromBufferAttribute(pos, i + j)));
        if (s.some((x) => !x)) continue;
        const x0 = Math.max(0, Math.floor(Math.min(s[0][0], s[1][0], s[2][0])));
        const x1 = Math.min(W - 1, Math.ceil(Math.max(s[0][0], s[1][0], s[2][0])));
        const y0 = Math.max(0, Math.floor(Math.min(s[0][1], s[1][1], s[2][1])));
        const y1 = Math.min(H - 1, Math.ceil(Math.max(s[0][1], s[1][1], s[2][1])));
        const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        const A = d(s[0], s[1], s[2]);
        if (Math.abs(A) < 1e-9) continue;
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const p = [x + 0.5, y + 0.5];
            const w0 = d(s[1], s[2], p) / A, w1 = d(s[2], s[0], p) / A, w2 = d(s[0], s[1], p) / A;
            if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) cov[y * W + x] = tag;
          }
        }
      }
    }
  }
  // per-group screen bbox, so the hand / arm placement can be read off directly
  for (const [gname, list] of Object.entries(all)) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, m = 0;
    for (const geo of list) {
      const pos = geo.getAttribute('position');
      for (let v = 0; v < pos.count; v++) {
        const s = toScreen(new THREE.Vector3().fromBufferAttribute(pos, v));
        if (!s) continue;
        m++;
        if (s[0] < x0) x0 = s[0]; if (s[0] > x1) x1 = s[0];
        if (s[1] < y0) y0 = s[1]; if (s[1] > y1) y1 = s[1];
      }
    }
    if (m) console.log(`   ${gname.padEnd(9)} x[${x0.toFixed(0)},${x1.toFixed(0)}] y[${y0.toFixed(0)},${y1.toFixed(0)}]`);
  }
  let n = 0;
  for (let i = 0; i < cov.length; i++) if (cov[i]) n++;
  const rows = [];
  for (const y of [1079, 1040, 1000, 950, 900, 850, 800, 750]) {
    let c = 0;
    for (let x = 998; x < W; x++) if (cov[y * W + x]) c++;
    rows.push(`y${y}:${c}`);
  }
  let xmin = W, xmax = 0, ymin = H, ymax = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (cov[y * W + x]) {
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  for (const y of [1079, 1040, 1000, 950, 900]) {
    const sp = []; let run = -1;
    for (let x = 998; x <= W; x++) {
      const on = x < W && cov[y * W + x];
      if (on && run < 0) run = x;
      if (!on && run >= 0) { sp.push(`${run}-${x - 1}`); run = -1; }
    }
    console.log(`   y${y} spans`, sp.join(' '));
  }
  console.log('projected silhouette px', n, ' cover/922', rows.join(' '));
  console.log(`bbox x[${xmin},${xmax}] y[${ymin},${ymax}]`);
  console.log('ref      silhouette px 242005  cover/922 y1079:922 y1040:915 y1000:830 y950:732 y900:640 y850:497 y800:317 y750:223');
  console.log('ref      bbox x[998,1919] y[545,1079]');

  // dump a PPM overlay: ours (grey / cyan = hands+arms, magenta = plates) against the
  // reference silhouette polygon (green outline). Iterate the mount offline, then capture.
  const REF = [[998,1080],[998,890],[1060,850],[1120,842],[1180,790],[1240,752],
    [1276,600],[1300,558],[1400,545],[1458,612],[1450,700],[1472,792],
    [1600,880],[1780,978],[1920,1044],[1920,1080]];
  const inRef = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const xs = [];
    for (let i = 0; i < REF.length; i++) {
      const a = REF[i], b = REF[(i + 1) % REF.length];
      if ((a[1] <= y) !== (b[1] <= y)) xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) if (x >= 0 && x < W) inRef[y * W + x] = 1;
    }
  }
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const c = cov[i], r = inRef[i];
    let col = r ? [40, 90, 40] : [16, 16, 22];
    if (c === 1) col = r ? [210, 210, 210] : [230, 90, 60];
    else if (c === 2) col = r ? [200, 120, 220] : [230, 60, 200];
    else if (c === 3) col = r ? [110, 220, 220] : [60, 200, 230];
    buf[i * 3] = col[0]; buf[i * 3 + 1] = col[1]; buf[i * 3 + 2] = col[2];
  }
  const { writeFileSync } = await import('node:fs');
  // Binary silhouette, for tools/_wpn2.py. Other agents commit terrain/ocean edits
  // between the two frames of a --skip weapons pair, which poisons a differenced mask
  // (n jumps 215k -> 490k). This one is computed from geometry and does not care.
  const mk = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) mk[i] = cov[i] ? 255 : 0;
  writeFileSync('/tmp/vmmask.pgm', Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), mk]));
  writeFileSync('/tmp/vmproj.ppm', Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), buf]));
  console.log('wrote /tmp/vmproj.ppm  (grey/white = inside ref, red = ours outside ref, dark green = ref not covered)');
}

/* ------------------------------------------------------------------ optimise
 * Hill-climb MOUNT_POS / MOUNT_ROT to maximise IoU of the GUN silhouette against a
 * hand-traced reference polygon with the left-glove lobe removed (the hands are
 * placed separately). Runs at quarter resolution; ~1 s for a few hundred evaluations,
 * against ~2 minutes per GPU capture.
 *   node tools/_wpntri.mjs optimise
 */
if (mode === 'optimise') {
  const SW = 480, SH = 270, S = 0.25;
  const REF_GUN = [[1200,1080],[1200,830],[1240,752],[1276,600],[1300,558],[1400,545],
    [1458,612],[1450,700],[1472,792],[1600,880],[1780,978],[1920,1044],[1920,1080]];
  const refMask = new Uint8Array(SW * SH);
  for (let y = 0; y < SH; y++) {
    const yy = (y + 0.5) / S, xs = [];
    for (let i = 0; i < REF_GUN.length; i++) {
      const a = REF_GUN[i], b = REF_GUN[(i + 1) % REF_GUN.length];
      if ((a[1] <= yy) !== (b[1] <= yy)) xs.push(a[0] + (yy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.ceil(xs[k] * S); x <= Math.floor(xs[k + 1] * S); x++) if (x >= 0 && x < SW) refMask[y * SW + x] = 1;
    }
  }
  let refN = 0; for (let i = 0; i < refMask.length; i++) refN += refMask[i];

  const gunGeos = [];
  for (const k of ['body', 'rail', 'poly', 'plate', 'screen', 'engrave', 'led', 'mag', 'boltPoly']) {
    for (const g of (all[k] || [])) gunGeos.push(g.getAttribute('position'));
  }
  const cov = new Uint8Array(SW * SH);
  const M2 = new THREE.Matrix4(), q2 = new THREE.Quaternion(), e2 = new THREE.Euler(0, 0, 0, 'YXZ');
  const v2 = new THREE.Vector3(), p2 = new THREE.Vector3();
  function iou(P) {
    e2.set(P[3], P[4], P[5], 'YXZ'); q2.setFromEuler(e2);
    p2.set(P[0], P[1], P[2]).add(__mount.pivot.clone().applyQuaternion(q2).sub(__mount.pivot));
    M2.compose(p2, q2, new THREE.Vector3(1, 1, 1));
    cov.fill(0);
    for (const pos of gunGeos) {
      for (let t = 0; t < pos.count / 3; t++) {
        const i = t * 3; const s = [];
        let ok = true;
        for (let j = 0; j < 3; j++) {
          v2.fromBufferAttribute(pos, i + j).applyMatrix4(M2);
          const z = -v2.z; if (z < 1e-4) { ok = false; break; }
          s.push([((v2.x / (z * TAN * ASPECT) * 0.5 + 0.5) * W) * S, ((0.5 - v2.y / (z * TAN) * 0.5) * H) * S]);
        }
        if (!ok) continue;
        const x0 = Math.max(0, Math.floor(Math.min(s[0][0], s[1][0], s[2][0])));
        const x1 = Math.min(SW - 1, Math.ceil(Math.max(s[0][0], s[1][0], s[2][0])));
        const y0 = Math.max(0, Math.floor(Math.min(s[0][1], s[1][1], s[2][1])));
        const y1 = Math.min(SH - 1, Math.ceil(Math.max(s[0][1], s[1][1], s[2][1])));
        const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        const A = d(s[0], s[1], s[2]); if (Math.abs(A) < 1e-9) continue;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const p = [x + 0.5, y + 0.5];
          const w0 = d(s[1], s[2], p) / A, w1 = d(s[2], s[0], p) / A, w2 = d(s[0], s[1], p) / A;
          if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) cov[y * SW + x] = 1;
        }
      }
    }
    let inter = 0, uni = 0;
    for (let i = 0; i < cov.length; i++) { const a = cov[i], b = refMask[i]; if (a && b) inter++; if (a || b) uni++; }
    return inter / Math.max(uni, 1);
  }

  /* Leash on mount z. research 1.1: a weapon is held ~0.35-0.45 m from the eye.
   * Left free, the optimiser buys silhouette area by dragging the gun toward the
   * near plane (it went to -0.238 m), which is not a pose, it is a zoom — and it
   * throws the right hand and forearm off the bottom of the frame because anything
   * at positive local z ends up 15 cm from the eye. */
  const cost = (P) => iou(P) - 3.0 * Math.max(0, Math.abs(P[2] + 0.375) - 0.030);
  let best = [__mount.pos.x, __mount.pos.y, __mount.pos.z,
    __mount.rot.pitch, __mount.rot.yaw, __mount.rot.roll];
  let bestV = cost(best);
  console.log('start IoU', bestV.toFixed(4), best.map((v) => v.toFixed(4)).join(' '));
  // rotation is deliberately on a short rein: the free 6-DOF fit found a pose with
  // a higher silhouette IoU that showed the BACK of the carry handle with the ammo
  // counter edge-on. Silhouette overlap is not the read. +/- 2 deg only.
  let step = [0.020, 0.020, 0.020, 0.010, 0.010, 0.010];
  for (let pass = 0; pass < 60; pass++) {
    let improved = false;
    for (let k = 0; k < 6; k++) {
      for (const sgn of [1, -1]) {
        const c = best.slice(); c[k] += sgn * step[k];
        const v = cost(c);
        if (v > bestV) { bestV = v; best = c; improved = true; }
      }
    }
    if (!improved) { for (let k = 0; k < 6; k++) step[k] *= 0.55; if (step[0] < 1e-4) break; }
  }
  console.log('best  IoU', iou(best).toFixed(4), '(cost', bestV.toFixed(4), ')');
  console.log('MOUNT_POS', best.slice(0, 3).map((v) => v.toFixed(4)).join(', '));
  console.log('MOUNT_ROT pitch', best[3].toFixed(4), 'yaw', best[4].toFixed(4), 'roll', best[5].toFixed(4));
}

/* -------------------------------------------------------------------- hands
 * Same hill-climb, on the left-glove and right-forearm mounts, against the two
 * silhouette lobes they are supposed to fill in kf_00000. The left arm must enter
 * from BOTTOM-left going up-right (a left arm anatomically cannot enter horizontally
 * at mid-receiver height, which is what it was doing); the right glove seals the
 * bottom-right corner.
 *   node tools/_wpntri.mjs hands
 */
if (mode === 'hands') {
  const SW = 480, SH = 270, S = 0.25;
  const LOBES = {
    handL: [[998,1080],[992,886],[1060,846],[1124,838],[1186,788],[1248,752],[1302,872],[1286,1010],[1196,1080]],
    armR: [[1640,1080],[1700,1010],[1800,984],[1920,1040],[1920,1080]],
  };
  const rast = (poly) => {
    const m = new Uint8Array(SW * SH);
    for (let y = 0; y < SH; y++) {
      const yy = (y + 0.5) / S, xs = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if ((a[1] <= yy) !== (b[1] <= yy)) xs.push(a[0] + (yy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.ceil(xs[k] * S); x <= Math.floor(xs[k + 1] * S); x++) if (x >= 0 && x < SW) m[y * SW + x] = 1;
      }
    }
    return m;
  };
  const cov = new Uint8Array(SW * SH);
  const v2 = new THREE.Vector3();
  const rasterise = (geos) => {
    cov.fill(0);
    for (const geo of geos) {
      const pos = geo.getAttribute('position');
      for (let t = 0; t < pos.count / 3; t++) {
        const i = t * 3; const s = []; let ok = true;
        for (let j = 0; j < 3; j++) {
          v2.fromBufferAttribute(pos, i + j).applyMatrix4(M);
          const z = -v2.z; if (z < 1e-4) { ok = false; break; }
          s.push([((v2.x / (z * TAN * ASPECT) * 0.5 + 0.5) * W) * S, ((0.5 - v2.y / (z * TAN) * 0.5) * H) * S]);
        }
        if (!ok) continue;
        const x0 = Math.max(0, Math.floor(Math.min(s[0][0], s[1][0], s[2][0])));
        const x1 = Math.min(SW - 1, Math.ceil(Math.max(s[0][0], s[1][0], s[2][0])));
        const y0 = Math.max(0, Math.floor(Math.min(s[0][1], s[1][1], s[2][1])));
        const y1 = Math.min(SH - 1, Math.ceil(Math.max(s[0][1], s[1][1], s[2][1])));
        const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        const A = d(s[0], s[1], s[2]); if (Math.abs(A) < 1e-9) continue;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const p = [x + 0.5, y + 0.5];
          const w0 = d(s[1], s[2], p) / A, w1 = d(s[2], s[0], p) / A, w2 = d(s[0], s[1], p) / A;
          if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) cov[y * SW + x] = 1;
        }
      }
    }
  };
  for (const which of ['handL', 'armR']) {
    const target = rast(LOBES[which]);
    let tcx = 0, tcy = 0, tn = 0;
    for (let i = 0; i < target.length; i++) if (target[i]) { tcx += i % SW; tcy += (i / SW) | 0; tn++; }
    tcx /= tn; tcy /= tn;
    const base = which === 'handL' ? __mount.handL : __mount.armR;
    const score = (P) => {
      const Gh = { body: [], rail: [], poly: [], glove: [], plate: [], screen: [], engrave: [], led: [] };
      const ph = { mag: [], bolt: [], boltPoly: [], handL: [], armR: [] };
      const ov = { p: P.slice(0, 3), r: P.slice(3, 6) };
      __dbg.buildHands(Gh, ph, which === 'handL' ? { handL: ov, armR: { p: [9, 9, 9], r: [0, 0, 0] } }
        : { armR: ov, handL: { p: [9, 9, 9], r: [0, 0, 0] } });
      rasterise(ph[which]);
      let inter = 0, uni = 0, sx = 0, sy = 0, sn = 0;
      for (let i = 0; i < cov.length; i++) {
        const a = cov[i], b = target[i];
        if (a && b) inter++; if (a || b) uni++;
        if (a) { sx += i % SW; sy += (i / SW) | 0; sn++; }
      }
      // centroid pull, so a group that starts entirely OFF SCREEN still has a gradient
      // to climb. Pure IoU is exactly zero everywhere out there and the hill-climb
      // cannot start — which is why the right forearm sat at screen y 2164-6600 for a
      // whole wave without anyone noticing it was never in frame at all.
      const d = sn ? Math.hypot(sx / sn - tcx, sy / sn - tcy) : 400;
      return inter / Math.max(uni, 1) - 0.0025 * d;
    };
    // anatomical anchors: the left glove must stay wrapped on the fore-end, the right
    // glove on the pistol grip. Silhouette IoU alone will happily park a hand on top
    // of the receiver, so penalise straying from the part it is supposed to hold.
    const ANCHOR = which === 'handL' ? [0.000, -0.095, -0.262] : [0.085, -0.020, 0.100];
    const LEASH = which === 'handL' ? 0.075 : 0.16;
    const cost = (P) => score(P) - 4.0 * Math.max(0,
      Math.hypot(P[0] - ANCHOR[0], P[1] - ANCHOR[1], P[2] - ANCHOR[2]) - LEASH);
    let best = which === 'handL' ? [...base.p, ...base.r]
      : [0.085, -0.020, 0.100, -0.35, -0.45, 0.21];
    let bestV = cost(best);
    const step = [0.030, 0.030, 0.030, 0.18, 0.18, 0.18];
    for (let pass = 0; pass < 40; pass++) {
      let improved = false;
      for (let k = 0; k < 6; k++) for (const sgn of [1, -1]) {
        const c = best.slice(); c[k] += sgn * step[k];
        const v = cost(c);
        if (v > bestV) { bestV = v; best = c; improved = true; }
      }
      if (!improved) { for (let k = 0; k < 6; k++) step[k] *= 0.55; if (step[0] < 2e-4) break; }
    }
    console.log(which, 'IoU', bestV.toFixed(4),
      'p:', best.slice(0, 3).map((v) => v.toFixed(4)).join(', '),
      'r:', best.slice(3, 6).map((v) => v.toFixed(4)).join(', '));
  }
}
