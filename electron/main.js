// Claud.io – desktop shell for the single-file studio (app/index.html).
const { app, BrowserWindow, protocol, net, session, ipcMain, shell, dialog, nativeTheme, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { autoUpdater } = require('electron-updater');

const APP_DIR = path.join(__dirname, '..', 'app');
const VENDOR_DIR = app.isPackaged ? path.join(process.resourcesPath, 'vendor') : path.join(__dirname, '..', 'vendor');
const CACHE_DIR = () => path.join(app.getPath('userData'), 'cdn-cache');

// Libraries the studio lazy-loads from public CDNs. They are bundled (vendor/)
// or cached on first use, so the app keeps working offline.
// ffmpeg.wasm and transformers.js stay on the network: they spawn workers and
// download models themselves.
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const CDN_SKIP = /\/npm\/(@ffmpeg|@huggingface|onnxruntime)/;

protocol.registerSchemesAsPrivileged([
  { scheme: 'claudio', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true } },
  { scheme: 'claudio-cdn', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ---------- graphics / hardware acceleration ----------
// The studio renders 3D, shaders and video on the GPU. Chromium already uses it
// by default; these switches also unlock GPUs on Chromium's blocklist, rasterize
// 2D canvases on the GPU, prefer the discrete GPU on laptops and enable hardware
// video encode/decode. If the GPU process keeps crashing, the app offers to fall
// back to software rendering (settings.json → "gpu": false).
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } }
function saveSettings(patch) { const s = { ...loadSettings(), ...patch }; try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch {} return s; }
const SETTINGS = loadSettings();
const GPU_ON = SETTINGS.gpu !== false && !process.argv.includes('--disable-gpu');
if (GPU_ON) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('enable-accelerated-video-decode');
  app.commandLine.appendSwitch('force_high_performance_gpu');
  app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization,PlatformHEVCEncoderSupport,AcceleratedVideoEncoder');
} else {
  app.disableHardwareAcceleration();
}

let win = null, rendererReady = false;
const pendingFiles = [];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const mimeOf = p => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

function serveFile(file, type) {
  return new Response(fs.readFileSync(file), { headers: { 'content-type': type || mimeOf(file), 'access-control-allow-origin': '*', 'cache-control': 'no-cache' } });
}

// ---------- window state ----------
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { width: 1480, height: 900, maximized: true }; } }
function saveState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch {}
}

function titleBarColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#00000000', symbolColor: '#e8eaf0', height: 50 }
    : { color: '#00000000', symbolColor: '#161821', height: 50 };
}

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    x: st.x, y: st.y, width: st.width || 1480, height: st.height || 900, minWidth: 1280, minHeight: 720,
    title: 'Claud.io', backgroundColor: '#0d0e12', show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden', titleBarOverlay: titleBarColors(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false, offscreen: !!process.env.CLAUDIO_SNAPSHOT },
  });
  if (st.maximized) win.maximize();
  if (!process.env.CLAUDIO_SNAPSHOT) win.once('ready-to-show', () => win.show());
  ['resize', 'move', 'close'].forEach(ev => win.on(ev, saveState));
  win.loadURL('claudio://app/index.html');
  win.webContents.on('did-finish-load', () => { const z = +loadSettings().zoom || 1; if (z !== 1) win.webContents.setZoomFactor(z); });

  // Pop-out windows (second-monitor preview, etc.) stay in-app; real web links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url.startsWith('claudio://') || url.startsWith('blob:')) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#0d0e12', icon: path.join(__dirname, '..', 'build', 'icon.png') } };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('claudio://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  // F11 fullscreen, Ctrl+Shift+I developer tools (for bug reports)
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (i.control && i.shift && i.key.toLowerCase() === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  // Test hook: CLAUDIO_SNAPSHOT=<png> renders the window once, saves it and quits.
  if (process.env.CLAUDIO_SNAPSHOT) win.webContents.once('did-finish-load', () => setTimeout(async () => {
    if (process.env.CLAUDIO_SNAPSHOT_JS) { try { await win.webContents.executeJavaScript(process.env.CLAUDIO_SNAPSHOT_JS); } catch (e) { console.error(e); } await new Promise(r => setTimeout(r, 3000)); }
    const img = await win.webContents.capturePage(); fs.writeFileSync(process.env.CLAUDIO_SNAPSHOT, img.toPNG()); app.quit();
  }, 4000));
  if (process.env.CLAUDIO_SNAPSHOT) win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 'warning') console.log('[renderer ' + e.level + ']', e.message); });
  nativeTheme.on('updated', () => { try { win.setTitleBarOverlay(titleBarColors()); } catch {} });
}

