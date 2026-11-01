import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const panelSrc = path.resolve(__dirname, '../../panel/src');

describe('the sealed chain has one door', () => {
  it('nothing writes to the activity record except the function that seals it', () => {
    const files = [path.join(panelSrc, 'kernel.ts'), path.join(panelSrc, 'offline-replay.ts'), path.join(__dirname, 'admin.ts')];
    for (const f of files) expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/put(<[^>]*>)?\(\s*'audit'/);
    const seal = fs.readFileSync(path.join(panelSrc, 'circuits/seal.ts'), 'utf8');
    expect(seal).toMatch(/store\.put\('audit', audit\)/);
  });

  it('the admin tool seals what it does', () => {
    expect(fs.readFileSync(path.join(__dirname, 'admin.ts'), 'utf8')).toMatch(/appendAudit/);
  });
});
