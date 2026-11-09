// Renders build/icon.svg to build/icon.png (1024px) with headless Chromium.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const svg = fs.readFileSync('build/icon.svg', 'utf8');
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/chromium', headless: 'new' });
const p = await b.newPage(); await p.setViewport({ width: 1024, height: 1024 });
await p.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await p.screenshot({ path: 'build/icon.png', omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await b.close(); console.log('build/icon.png');
