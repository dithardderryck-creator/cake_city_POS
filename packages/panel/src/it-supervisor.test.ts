import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type DispatchResult, type Panel, type Staff, type Store } from './index';

let t = Date.UTC(2026, 9, 27, 8, 0, 0);
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const id = async (role: string) => (await store.list<Staff>('staff')).find((s) => s.role === role)!.id;
async function signIn(role: string) {
  return ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: await id(role), pin: DEMO_STAFF.find((s) => s.role === role)!.pin })).sessionId;
}
async function lockOut(role: string) {
  const userId = await id(role);
  for (let i = 0; i < 5; i++) await panel.dispatch('auth/sign_in', { userId, pin: '0000' });
  return userId;
}

beforeEach(async () => {
  t = Date.UTC(2026, 9, 27, 8, 0, 0);
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  await seedDemo(store, panel);
});

describe('IT sees who is locked out and can let them in', () => {
  it('lists people shut out by wrong PINs, and drops them when the time is up', async () => {
    const baker = await lockOut('baker');
    const it = await signIn('it');
    const m = await panel.feed('panel_map', {}, it);
    expect(m.ok && m.data.lockedOut.map((x) => x.id)).toEqual([baker]);
    t += 61_000;
    const later = await panel.feed('panel_map', {}, it);
    expect(later.ok && later.data.lockedOut).toEqual([]);
  });

  it('lets IT and the owner unlock, and the person can sign in at once', async () => {
    const baker = await lockOut('baker');
    const it = await signIn('it');
    ok(await panel.dispatch('staff/unlock', { userId: baker }, it));
    ok(await panel.dispatch('auth/sign_in', { userId: baker, pin: '3333' }));

    const cashier = await lockOut('cashier');
    const owner = await signIn('owner');
    ok(await panel.dispatch('staff/unlock', { userId: cashier }, owner));
  });

  it('refuses cashiers, someone who is not locked out, and does not touch the PIN', async () => {
    const baker = await lockOut('baker');
    const cashier = await signIn('cashier');
    expect((await panel.dispatch('staff/unlock', { userId: baker }, cashier)).ok).toBe(false);
    const it = await signIn('it');
    const fine = await panel.dispatch('staff/unlock', { userId: await id('inventory') }, it);
    expect(fine.ok).toBe(false);
    if (!fine.ok) expect(fine.error.messages.join(' ')).toMatch(/not locked out/);
    ok(await panel.dispatch('staff/unlock', { userId: baker }, it));
    // The old PIN still works; the wrong one still counts as wrong.
    expect((await panel.dispatch('auth/sign_in', { userId: baker, pin: '1234' })).ok).toBe(false);
  });

  it('is written in the activity record with who did it', async () => {
    const baker = await lockOut('baker');
    const it = await signIn('it');
    ok(await panel.dispatch('staff/unlock', { userId: baker }, it));
    const a = await panel.feed('audit_view', {}, it);
    expect(a.ok && a.data.some((x) => x.intent === 'staff/unlock' && /back in/.test(x.summary))).toBe(true);
  });
});

describe('the Selling line', () => {
  it('counts registered devices seen in the last hour and names the ones quiet for a day', async () => {
    const it = await signIn('it');
    const m = await panel.feed('panel_map', {}, it);
    expect(m.ok && m.data.selling.state).toBe('normal');
    expect(m.ok && m.data.selling.online).toBeLessThanOrEqual(m.ok ? m.data.selling.devices : 0);
  });
  it('is for IT only', async () => {
    const cashier = await signIn('cashier');
    expect((await panel.feed('panel_map', {}, cashier)).ok).toBe(false);
  });
});

