import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderApiReference } from '@cake-pos/panel';

describe('API reference', () => {
  it('matches the committed docs/api-reference.md, so the documentation cannot go stale', () => {
    const file = path.resolve(__dirname, '../../../docs/api-reference.md');
    expect(fs.existsSync(file), 'docs/api-reference.md is missing. Run: npm run docs:api').toBe(true);
    expect(fs.readFileSync(file, 'utf8'), 'docs/api-reference.md is out of date. Run: npm run docs:api').toBe(renderApiReference());
  });

  it('would notice a change: removing a field from a schema changes the generated text', () => {
    const text = renderApiReference();
    expect(text).toContain('#### `payments/record_payment`');
    expect(text).toContain('| `allowPartial` | boolean | no |');
    expect(text).toContain('Allowed: **owner**'); // refunds and staff management are owner-only
  });
});
