import { createPanel, seedDemo, type PinHasher } from '@cake-pos/panel';
import { makePairingCode } from './admin';
import type { Logger } from './log';
import type { SqliteStore } from './sqlite-store';

/**
 * A throw-away test copy (TEST_COPY=1) on a free host whose disk is wiped when it sleeps or restarts.
 * It fills an empty database with the demo shop, and makes a fresh one-time device code at every start so the person who
 * owns the host account can read it in the host's logs and register their first device. Nothing here is for a real shop.
 */
export async function prepareTestCopy(o: { store: SqliteStore; hasher: PinHasher; log: Logger; codeMinutes?: number }): Promise<{ code: string; seeded: boolean }> {
  const { store, hasher, log } = o;
  const had = (await store.list('staff')).length > 0;
  if (!had) {
    // A separate panel that does not ask for a registered device: nobody can reach the server yet, and there is nobody to be registered.
    await seedDemo(store, createPanel({ store, hasher }), hasher);
  }
  const made = await makePairingCode(store, { name: 'First device', minutes: o.codeMinutes ?? 30 });
  log.info('Test copy ready', { seeded: !had, expiresAt: made.expiresAt });
  return { code: made.code, seeded: !had };
}

/** The lines printed at start so the code is easy to find in a host's log page. */
export function testCopyBanner(r: { code: string; seeded: boolean }, minutes = 30): string[] {
  return [
    '',
    '  ============================================================',
    '  TEST COPY. Demo data only, wiped whenever this host restarts.',
    '  Never put real customers or real money in it.',
    r.seeded ? '  Filled an empty database with the demo shop (owner PIN 1111).' : '  The database already had data, so it was left alone.',
    '',
    `  First device code (works once, for ${minutes} minutes):   ${r.code}`,
    '  Open this address on the device and type the code in.',
    '  ============================================================',
    '',
  ];
}
