// Downloads the CDN libraries the studio lazy-loads into vendor/<host>/<path>,
// so the packaged app works offline from the first start.
import fs from 'node:fs';
import path from 'node:path';

const J = 'https://cdn.jsdelivr.net/npm/';
const FILES = [
  J + 'three@0.128.0/build/three.min.js',
  J + 'three@0.128.0/examples/js/loaders/SVGLoader.js',
  ...['helvetiker_bold', 'helvetiker_regular', 'optimer_bold', 'optimer_regular', 'gentilis_bold', 'gentilis_regular', 'droid/droid_sans_bold', 'droid/droid_sans_regular', 'droid/droid_serif_bold', 'droid/droid_serif_regular']
    .map(f => J + `three@0.128.0/examples/fonts/${f}.typeface.json`),
  J + 'opentype.js@1.3.4/dist/opentype.min.js',
  J + 'lamejs@1.2.1/lame.min.js',
  J + 'mp4box@0.5.3/dist/mp4box.all.min.js',
  J + 'heic2any@0.0.4/dist/heic2any.min.js',
  J + 'utif@3.1.0/UTIF.js',
  J + 'pako@2.1.0/dist/pako_inflate.min.js',
  J + 'paper@0.12.18/dist/paper-core.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
];
const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'vendor');
let ok = 0;
for (const url of FILES) {
  const u = new URL(url), out = path.join(root, u.hostname, decodeURIComponent(u.pathname));
  if (fs.existsSync(out)) { ok++; continue; }
  const r = await fetch(url);
  if (!r.ok) { console.warn('skip', r.status, url); continue; }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  ok++;
}
console.log(`vendor: ${ok}/${FILES.length} files in ${root}`);
