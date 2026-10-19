// Builds the UI into dist/: the shared script, the fonts, the sign-in page and every page in pages/.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// UI_DIST lets several people build and test at the same time without sharing one output folder.
const dist = process.env.UI_DIST ? path.resolve(process.env.UI_DIST) : path.join(here, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(here, 'src/cake.ts')],
  outfile: path.join(dist, 'cake.js'),
  bundle: true,
  format: 'iife',
  globalName: 'Cake',
  target: 'es2020',
  minify: true,
  sourcemap: true,
  logLevel: 'info',
});

// The Kiswahili word list: lines of "English ||| Kiswahili" in src/lang/*.txt, built into one small file that is only fetched
// when the shop uses Kiswahili. A line must keep the same {n} and {*} placeholders on both sides.
{
  const dir = path.join(here, 'src/lang');
  const entries = {};
  const place = (t) => (t.match(/\{[n*]\}/g) ?? []).sort().join('');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.txt')).sort() : []) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim() || line.startsWith('#')) return;
      const at = line.indexOf(' ||| ');
      if (at < 0) throw new Error(`${f}:${i + 1}: expected "English ||| Kiswahili"`);
      const en = line.slice(0, at).trim();
      const sw = line.slice(at + 5).trim();
      if (!en || !sw) throw new Error(`${f}:${i + 1}: empty side`);
      if (place(en) !== place(sw)) throw new Error(`${f}:${i + 1}: placeholders differ: ${line}`);
      entries[en] = sw;
    });
  }
  fs.writeFileSync(path.join(dist, 'lang-sw.js'), 'window.__cakeSw=' + JSON.stringify(entries) + ';');
  console.log('Kiswahili entries:', Object.keys(entries).length);
}

// Fonts are served by the shop server itself, so the screens look right with no internet.
const fonts = path.join(here, '../../node_modules/@fontsource-variable');
const face = (family, dir, file, weight) => {
  fs.mkdirSync(path.join(dist, 'fonts'), { recursive: true });
  fs.copyFileSync(path.join(fonts, dir, 'files', file), path.join(dist, 'fonts', file));
  return `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:${weight};src:url(/fonts/${file}) format("woff2-variations")}\n`;
};
fs.writeFileSync(
  path.join(dist, 'fonts.css'),
  face('Fraunces Variable', 'fraunces', 'fraunces-latin-wght-normal.woff2', '100 900') +
    face('Plus Jakarta Sans Variable', 'plus-jakarta-sans', 'plus-jakarta-sans-latin-wght-normal.woff2', '200 800') +
    // The page designs ask for the plain family names, so the same files answer to those too.
    face('Fraunces', 'fraunces', 'fraunces-latin-wght-normal.woff2', '100 900') +
    face('Plus Jakarta Sans', 'plus-jakarta-sans', 'plus-jakarta-sans-latin-wght-normal.woff2', '200 800'),
);

fs.copyFileSync(path.join(here, 'src/index.html'), path.join(dist, 'index.html'));
fs.copyFileSync(path.join(here, 'src/forms.css'), path.join(dist, 'forms.css'));
const pages = path.join(here, 'pages');
for (const f of fs.existsSync(pages) ? fs.readdirSync(pages) : []) {
  if (!f.endsWith('.html')) continue;
  // Every page uses the self-hosted fonts and the shared script.
  fs.copyFileSync(path.join(pages, f), path.join(dist, f));
}
// The offline copy of the pages (see src/sw.js). Its name changes with every build, so a new build replaces the old copy.
const precache = ['/', '/cake.js', '/lang-sw.js', '/fonts.css', '/forms.css', ...fs.readdirSync(pages).filter((f) => f.endsWith('.html')).map((f) => '/' + f), ...(fs.existsSync(path.join(dist, 'fonts')) ? fs.readdirSync(path.join(dist, 'fonts')).map((f) => '/fonts/' + f) : [])];
fs.writeFileSync(
  path.join(dist, 'sw.js'),
  fs.readFileSync(path.join(here, 'src/sw.js'), 'utf8').replace('__VERSION__', String(Date.now())).replace('__PRECACHE__', JSON.stringify(precache)),
);
console.log('UI built into', dist);
