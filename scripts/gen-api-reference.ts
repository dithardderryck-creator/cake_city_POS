import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderApiReference } from '../packages/panel/src/index';

const file = fileURLToPath(new URL('../docs/api-reference.md', import.meta.url));
fs.writeFileSync(file, renderApiReference());
console.log(`Wrote ${file}`);
