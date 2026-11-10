// Automated check of the Claud.io 1.1 engine features in headless Chromium.
//   node tools/feature-test.mjs [app/index.html] [--builtin]
// Uses a synthetic stereo test track (kick, hi-hat panned right, bass panned left).
import puppeteer from 'puppeteer-core';
import path from 'node:path';

const file = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'app/index.html';
const builtin = process.argv.includes('--builtin');
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,950'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 950 });
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
await page.goto('file://' + path.resolve(file), { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 2500));

const results = await page.evaluate(async () => {
  const S = window.__studio.dev, out = [], sleep = ms => new Promise(r => setTimeout(r, ms));
  const check = async (name, fn) => { try { const r = await fn(); out.push([name, !!r[0], r[1] || '']); } catch (e) { out.push([name, false, 'threw: ' + (e && e.message)]); } };
  // synthetic stereo WAV
  const sr = 48000, dur = 8, n = sr * dur, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr, kb = t % 0.5, hb = t % 0.25;
    const kick = kb < 0.18 ? Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-kb * 30)) * kb) * Math.exp(-kb * 14) : 0;
    const hat = hb < 0.04 ? (Math.random() * 2 - 1) * Math.exp(-hb * 120) * 0.35 : 0, bass = Math.sin(2 * Math.PI * 82 * t) * 0.18 * (t % 2 < 1 ? 1 : 0.4);
    L[i] = kick * 0.8 + bass + hat * 0.2; R[i] = kick * 0.8 + bass * 0.2 + hat; }
  const buf = new ArrayBuffer(44 + n * 4), dv = new DataView(buf), ws = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  ws(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); ws(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); ws(36, 'data'); dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) { dv.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); dv.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
  S.openMediaStudio(); await sleep(900);
  await S.msImportFiles([new File([buf], 'test.wav', { type: 'audio/wav' })]);
  const a = S.MS.assets.find(x => x.kind === 'audio'); S.msAddClip(a, null, 0); await S.msAnalyze(a); a.buffer = a.buffer || null;
  for (let i = 0; i < 40 && !a.buffer; i++) await sleep(100);

  await check('Audio: new sources (sub, lowmid, presence, transients, width, energy)', () => { const f = S.msFxAt(2.02); const ks = ['sub', 'lowmid', 'pres', 'flux', 'width', 'energy', 'kick', 'hat'];
    return [f && ks.every(k => typeof f[k] === 'number' && isFinite(f[k])), f ? ks.map(k => k + '=' + f[k].toFixed(2)).join(' ') : 'no fx']; });
  await check('Audio: stereo width detects a wide mix', () => { let m = 0; for (let t = 1; t < 7; t += 0.05) m = Math.max(m, S.msFxAt(t).width); return [m > 0.1, 'max width ' + m.toFixed(2)]; });
  await check('Audio: new sources in the modulation list', () => [['sub', 'width', 'flux', 'energy'].every(k => S.MOD_SRC.some(x => x[0] === k)), S.MOD_SRC.length + ' sources']);

  // Modulation: attack/release envelope is deterministic and smooths the signal
  await check('Modulation: envelope deterministic (same t → same value)', () => { const c = { type: 'color', start: 0, in: 0, out: 8, scale: 1, mods: [{ src: 'kick', dst: 'scale', amt: 0.6, att: 0.02, rel: 0.4, curve: 'exp', thr: 0.05 }] };
    const v1 = S.msAnimated(c, 3.11).scale, v2 = S.msAnimated(c, 3.11).scale, v3 = S.msAnimated(c, 3.0).scale, v4 = S.msAnimated(c, 3.4).scale; return [v1 === v2 && v3 !== v4, `t3.11 ${v1.toFixed(4)}/${v2.toFixed(4)}, t3.0 ${v3.toFixed(3)}, t3.4 ${v4.toFixed(3)}`]; });
  await check('Modulation: release keeps the value up between kicks', () => { const raw = { type: 'color', start: 0, in: 0, out: 8, mods: [{ src: 'kick', dst: 'scale', amt: 1 }] }, env = { ...raw, mods: [{ src: 'kick', dst: 'scale', amt: 1, rel: 0.6 }] };
    const t = 3.4, a0 = S.msAnimated(raw, t).scale, a1 = S.msAnimated(env, t).scale; return [a1 > a0, `raw ${a0.toFixed(3)} vs release ${a1.toFixed(3)} at ${t}s`]; });
  await check('Modulation: invert, offset, range, step curve', () => { const base = { type: 'color', start: 0, in: 0, out: 8 }, at = (m, t) => S.msAnimated({ ...base, mods: [m] }, t).scale;
    const inv = at({ src: 'kick', dst: 'scale', amt: 1, inv: true }, 3.0), norm = at({ src: 'kick', dst: 'scale', amt: 1 }, 3.0), ofs = at({ src: 'kick', dst: 'scale', amt: 0, ofs: 0.5 }, 3.0), st = at({ src: 'energy', dst: 'scale', amt: 1, curve: 'step', min: 0.2, max: 0.2 }, 3.0);
    return [inv < norm && Math.abs(ofs - 1.3) < 1e-6 && Math.abs(st - 1.12) < 1e-6, `inv ${inv.toFixed(3)} < ${norm.toFixed(3)}, offset ${ofs.toFixed(3)}, range ${st.toFixed(3)}`]; });

  // Keyframes
  await check('Keyframes: loop, ping-pong, reverse, offset, easing', () => { const c = { start: 0, in: 0, out: 10, kf: { x: [[0, 0], [1, 1]] }, kfEase: 'linear' };
    const lp = S.kfValue({ ...c, kfLoop: 'loop' }, 'x', 1.25), pp = S.kfValue({ ...c, kfLoop: 'ping' }, 'x', 1.25), rv = S.kfValue({ ...c, kfRev: true }, 'x', 9.5), of = S.kfValue({ ...c, kfOff: 0.5 }, 'x', 0.75);
    const el = S.kfValue({ ...c, kfEase: 'back' }, 'x', 0.7), bz = S.kfValue({ ...c, kfEase: 'bezier', kfBez: [0, 0, 1, 1] }, 'x', 0.3), per = S.kfValue({ start: 0, in: 0, out: 10, kf: { x: [[0, 0, 'hold'], [1, 1]] } }, 'x', 0.9);
    return [Math.abs(lp - 0.25) < 1e-6 && Math.abs(pp - 0.75) < 1e-6 && Math.abs(rv - 0.5) < 1e-6 && Math.abs(of - 0.25) < 1e-6 && el > 0.7 && Math.abs(bz - 0.3) < 0.02 && per === 0,
      `loop ${lp} ping ${pp} rev ${rv} off ${of} back ${el.toFixed(3)} bez ${bz.toFixed(3)} hold ${per}`]; });

  // Visualizers draw something, for every style, deterministically
  const draw = (style, t) => { const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360; const x = cv.getContext('2d'); x.translate(320, 180);
    S.msDrawVisualizer(x, { type: 'visualizer', style, color: '#ffffff', color2: '#ff2e88', bars: 64, sens: 1, glow: false, range: 'full', thick: 1, scale: 1 }, t);
    const d = x.getImageData(0, 0, 640, 360).data; let lit = 0, h = 0; for (let i = 3; i < d.length; i += 4) { if (d[i] > 10) lit++; h = (h * 31 + d[i]) >>> 0; } return [lit, h]; };
  const newViz = ['spiral', 'interfere', 'topo', 'fractaltree', 'kinetic', 'terrain3d', 'lissajous', 'orbitals', 'tunnel3d', 'sphere3d'];
  for (const st of newViz) await check('Visualizer: ' + st, () => { const [lit, h1] = draw(st, 2.3), [, h2] = draw(st, 2.3), [, h3] = draw(st, 4.1); return [lit > 200 && h1 === h2 && h1 !== h3, `${lit} px lit, repeatable ${h1 === h2}, moves ${h1 !== h3}`]; });
  await check('Visualizer: all old styles still draw', () => { const bad = S.VIZ_STYLES.map(s => s[0]).filter(s => !newViz.includes(s)).filter(s => { try { return draw(s, 2.3)[0] < 20; } catch (e) { return true; } }); return [!bad.length, bad.length ? 'empty: ' + bad.join(',') : S.VIZ_STYLES.length + ' styles']; });

  // Shaders compile (old ones too, now with the shared post stage)
  await check('Shaders: all generators compile', () => { const bad = Object.keys(S.GEN_SHADERS).filter(k => !S.genProg(k)); return [!bad.length, bad.length ? 'failed: ' + bad.join(',') : Object.keys(S.GEN_SHADERS).length + ' shaders']; });

  // Effects change the image
  for (const ty of ['chroma', 'dirblur', 'godrays', 'displace']) await check('Effect: ' + ty, () => { const L = document.createElement('canvas'); L.width = 320; L.height = 180; const x = L.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, 320, 180); x.fillStyle = '#fff'; x.fillRect(120, 50, 80, 80); x.fillStyle = '#f0a'; x.fillRect(20, 20, 30, 140);
    const before = x.getImageData(0, 0, 320, 180).data.slice(); S.msApplyVfx(L, { vfx: [{ type: ty, amt: 0.8 }] }, 2.2); const after = x.getImageData(0, 0, 320, 180).data; let d = 0; for (let i = 0; i < after.length; i++) d += Math.abs(after[i] - before[i]); return [d > 1000, 'pixel diff ' + d]; });

  // 3D: several orbit systems, new paths, single companions, camera move
  await check('3D: three independent orbit systems build and move', async () => {
    await S.d3Open('sphere'); await sleep(1500); const D3 = S.D3;
    D3.p.orb = { ...D3.p.orb, on: true, obj: 'sphere', count: 3, mode: 'ring', speed: 40 };
    D3.p.orbs = [{ ...D3.p.orb, obj: 'star', count: 6, mode: 'lissa', pathK: 3, pathAmt: 0.8, r: 2, speed: -30 }, { ...D3.p.orb, obj: 'cube', count: 5, mode: 'helix', pathAmt: 0.7, r: 1.6, auSrc: 'kick', auAmt: 0.8, inst: { 1: { s: 2, r: 1.4 }, 2: { hide: true } } }];
    D3.p.camMove = 'circle'; D3.p.camMoveAmt = 0.6;
    await S.d3Rebuild(); for (let i = 0; i < 30 && (!D3.st.ready || (D3.st.orbs || []).length < 3); i++) await sleep(200);
    const st = D3.st, pos = t => { S.d3Apply(st, D3.p, t, { kick: 0.5, bass: 0.3 }, t, { aspect: 1 }); return st.orbs.map(o => { const e = o.sat.instanceMatrix.array; return [e[12], e[13], e[14], e[16 + 12], e[2 * 16], e[16]]; }); };
    const a = JSON.stringify(pos(1.3)), b = JSON.stringify(pos(1.3)), c = JSON.stringify(pos(2.7)), hid = pos(1.3)[2][4];
    const camA = (S.d3Apply(st, D3.p, 1, null, 1, { aspect: 1 }), st.cam.position.x), camB = (S.d3Apply(st, D3.p, 3, null, 3, { aspect: 1 }), st.cam.position.x);
    return [st.orbs.length === 3 && a === b && a !== c && Math.abs(hid) < 1e-9 && Math.abs(camA - camB) > 0.01, `${st.orbs.length} orbits, deterministic ${a === b}, moving ${a !== c}, hidden companion scale ${hid}, camera moves ${Math.abs(camA - camB).toFixed(3)}`]; });
  await check('3D: old projects without "orbs" still load', () => { const p = S.d3Fill({ obj: 'text', orb: { on: true, count: 4 } }); return [Array.isArray(p.orbs) && p.orbs.length === 0 && p.orb.mode === 'ring' && p.orb.pathK === 2, 'orbs=' + JSON.stringify(p.orbs)]; });

  // UI: workspaces, palette search
  await check('Workspace: minimal hides the left panel, design restores it', () => { S.wsSwitch('minimal', { keepMode: true, silent: true }); const h1 = document.documentElement.dataset.wsHide, lp = getComputedStyle(document.documentElement).getPropertyValue('--ws-lp');
    S.wsSwitch('design', { keepMode: true, silent: true }); const h2 = document.documentElement.dataset.wsHide; return [h1.includes('lp') && lp.trim() === '0px' && !h2.includes('lp') && document.querySelectorAll('.ws-grip').length >= 3, `minimal hide="${h1}" lp=${lp.trim()}, design hide="${h2}", grips ${document.querySelectorAll('.ws-grip').length}`]; });
  await check('Command palette finds visualizers, shaders and presets', () => { const C = window.__studio.CMD_ACTIONS; const hit = q => C.filter(a => (a.label + ' ' + (a.tag || '')).toLowerCase().includes(q)).length; return [hit('spirale') > 0 && hit('gyroid') > 0 && hit('preset') > 10, `spiral ${hit('spirale')}, gyroid ${hit('gyroid')}, presets ${hit('preset')}`]; });
  return out;
});

