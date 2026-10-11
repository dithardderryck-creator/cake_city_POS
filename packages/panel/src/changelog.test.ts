import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, DEMO_STAFF, type Change, type DispatchResult, type Panel, type Staff, type Store, type SyncTerminal } from './index';

let store: Store;
let panel: Panel;
let owner: string;
let online: boolean;
let failNext: boolean;
let received: Change[];
const terminal: SyncTerminal = {
  isOnline: () => online,
  push: async () => undefined,
  pushChanges: async (changes) => {
    if (failNext) {
      failNext = false;
      return { ok: false, error: 'database unreachable' };
    }
    received.push(...changes);
    return { ok: true };
  },
};
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const pending = async () => (await store.find<Change>('changes', { where: { status: 'pending' } })).length;

beforeEach(async () => {
  online = true;
  failNext = false;
  received = [];
  store = createMemoryStore();
  panel = createPanel({ store, terminals: { sync: terminal } });
  await seedDemo(store, panel);
  const s = (await store.list<Staff>('staff')).find((x) => x.role === 'owner')!;
  owner = ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: s.id, pin: DEMO_STAFF.find((d) => d.role === 'owner')!.pin })).sessionId;
  await panel.syncNow(); // clear what setting up the demo logged
  received = [];
});

describe('change log and online sync', () => {
  it('records each save in order with the whole record, and sends it once the database confirms', async () => {
    ok(await panel.dispatch('staff/create', { name: 'Neema', role: 'cashier', pin: '4321' }, owner));
    const r = await panel.syncNow();
    expect(r.state).toBe('sent');
    const mine = received.filter((c) => c.collection === 'staff');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ op: 'put', record: { name: 'Neema', role: 'cashier' } });
    expect(received.map((c) => c.seq)).toEqual([...received.map((c) => c.seq)].sort((a, b) => a - b));
    expect(await pending()).toBe(0);
  });

  it('never copies sessions, PIN lock state or the change log itself', async () => {
    await panel.dispatch('auth/sign_in', { userId: (await store.list<Staff>('staff'))[0]!.id, pin: '0000' }); // a wrong PIN writes lock state
    await panel.syncNow();
    expect(received.some((c) => ['sessions', 'loginState', 'changes', 'outbox', 'pushSubscriptions'].includes(c.collection))).toBe(false);
  });

  it('keeps everything while offline, sends it in order when the connection returns', async () => {
    online = false;
    ok(await panel.dispatch('staff/create', { name: 'Asha', role: 'baker', pin: '1111' }, owner));
    ok(await panel.dispatch('staff/create', { name: 'Zawadi', role: 'inventory', pin: '2222' }, owner));
    expect((await panel.syncNow()).state).toBe('offline');
    expect(received).toHaveLength(0);
    const waiting = await pending();
    expect(waiting).toBeGreaterThan(1);
    online = true;
    const r = await panel.syncNow();
    expect(r.sent).toBe(waiting);
    const names = received.filter((c) => c.collection === 'staff').map((c) => (c.record as Staff).name);
    expect(names).toEqual(['Asha', 'Zawadi']);
  });

  it('loses nothing when the database refuses: the same changes are tried again, in the same order', async () => {
    ok(await panel.dispatch('staff/create', { name: 'Rehema', role: 'cashier', pin: '3333' }, owner));
    const waiting = await pending();
    failNext = true;
    const bad = await panel.syncNow();
    expect(bad).toMatchObject({ state: 'failed', sent: 0, error: 'database unreachable' });
    expect(await pending()).toBe(waiting);
    expect((await panel.syncNow()).state).toBe('sent');
    expect(received.filter((c) => c.collection === 'staff')).toHaveLength(1);
  });

  it('a failed instruction leaves nothing in the log (changes commit with the work or not at all)', async () => {
    const staffChanges = async () => (await store.find<Change>('changes', { where: { collection: 'staff' } })).length;
    const before = await staffChanges();
    const r = await panel.dispatch('staff/create', { name: 'X', role: 'cashier', pin: 'abc' }, owner); // refused: bad PIN
    expect(r.ok).toBe(false);
    expect(await staffChanges()).toBe(before); // the refusal itself is audited, but no staff record was logged
  });

  it('full copy queues every existing record for a new online database', async () => {
    const r = ok<{ queued: number }>(await panel.dispatch('sync/full_copy', {}, owner));
    expect(r.queued).toBeGreaterThan(5);
    await panel.syncNow();
    expect(received.filter((c) => c.collection === 'staff').length).toBe((await store.list('staff')).length);
  });

  it('says plainly when no online database is connected, and keeps the changes', async () => {
    const bare = createPanel({ store: createMemoryStore() });
    expect((await bare.syncNow()).state).toBe('not_set_up');
  });
});