// ---------- protocols ----------
function setupProtocols() {
  protocol.handle('claudio', req => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(APP_DIR, rel));
    if (!file.startsWith(APP_DIR) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return serveFile(file);
  });

  const fetchSession = session.fromPartition('claudio-cdn-fetch');
  protocol.handle('claudio-cdn', async req => {
    const u = new URL(req.url);
    const host = u.hostname, rel = decodeURIComponent(u.pathname + (u.search || ''));
    const origUrl = 'https://' + host + u.pathname + (u.search || '');
    const bundled = path.join(VENDOR_DIR, host, decodeURIComponent(u.pathname));
    if (!u.search && fs.existsSync(bundled) && fs.statSync(bundled).isFile()) return serveFile(bundled);
    const key = crypto.createHash('sha1').update(host + rel).digest('hex');
    const cFile = path.join(CACHE_DIR(), key), cMeta = cFile + '.type';
    try {
      const r = await fetchSession.fetch(origUrl, { headers: { 'user-agent': req.headers.get('user-agent') || '' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer()), type = r.headers.get('content-type') || mimeOf(u.pathname);
      fs.mkdirSync(CACHE_DIR(), { recursive: true });
      fs.writeFileSync(cFile, buf); fs.writeFileSync(cMeta, type);
      return new Response(buf, { headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
    } catch (e) {
      if (fs.existsSync(cFile)) return serveFile(cFile, fs.existsSync(cMeta) ? fs.readFileSync(cMeta, 'utf8') : undefined);
      return new Response('Offline and not cached: ' + origUrl, { status: 504 });
    }
  });

  session.defaultSession.webRequest.onBeforeRequest({ urls: CDN_HOSTS.map(h => `https://${h}/*`) }, (d, cb) => {
    if (CDN_SKIP.test(d.url)) return cb({});
    cb({ redirectURL: d.url.replace(/^https:/, 'claudio-cdn:') });
  });

  // Microphone/camera only when the page asks (the studio has optional mic input).
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'window-management', 'local-fonts'].includes(perm)));
}

// ---------- files opened from Explorer ----------
function queueFileArgs(argv) {
  for (const a of argv.slice(1)) if (/\.(studio)$/i.test(a) && fs.existsSync(a)) sendFile(a);
}
function sendFile(file) {
  const payload = { name: path.basename(file), data: fs.readFileSync(file) };
  if (win && rendererReady) win.webContents.send('open-file', payload); else pendingFiles.push(payload);
}

// ---------- updates (GitHub releases) ----------
function setupUpdater() {
  const send = s => { if (win && !win.isDestroyed()) win.webContents.send('update-status', s); };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', i => send({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => send({ state: 'none' }));
  autoUpdater.on('download-progress', p => send({ state: 'downloading', percent: p.percent, version: autoUpdater._claudioVer }));
  autoUpdater.on('update-downloaded', i => send({ state: 'ready', version: i.version }));
  autoUpdater.on('error', e => send({ state: 'error', message: (e && e.message || String(e)).split('\n')[0].slice(0, 160) }));
  autoUpdater.on('update-available', i => { autoUpdater._claudioVer = i.version; });
  ipcMain.on('update-check', () => { if (!app.isPackaged && !process.env.CLAUDIO_DEV_UPDATES) return send({ state: 'error', message: 'updates are disabled in development builds' }); autoUpdater.checkForUpdates().catch(() => {}); });
  ipcMain.on('update-install', () => { setImmediate(() => autoUpdater.quitAndInstall(false, true)); });
  if (process.env.CLAUDIO_DEV_UPDATES) autoUpdater.forceDevUpdateConfig = true;
  if (app.isPackaged || process.env.CLAUDIO_DEV_UPDATES) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  }
}

