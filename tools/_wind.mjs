import * as THREE from 'three';
import { Rand } from '../src/core/Rand.js';
import { __dbg } from '../src/game/weapons.js';
const rand = new Rand(12345);
const { G, parts } = __dbg.buildRifle(rand);
__dbg.buildHands(G, parts);
for (const [k, list] of Object.entries({ ...G, ...parts })) {
  let bad = 0, tot = 0, area = 0, badArea = 0;
  for (const geo of list) {
    const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal');
    for (let t = 0; t < pos.count / 3; t++) {
      const i = t * 3;
      const a = new THREE.Vector3().fromBufferAttribute(pos, i);
      const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1);
      const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2);
      const gn = b.clone().sub(a).cross(c.clone().sub(a));
      const ar = gn.length() * 0.5;
      if (ar < 1e-12) continue;
      const sn = new THREE.Vector3();
      for (let j = 0; j < 3; j++) sn.add(new THREE.Vector3().fromBufferAttribute(nrm, i + j));
      tot++; area += ar;
      if (gn.dot(sn) < 0) { bad++; badArea += ar; }
    }
  }
  if (tot) console.log(k.padEnd(10), 'tris', tot, 'inverted', bad, `(${(100*bad/tot).toFixed(1)}%)`, 'area frac', (badArea/area).toFixed(3));
}
