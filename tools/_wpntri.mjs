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
  for (const list of Object.values(all)) {
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
            if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) cov[y * W + x] = 1;
          }
        }
      }
    }
  }
  let n = 0;
  for (let i = 0; i < cov.length; i++) n += cov[i];
  const rows = [];
  for (const y of [1079, 1040, 1000, 950, 900, 850, 800, 750]) {
    let c = 0;
    for (let x = 998; x < W; x++) c += cov[y * W + x];
    rows.push(`y${y}:${c}`);
  }
  let xmin = W, xmax = 0, ymin = H, ymax = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (cov[y * W + x]) {
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  console.log('projected silhouette px', n, ' cover/922', rows.join(' '));
  console.log(`bbox x[${xmin},${xmax}] y[${ymin},${ymax}]`);
  console.log('ref      silhouette px 242005  cover/922 y1079:922 y1040:915 y1000:830 y950:732 y900:640 y850:497 y800:317 y750:223');
  console.log('ref      bbox x[998,1919] y[545,1079]');
}
