// Headless probe for the studio page: console errors, screenshots, leftover German text.
//   node tools/probe.mjs <html> <outdir> [--panels] [--german] [--w=1600 --h=950] [--eval=js]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const [file, outDir, ...flags] = process.argv.slice(2);
const opt = Object.fromEntries(flags.map(f => { const s = f.replace(/^--/, ''), i = s.indexOf('='); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)]; }));
const W = +(opt.w || 1600), H = +(opt.h || 950);
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
await page.goto('file://' + path.resolve(file), { waitUntil: 'load' });
await new Promise(r => setTimeout(r, 2500));
if (opt.eval) { await page.evaluate(opt.eval); await new Promise(r => setTimeout(r, 800)); }
await page.screenshot({ path: path.join(outDir, 'home.png') });

const germanScan = () => page.evaluate(() => {
  const re = /[äöüÄÖÜß„]|\b(und|der|die|das|nicht|wird|mit|für|ist|ein|eine|oder|von|auf|wählen|hinzufügen|Ebene|Bild|Farbe|Schrift|Leinwand|Vorlage|Seite|Spur|Hintergrund|Größe|Breite|Höhe|Deckkraft|Dauer|Muster|Zeichnen|Musik|Marke|Einstellungen|Hilfe|Abbrechen|Schließen|Neu|Speichern|Löschen|Links|Rechts|Oben|Unten|Mitte|Weich|Stärke|Abstand|Drehung|Tempo|Zufall|Bewegung)\b/;
  const out = new Set();
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) { const t = n.nodeValue.trim(); if (t && re.test(t) && n.parentElement && vis(n.parentElement) && !n.parentElement.closest('script,style,textarea')) out.add(t.slice(0, 200)); }
  document.querySelectorAll('[title],[placeholder],[aria-label],[data-tt],[data-tip]').forEach(el => { for (const a of ['title', 'placeholder', 'aria-label', 'data-tt', 'data-tip']) { const v = el.getAttribute(a); if (v && re.test(v)) out.add('@' + a + ': ' + v.slice(0, 200)); } });
  return [...out];
});

const german = new Set();
const add = arr => arr.forEach(x => german.add(x));
if (opt.german) add(await germanScan());

if (opt.panels) {
  const panels = await page.$$eval('[data-panel]', els => [...new Set(els.map(e => e.dataset.panel))]);
  for (const p of panels) {
    try {
      await page.evaluate(p => { const b = document.querySelector(`.tool[data-panel="${p}"], [data-panel="${p}"]`); b && b.click(); }, p);
      await new Promise(r => setTimeout(r, 450));
      await page.screenshot({ path: path.join(outDir, `panel-${p}.png`) });
      if (opt.german) add(await germanScan());
    } catch (e) { errors.push('panel ' + p + ': ' + e.message); }
  }
  // video mode
  await page.evaluate(() => { const v = [...document.querySelectorAll('button,[data-mode]')].find(b => /^(Video)$/.test(b.textContent.trim())); v && v.click(); });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, 'video.png') });
  if (opt.german) add(await germanScan());
}
fs.writeFileSync(path.join(outDir, 'german.txt'), [...german].join('\n'));
fs.writeFileSync(path.join(outDir, 'errors.txt'), errors.join('\n'));
console.log('errors:', errors.length, 'german:', german.size);
await browser.close();
