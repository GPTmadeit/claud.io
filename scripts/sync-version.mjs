// Copies the version from package.json into app/index.html (CLAUDIO_VERSION),
// so the browser build of the page reports the same version as the desktop app.
import fs from 'node:fs';
const v = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const f = 'app/index.html', s = fs.readFileSync(f, 'utf8');
const out = s.replace(/const CLAUDIO_VERSION = '[^']*';/, `const CLAUDIO_VERSION = '${v}';`);
if (out === s && !s.includes(`CLAUDIO_VERSION = '${v}'`)) { console.error('CLAUDIO_VERSION not found'); process.exit(1); }
fs.writeFileSync(f, out); console.log('app version', v);
