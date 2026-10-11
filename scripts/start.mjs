// Starts the built shop server and serves the built pages from apps/ui/dist, so devices only need the server's address.
// Run:  npm run build && npm start        (STATIC_DIR still wins if you set it)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverJs = path.join(root, 'packages/server/dist/cake-pos-server.mjs');
const pages = path.join(root, 'apps/ui/dist');
if (!fs.existsSync(serverJs) || !fs.existsSync(path.join(pages, 'index.html'))) {
  console.error('Build first:  npm run build');
  process.exit(2);
}
process.env.STATIC_DIR ||= pages;
await import(pathToFileURL(serverJs).href);
