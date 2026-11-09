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
ipcMain.on('open-external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.on('renderer-ready', () => { rendererReady = true; while (pendingFiles.length) win.webContents.send('open-file', pendingFiles.shift()); });

app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  queueFileArgs(argv);
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