describe('alerts for IT only', () => {
  let facts: { backupError: string | null; google: { id: string; email: string | null; state: string; problem: string | null }[]; space: { freeBytes: number; totalBytes: number } | null };
  let ticking: Panel;
  beforeEach(async () => {
    facts = { backupError: null, google: [], space: { freeBytes: 60e9, totalBytes: 100e9 } };
    ticking = createPanel({
      store,
      clock,
      terminals: {
        backup: { status: async () => ({ lastOkAt: null, lastError: facts.backupError, pendingUploads: 0, lastFile: null }) },
        system: { info: async () => [], space: async () => facts.space },
        drive: { status: async () => ({ clientReady: true, clientFrom: 'saved', folderName: 'Cake POS', accounts: facts.google.map((g, i) => ({ ...g, connectedAt: '2026-10-01T00:00:00Z', state: g.state as 'ok', usedBytes: null, limitBytes: null, checkedAt: null, lastOkAt: null, position: i + 1 })), connect: null, problem: null }) } as never,
      },
    });
  });
  const open = async (role: string) => {
    const sid = await signInWith(ticking, role);
    const r = await ticking.feed('alert_inbox', {}, sid);
    return r.ok ? r.data.open : null;
  };
  async function signInWith(p: Panel, role: string) {
    return ok<{ sessionId: string }>(await p.dispatch('auth/sign_in', { userId: await id(role), pin: DEMO_STAFF.find((s) => s.role === role)!.pin })).sessionId;
  }

  it('says nothing when everything is fine', async () => {
    await ticking.tick();
    expect(await open('it')).toEqual([]);
  });

  it('raises a backup, Google and low-space alert for IT, and clears each when it is fixed', async () => {
    facts.backupError = 'Could not write the backup file.';
    facts.google = [{ id: 'g1', email: 'shop@example.com', state: 'needs_signin', problem: 'Sign in again.' }];
    facts.space = { freeBytes: 4e9, totalBytes: 100e9 };
    await ticking.tick();
    const titles = ((await open('it')) ?? []).map((a) => a.title);
    expect(titles).toEqual(expect.arrayContaining(['The last backup failed', 'Google needs a look: shop@example.com', 'The disk is nearly full']));
    facts.backupError = null;
    facts.google = [];
    facts.space = { freeBytes: 60e9, totalBytes: 100e9 };
    await ticking.tick();
    expect(await open('it')).toEqual([]);
  });

  it('raises one alert for a person who is locked out, and Let in closes it at once', async () => {
    const baker = await lockOut('baker');
    await ticking.tick();
    const mine = (await open('it'))!.filter((a) => a.kind === 'system_pins');
    expect(mine.map((a) => a.title)).toEqual(['Neema (Baker) is locked out']);
    const sid = await signInWith(ticking, 'it');
    ok(await ticking.dispatch('staff/unlock', { userId: baker }, sid));
    expect((await open('it'))!.filter((a) => a.kind === 'system_pins')).toEqual([]);
  });

  it('a failed sync raises an alert, but a failed message does not', async () => {
    await store.put('outbox', { id: 'o1', kind: 'sms', payload: {}, createdAt: '2026-10-27T08:00:00Z', attempts: 5, status: 'failed' });
    await ticking.tick();
    expect(await open('it')).toEqual([]);
    await store.put('outbox', { id: 'o2', kind: 'sync', payload: {}, createdAt: '2026-10-27T08:00:00Z', attempts: 5, status: 'failed' });
    await ticking.tick();
    expect((await open('it'))!.map((a) => a.title)).toEqual(['1 change could not be synced']);
  });

  it('keeps system alerts away from the owner and everyone else', async () => {
    facts.backupError = 'Disk error.';
    await lockOut('baker');
    await ticking.tick();
    expect((await open('it'))!.length).toBe(2);
    for (const role of ['owner', 'cashier', 'inventory']) expect(await open(role)).toEqual([]);
    const sid = await signInWith(ticking, 'owner');
    const nav = await ticking.feed('navigation', {}, sid);
    expect(nav.ok && nav.data.find((n) => n.id === 'alerts')?.badge).toBeUndefined();
  });

  it('an alert the timer has not looked at again is neither raised nor cleared by ordinary work', async () => {
    facts.backupError = 'Disk error.';
    await ticking.tick();
    const cashier = await signInWith(ticking, 'cashier');
    await ticking.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup', customerName: 'Joe', deliveryDate: '2026-10-27' }, cashier);
    expect((await open('it'))!.map((a) => a.title)).toEqual(['The last backup failed']);
  });

  it('shows the owner one quiet line, only after a problem has been open a day, and not what it is', async () => {
    facts.backupError = 'Disk error.';
    await ticking.tick();
    const owner = await signInWith(ticking, 'owner');
    expect((await ticking.feed('system_notice', {}, owner)).ok && (await ticking.feed('system_notice', {}, owner) as { data: { openForDay: boolean } }).data.openForDay).toBe(false);
    t += 25 * 3_600_000;
    await ticking.tick();
    const owner2 = await signInWith(ticking, 'owner');
    const n = await ticking.feed('system_notice', {}, owner2);
    expect(n.ok && n.data).toEqual({ openForDay: true });
    facts.backupError = null;
    await ticking.tick();
    const gone = await ticking.feed('system_notice', {}, owner2);
    expect(gone.ok && gone.data.openForDay).toBe(false);
    expect((await ticking.feed('system_notice', {}, await signInWith(ticking, 'cashier'))).ok).toBe(false);
  });

  it('lets IT see the alert and take it', async () => {
    facts.backupError = 'Disk error.';
    await ticking.tick();
    const sid = await signInWith(ticking, 'it');
    const [a] = (await open('it'))!;
    ok(await ticking.dispatch('alerts/mark_seen', { alertIds: [a!.alertId] }, sid));
    ok(await ticking.dispatch('alerts/acknowledge', { alertId: a!.alertId }, sid));
  });
});