let fail = 0;
for (const [n, ok, d] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); }

if (builtin) {
  await page.reload({ waitUntil: 'load' }); await new Promise(r => setTimeout(r, 2500));
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true, bubbles: true })));
  await new Promise(r => setTimeout(r, 4000)); await page.evaluate(() => document.getElementById('runFuncTest')?.click());
  let txt = '';
  for (let i = 0; i < 240; i++) { await new Promise(r => setTimeout(r, 1000)); txt = await page.evaluate(() => { const m = document.querySelector('#selfTestModal .modal'); return m ? m.innerText : ''; }); if (/bestanden|passed/.test(txt) && !/Läuft|Running/.test(txt)) break; }
  const sum = (txt.match(/(\d+) (?:von|of) (\d+)/) || []); console.log('\nBuilt-in function test: ' + (sum[0] || 'no result'));
  const bad = await page.evaluate(() => [...document.querySelectorAll('#selfTestModal .modal div[style*="border-bottom"]')].filter(d => d.textContent.includes('❌')).map(d => d.innerText.replace(/\s+/g, ' ').slice(0, 220)));
  bad.forEach(b => console.log('  FAIL ' + b)); if (sum[1] && sum[1] !== sum[2]) fail++;
}
if (errors.length) { console.log('\nPage errors:'); errors.slice(0, 20).forEach(e => console.log('  ' + e)); }
console.log(`\n${results.length - (fail && !builtin ? fail : fail)} checks, ${fail} failed, ${errors.length} page errors`);
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
