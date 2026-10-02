// Bundles the server and the admin tool into single files that run with plain `node`.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  // Native or optional modules stay outside the bundle and are loaded from node_modules.
  external: ['better-sqlite3', 'bufferutil', 'utf-8-validate'],
  // Some bundled packages use require(); this lets them do so inside an ES module.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/cake-pos-server.mjs' });
await build({ ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cake-pos-admin.mjs' });