describe('Sessions and Logs, read-only for IT', () => {
  it('lists who is signed in now, with their device, and never a token', async () => {
    await signIn('cashier');
    await signIn('baker');
    const it = await signIn('it');
    const r = await panel.feed('sessions_view', {}, it);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows.map((x) => x.role).sort()).toEqual(['baker', 'cashier', 'it']);
    expect(JSON.stringify(r.data)).not.toMatch(/token|"id"/i);
    expect(r.data.rows.every((x) => x.endsAt > x.lastSeenAt)).toBe(true);
  });

  it('drops a session once it has been idle too long', async () => {
    await signIn('cashier');
    t += 11 * 3_600_000;
    const it = await signIn('it');
    const r = await panel.feed('sessions_view', {}, it);
    expect(r.ok && r.data.rows.map((x) => x.role)).toEqual(['it']);
  });

  it('is for IT only, for sessions and logs', async () => {
    for (const role of ['owner', 'cashier', 'baker', 'inventory']) {
      const sid = await signIn(role);
      expect((await panel.feed('sessions_view', {}, sid)).ok).toBe(false);
      expect((await panel.feed('logs_view', {}, sid)).ok).toBe(false);
    }
  });

  it('says plainly when the server keeps no log, and passes the filters to the log reader', async () => {
    const it = await signIn('it');
    const none = await panel.feed('logs_view', {}, it);
    expect(none.ok && none.data).toMatchObject({ available: false, rows: [] });
    const seen: unknown[] = [];
    const withLogs = createPanel({ store, clock, terminals: { logs: { recent: async (o) => (seen.push(o), { rows: [{ at: '2026-10-27T08:00:00Z', level: 'error', message: 'Backup failed', detail: '' }], note: null }) } } });
    const sid = ok<{ sessionId: string }>(await withLogs.dispatch('auth/sign_in', { userId: await id('it'), pin: '9999' })).sessionId;
    const r = await withLogs.feed('logs_view', { level: 'error', hours: 6 }, sid);
    expect(r.ok && r.data.rows[0]!.message).toBe('Backup failed');
    expect(seen).toEqual([{ level: 'error', sinceMs: 6 * 3_600_000, limit: 200 }]);
    expect((await withLogs.feed('logs_view', { level: 'bad' } as never, sid)).ok).toBe(false);
  });
});
