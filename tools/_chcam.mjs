#!/usr/bin/env node
/**
 * _chcam — capture at an ARBITRARY camera pose via the shared daemon.
 *
 * `poses.js` is owned by the pose-refit task and must not grow diagnostic entries, but
 * judging character models needs the camera three metres from an actor's face. The
 * daemon's `H.setPose()` already accepts a pose *object*, so this posts one directly.
 *
 *   node tools/_chcam.mjs --pos -30.5,2.0,-8.0 --rot -6,180,0 --fov 40 \
 *                          --out shots/latest/elite.png --settle 24
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const nums = (s) => s.split(',').map(Number);

const port = existsSync('/tmp/halo-captured.port') ? readFileSync('/tmp/halo-captured.port', 'utf8').trim() : null;
if (!port) { console.error('no capture daemon — run `node tools/capture.mjs --pose ref_00000 --out /tmp/warm.png` first'); process.exit(1); }

const pose = { pos: nums(arg('pos', '0,2,0')), rot: nums(arg('rot', '0,0,0')), fov: Number(arg('fov', 60)) };
const body = {
  poses: [pose], w: Number(arg('w', 1920)), h: Number(arg('h', 1080)),
  settle: Number(arg('settle', 32)), time: arg('time', '12.0'), seed: 1337,
  only: arg('only', null), skip: arg('skip', null), video: 0,
  config: arg('config', null),
};
const r = await fetch(`http://127.0.0.1:${port}/capture`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(300000),
});
const out = await r.json();
if (!out.ok) { console.error(JSON.stringify(out).slice(0, 800)); process.exit(1); }
const urls = Object.values(out.shots)[0];
const file = resolve(ROOT, arg('out', 'shots/latest/_chcam.png'));
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, Buffer.from(urls[0].split(',')[1], 'base64'));
console.log(JSON.stringify({ ok: true, file, missing: out.missing || [], warnings: out.warnings || [] }));
