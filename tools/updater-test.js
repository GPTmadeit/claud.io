// Exercises the Windows update path against the live GitHub feed:
// pretends to be an older version, checks, downloads and sha512-verifies the installer.
//   cp <installer resources>/app-update.yml tools/dev-app-update.yml   (needed for the download step)
//   npx electron tools/updater-test.js 1.0.0
const { app } = require('electron');
// Read the same feed file (latest.yml) an installed Windows copy reads.
Object.defineProperty(process, 'platform', { value: 'win32' });
const path = require('node:path');
const { NsisUpdater } = require(path.join(__dirname, '..', 'node_modules', 'electron-updater'));
app.whenReady().then(async () => {
  const fake = process.argv.find(a => /^\d+\.\d+\.\d+$/.test(a)) || '1.0.0';
  const u = new NsisUpdater({ provider: 'github', owner: 'GPTmadeit', repo: 'claud.io', releaseType: 'release' });
  Object.defineProperty(u, 'currentVersion', { get: () => fake, configurable: true });
  u.autoDownload = false; u.forceDevUpdateConfig = true;
  u.logger = { info: m => console.log('[info]', String(m).slice(0, 200)), warn: m => console.log('[warn]', m), error: m => console.log('[error]', m), debug: () => {} };
  let last = -10; u.on('download-progress', p => { if (p.percent - last >= 25) { last = p.percent; console.log('progress', Math.round(p.percent) + '%'); } });
  try {
    const r = await u.checkForUpdates();
    console.log('RESULT current', fake, '-> latest', r.updateInfo.version, 'available:', r.isUpdateAvailable);
    if (r.isUpdateAvailable) { const files = await u.downloadUpdate(); console.log('DOWNLOADED (sha512 verified):', files.map(f => path.basename(f)).join(', ')); }
  } catch (e) { console.log('FAIL', e.message.split('\n')[0]); process.exitCode = 1; }
  app.quit();
});