ipcMain.on('app-version', e => { e.returnValue = app.getVersion(); });
ipcMain.on('gpu-enabled', e => { e.returnValue = GPU_ON; });
ipcMain.handle('gpu-info', async () => {
  let device = '';
  try { const g = await app.getGPUInfo('basic'); const d = (g.gpuDevice || []).find(x => x.active) || (g.gpuDevice || [])[0]; if (d) device = d.deviceString || d.description || ''; } catch {}
  return { enabled: GPU_ON, status: app.getGPUFeatureStatus(), device, crashes: gpuCrashes };
});
// window.prompt() replacement: a small modal window, answered synchronously
const promptWaits = new Map();
ipcMain.on('prompt-result', (_e, id, value) => { const w = promptWaits.get(id); if (w) w(value); });
ipcMain.on('prompt-sync', (e, message, def, lang) => {
  const parent = BrowserWindow.fromWebContents(e.sender), dark = nativeTheme.shouldUseDarkColors, id = crypto.randomUUID();
  const pw = new BrowserWindow({ parent, modal: true, width: 460, height: 196, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, frame: false, show: false, skipTaskbar: true,
    backgroundColor: dark ? '#17181f' : '#f7f8fb', webPreferences: { preload: path.join(__dirname, 'prompt-preload.js'), contextIsolation: true, sandbox: true } });
  let done = false;
  const finish = v => { if (done) return; done = true; promptWaits.delete(id); e.returnValue = v == null ? null : String(v); if (!pw.isDestroyed()) pw.destroy(); };
  promptWaits.set(id, finish); pw.on('closed', () => finish(null));
  const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const L = lang === 'de' ? { ok: 'OK', cancel: 'Abbrechen' } : { ok: 'OK', cancel: 'Cancel' };
  const fg = dark ? '#eceef4' : '#15161c', dim = dark ? '#9aa0ae' : '#5c6170', line = dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.12)', field = dark ? 'rgba(255,255,255,.06)' : '#fff';
  const html = `<!doctype html><meta charset="utf-8"><title>Claud.io</title><style>
    *{box-sizing:border-box} body{margin:0;padding:18px 20px;font:13px/1.45 "Segoe UI",system-ui,sans-serif;color:${fg};background:transparent;-webkit-app-region:drag;border:1px solid ${line};height:100vh;border-radius:10px}
    p{margin:0 0 10px;color:${dim}} input{width:100%;padding:9px 11px;border-radius:8px;border:1px solid ${line};background:${field};color:${fg};font:inherit;outline:none;-webkit-app-region:no-drag}
    input:focus{border-color:#7c6cf0;box-shadow:0 0 0 3px rgba(124,108,240,.25)} .b{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
    button{-webkit-app-region:no-drag;padding:7px 16px;border-radius:8px;border:1px solid ${line};background:${field};color:${fg};font:inherit;cursor:pointer} button.p{background:#6c5ce7;border-color:#6c5ce7;color:#fff}
  </style><p>${esc(message)}</p><input id="v" value="${esc(def)}" spellcheck="false"><div class="b"><button id="c">${L.cancel}</button><button class="p" id="o">${L.ok}</button></div>
  <script>const v=document.getElementById('v'),id=${JSON.stringify(id)};v.focus();v.select();
    const ok=()=>promptBridge.done(id,v.value),no=()=>promptBridge.done(id,null);
    document.getElementById('o').onclick=ok;document.getElementById('c').onclick=no;
    addEventListener('keydown',e=>{if(e.key==='Enter')ok();else if(e.key==='Escape')no();});</script>`;
  pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  pw.once('ready-to-show', () => pw.show());
  // test hook: type a value and press OK automatically
  if (process.env.CLAUDIO_PROMPT_TEST) pw.webContents.once('did-finish-load', () => pw.webContents.executeJavaScript(`document.getElementById('v').value=${JSON.stringify(process.env.CLAUDIO_PROMPT_TEST)};document.getElementById('o').click()`).catch(() => {}));
});
ipcMain.on('gpu-set', (_e, on) => { saveSettings({ gpu: !!on }); app.relaunch(); app.exit(0); });
ipcMain.on('zoom-set', (_e, k) => { const z = Math.min(1.5, Math.max(0.75, +k || 1)); if (win && !win.isDestroyed()) win.webContents.setZoomFactor(z); saveSettings({ zoom: z }); });
ipcMain.on('open-external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.on('renderer-ready', () => { rendererReady = true; while (pendingFiles.length) win.webContents.send('open-file', pendingFiles.shift()); });

app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  queueFileArgs(argv);
});

let gpuCrashes = 0, gpuAsked = false;
app.on('child-process-gone', (_e, d) => {
  if (d.type !== 'GPU' || d.reason === 'clean-exit') return;
  gpuCrashes++;
  if (gpuCrashes >= 3 && GPU_ON && !gpuAsked && win && !win.isDestroyed()) {
    gpuAsked = true;
    dialog.showMessageBox(win, { type: 'warning', buttons: ['Use software rendering', 'Keep GPU'], defaultId: 0, cancelId: 1, title: 'Claud.io',
      message: 'The graphics driver keeps crashing.', detail: 'Claud.io can restart without hardware acceleration. 3D and video export will be slower. You can switch it back on under About Claud.io.' })
      .then(r => { if (r.response === 0) { saveSettings({ gpu: false }); app.relaunch(); app.exit(0); } });
  }
});

app.whenReady().then(() => {
  app.setAppUserModelId('com.anrcy.claudio');
  Menu.setApplicationMenu(null);
  setupProtocols();
  createWindow();
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  queueFileArgs(process.argv);
  setupUpdater();
});
app.on('window-all-closed', () => app.quit());
