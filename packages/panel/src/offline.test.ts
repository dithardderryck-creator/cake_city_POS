import { beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryStore,
  createPanel,
  seedDemo,
  DEMO_STAFF,
  derivePassKey,
  GENESIS_TAG,
  offlineTag,
  type CatalogueGridItem,
  type DispatchResult,
  type OrderCardData,
  type Panel,
  type QueuedAction,
  type ReplayItemResult,
  type ReplayResult,
  type Staff,
  type Store,
} from './index';
import type { AuditEntry, HeldAction, OfflinePass, Order, Payment, StockMovement } from './domain';

let t: number;
const clock = { now: () => new Date(t) };
const iso = (ms = t) => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

let store: Store;
let panel: Panel;
let devA: string;
let devB: string;
type Role = 'owner' | 'cashier' | 'baker' | 'inventory' | 'it';
const sid: Record<string, string> = {};

const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const errOf = (r: DispatchResult) => (r.ok ? '' : `${r.error.code}: ${r.error.messages.join(' ')}`);
const staffOf = async (role: Role) => (await store.list<Staff>('staff')).find((s) => s.role === role)!;

async function signIn(role: Role, deviceToken?: string) {
  const s = await staffOf(role);
  const r = await panel.dispatch('auth/sign_in', { userId: s.id, pin: DEMO_STAFF.find((x) => x.role === role)!.pin }, undefined, { deviceToken });
  sid[role] = ok<{ sessionId: string }>(r).sessionId;
}
const send = (role: Role, type: Parameters<Panel['dispatch']>[0], payload: Parameters<Panel['dispatch']>[1], deviceToken?: string, requestId?: string) =>
  panel.dispatch(type, payload as never, sid[role], { deviceToken, requestId });
const feed = async <T>(role: Role, name: Parameters<Panel['feed']>[0], params: object = {}) => {
  const r = await panel.feed(name, params as never, sid[role]);
  if (!r.ok) throw new Error(`${name}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
async function sellable(name: string) {
  const grid = await feed<CatalogueGridItem[]>('cashier', 'catalogue_grid');
  return grid.find((g) => g.name === name)!.combinations.find((c) => c.sellable)!;
}

async function pair(name: string) {
  const code = ok<{ code: string }>(await send('owner', 'devices/create_code', { name })).code;
  return ok<{ deviceToken: string }>(await panel.dispatch('devices/pair', { code })).deviceToken;
}

interface Till {
  passId: string;
  key: string;
  userId: string;
  issuedAt: string;
  expiresAt: string;
}
/** What the browser holds after asking for a pass. */
async function getPass(role: Role = 'cashier', dev = devA): Promise<Till> {
  const d = ok<{ passId: string; key: string; userId: string; issuedAt: string; expiresAt: string }>(await send(role, 'offline/get_pass', {}, dev));
  return d;
}

type Sale = { items: Array<{ combinationId: string; qty: number }>; method: string; expectedTotal?: number; reference?: string };
/** What the browser does: chain each sale to the one before. */
async function queue(till: Till, sales: Array<{ type?: string; payload: unknown; at?: number; requestId?: string }>, start = 1, prev = GENESIS_TAG) {
  const out: Array<QueuedAction & { tag: string }> = [];
  let prevTag = prev;
  let seq = start;
  for (const s of sales) {
    const a: QueuedAction = { seq, requestId: s.requestId ?? `req-${till.passId}-${seq}`, type: s.type ?? 'orders/quick_sale', payload: s.payload, queuedAt: iso(s.at ?? t) };
    const tag = await offlineTag(till.key, till.passId, prevTag, a);
    out.push({ ...a, tag });
    prevTag = tag;
    seq++;
  }
  return out;
}
const replay = (till: Till | string, actions: unknown[], dev: string | undefined = devA) =>
  panel.replayOffline({ passId: typeof till === 'string' ? till : till.passId, actions }, dev);
const results = (r: ReplayResult): ReplayItemResult[] => {
  if (!r.ok) throw new Error(`Expected a replay answer, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.results;
};
const statuses = (r: ReplayResult) => results(r).map((x) => x.status);
const orders = () => store.list<Order>('orders');
const passRow = async (id: string) => (await store.get<OfflinePass>('offlinePasses', id))!;
const audits = async () => store.list<AuditEntry>('audit');
const refusals = async () => (await audits()).filter((a) => a.intent === 'offline/replay' && a.outcome === 'denied');

let cake: { combinationId: string; price: number | null };
let cake2: { combinationId: string; price: number | null };
const sale = (qty = 1, c = cake, method = 'cash'): Sale => ({ items: [{ combinationId: c.combinationId, qty }], method, expectedTotal: (c.price ?? 0) * qty });

async function enableOffline(extra: Record<string, unknown> = {}) {
  ok(await send('owner', 'settings/update', { offlineEnabled: true, ...extra }));
}

beforeEach(async () => {
  t = new Date(2026, 9, 14, 9, 0, 0).getTime();
  store = createMemoryStore();
  panel = createPanel({ store, clock, requireDevice: true });
  await seedDemo(store, createPanel({ store, clock }));
  // The first device is registered from a panel that does not check devices, as the real server does with a code.
  const open = createPanel({ store, clock });
  const ownerSession = ok<{ sessionId: string }>(await open.dispatch('auth/sign_in', { userId: (await staffOf('owner')).id, pin: DEMO_STAFF.find((x) => x.role === 'owner')!.pin })).sessionId;
  const code = ok<{ code: string }>(await open.dispatch('devices/create_code', { name: 'Counter A' }, ownerSession)).code;
  devA = ok<{ deviceToken: string }>(await panel.dispatch('devices/pair', { code })).deviceToken;
  await signIn('owner', devA);
  await signIn('cashier', devA);
  await signIn('baker', devA);
  devB = await pair('Counter B');
  const grid = await feed<CatalogueGridItem[]>('cashier', 'catalogue_grid');
  const sell = grid.flatMap((g) => g.combinations.filter((c) => c.sellable).map((c) => ({ combinationId: c.combinationId, price: c.price })));
  cake = sell[0]!;
  cake2 = sell.find((s) => s.combinationId !== cake.combinationId)!;
});

describe('offline pass', () => {
  it('is off until the owner switches it on, and says so plainly', async () => {
    expect((await feed<{ offlineEnabled: boolean }>('cashier', 'shop_settings')).offlineEnabled).toBe(false);
    expect(errOf(await send('cashier', 'offline/get_pass', {}, devA))).toMatch(/switched off/);
    await enableOffline();
    expect((await feed<{ offlineEnabled: boolean }>('cashier', 'shop_settings')).offlineEnabled).toBe(true);
    expect((await getPass()).passId).toBeTruthy();
  });

  it('only owner and cashier can ask for one', async () => {
    await enableOffline();
    expect(errOf(await send('baker', 'offline/get_pass', {}, devA))).toMatch(/forbidden/);
  });

  it('needs a registered device', async () => {
    await enableOffline();
    const open = createPanel({ store, clock }); // does not check devices, so the cashier can sign in without one
    const s = ok<{ sessionId: string }>(await open.dispatch('auth/sign_in', { userId: (await staffOf('cashier')).id, pin: DEMO_STAFF.find((x) => x.role === 'cashier')!.pin })).sessionId;
    expect(errOf(await open.dispatch('offline/get_pass', {}, s))).toMatch(/registered device/);
  });

  it('carries the limits and expiry the owner set', async () => {
    await enableOffline({ offlinePassHours: 6, offlineMaxSales: 7, offlineMaxTotal: 123_000 });
    const till = await getPass();
    const p = await passRow(till.passId);
    expect([p.maxSales, p.maxTotal, p.nextSeq, p.lastTag]).toEqual([7, 123_000, 1, GENESIS_TAG]);
    expect(Date.parse(till.expiresAt) - Date.parse(till.issuedAt)).toBe(6 * HOUR);
  });

  it('keeps the pass key out of the database and out of the retry memory', async () => {
    await enableOffline();
    const r = await send('cashier', 'offline/get_pass', {}, devA, 'same-id');
    const key = ok<{ key: string }>(r).key;
    const dump = JSON.stringify(await Promise.all(['offlinePasses', 'requests', 'audit', 'heldActions', 'offlineLog', 'changes', 'outbox'].map((c) => store.list(c as never))));
    expect(dump).not.toContain(key);
    // asking again with the same request id gives a fresh pass, not the remembered answer
    const again = ok<{ passId: string; key: string }>(await send('cashier', 'offline/get_pass', {}, devA, 'same-id'));
    expect(again.passId).not.toBe((r as { ok: true; data: { passId: string } }).data.passId);
  });

  it('is worked out from the master key: the same key and pass give the same secret, another master gives another', async () => {
    const a = await derivePassKey('AAAA', 'p1', 'u1', 'd1');
    expect(await derivePassKey('AAAA', 'p1', 'u1', 'd1')).toBe(a);
    expect(await derivePassKey('BBBB', 'p1', 'u1', 'd1')).not.toBe(a);
    expect(await derivePassKey('AAAA', 'p2', 'u1', 'd1')).not.toBe(a);
    expect(await derivePassKey('AAAA', 'p1', 'u2', 'd1')).not.toBe(a);
    expect(await derivePassKey('AAAA', 'p1', 'u1', 'd2')).not.toBe(a);
  });

  it('survives a restart of the server: the master key was kept', async () => {
    await enableOffline();
    const till = await getPass();
    const [a] = await queue(till, [{ payload: sale() }]);
    panel = createPanel({ store, clock, requireDevice: true }); // new process, same database
    expect(statuses(await replay(till, [a]))).toEqual(['done']);
  });

  it('can be told its master key from outside the database, and then never writes one down', async () => {
    const own = createPanel({ store, clock, requireDevice: true, offlineMasterKey: 'c2VjcmV0LWZyb20tYS1maWxl' });
    const s = ok<{ sessionId: string }>(await own.dispatch('auth/sign_in', { userId: (await staffOf('owner')).id, pin: DEMO_STAFF.find((x) => x.role === 'owner')!.pin }, undefined, { deviceToken: devA })).sessionId;
    ok(await own.dispatch('settings/update', { offlineEnabled: true }, s, { deviceToken: devA }));
    const c = ok<{ sessionId: string }>(await own.dispatch('auth/sign_in', { userId: (await staffOf('cashier')).id, pin: DEMO_STAFF.find((x) => x.role === 'cashier')!.pin }, undefined, { deviceToken: devA })).sessionId;
    const pass = ok<{ key: string; passId: string; userId: string }>(await own.dispatch('offline/get_pass', {}, c, { deviceToken: devA }));
    expect(await store.list('serverKeys')).toHaveLength(0);
    const dev = (await store.list<{ id: string; name: string }>('devices')).find((d) => d.name === 'Counter A')!;
    expect(pass.key).toBe(await derivePassKey('c2VjcmV0LWZyb20tYS1maWxl', pass.passId, pass.userId, dev.id));
  });
});

describe('replaying a queue', () => {
  let till: Till;
  beforeEach(async () => {
    await enableOffline();
    await signIn('cashier', devA);
    till = await getPass();
  });

  it('sells every queued sale as the cashier who made it: orders, stock, payments, audit, and the time it really happened', async () => {
    const before = (await store.list<StockMovement>('stockMovements')).length;
    const at1 = t + 10 * MIN;
    const at2 = t + 20 * MIN;
    const q = await queue(till, [{ payload: sale(2), at: at1 }, { payload: sale(1, cake2), at: at2 }]);
    t += HOUR;
    const r = await replay(till, q, devA);
    expect(statuses(r)).toEqual(['done', 'done']);
    const os = (await orders()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(os).toHaveLength(2);
    expect(os.map((o) => o.createdBy)).toEqual([till.userId, till.userId]);
    expect(os.map((o) => o.createdAt)).toEqual([iso(at1), iso(at2)]);
    expect(os.every((o) => o.instant)).toBe(true);
    const pays = await store.list<Payment>('payments');
    expect(pays.map((p) => p.amount).sort()).toEqual([(cake.price ?? 0) * 2, cake2.price ?? 0].sort());
    expect(pays.every((p) => p.receivedBy === till.userId)).toBe(true);
    expect((await store.list<StockMovement>('stockMovements')).length).toBeGreaterThanOrEqual(before);
    const p = await passRow(till.passId);
    expect([p.nextSeq, p.sales, p.total]).toEqual([3, 2, (cake.price ?? 0) * 2 + (cake2.price ?? 0)]);
    expect((await audits()).filter((a) => a.intent === 'offline/replay' && a.outcome === 'ok')).toHaveLength(2);
    const first = results(r)[0]!;
    expect(first.message).toMatch(/Sent: order/);
    expect(first.number).toBeTruthy();
  });

  it('needs no sign-in: the person may be signed out by the time the connection is back', async () => {
    const q = await queue(till, [{ payload: sale() }]);
    ok(await send('cashier', 'auth/sign_out', {}, devA));
    expect(statuses(await replay(till, q))).toEqual(['done']);
  });

  it('sending the same queue again changes nothing and returns the same answers', async () => {
    const q = await queue(till, [{ payload: sale() }, { payload: sale(1, cake2) }]);
    const first = results(await replay(till, q));
    const count = (await orders()).length;
    const pays = (await store.list('payments')).length;
    const second = results(await replay(till, q));
    expect(second.map((x) => x.status)).toEqual(['duplicate', 'duplicate']);
    expect(second.map((x) => x.number)).toEqual(first.map((x) => x.number));
    expect((await orders()).length).toBe(count);
    expect((await store.list('payments')).length).toBe(pays);
    expect((await passRow(till.passId)).sales).toBe(2);
  });

  it('can send the first part, then the rest, as the connection comes and goes', async () => {
    const q = await queue(till, [{ payload: sale() }, { payload: sale() }, { payload: sale() }]);
    expect(statuses(await replay(till, q.slice(0, 1)))).toEqual(['done']);
    expect(statuses(await replay(till, q.slice(0, 3)))).toEqual(['duplicate', 'done', 'done']);
    expect(await orders()).toHaveLength(3);
  });

  it('finishes a sale that was already made when the answer was lost: no second sale, chain moves on', async () => {
    const q = await queue(till, [{ payload: sale(), requestId: 'lost-answer' }, { payload: sale() }]);
    // the server made the sale but stopped before it noted the chain: the same request id, same person, made earlier
    ok(await send('cashier', 'orders/quick_sale', q[0]!.payload as never, devA, 'lost-answer'));
    expect(await orders()).toHaveLength(1);
    expect(statuses(await replay(till, q))).toEqual(['done', 'done']);
    expect(await orders()).toHaveLength(2);
    expect((await passRow(till.passId)).nextSeq).toBe(3);
  });

  it('works while another sale is happening online', async () => {
    const q = await queue(till, [{ payload: sale() }]);
    ok(await send('cashier', 'orders/quick_sale', sale() as never, devA));
    expect(statuses(await replay(till, q))).toEqual(['done']);
    expect(await orders()).toHaveLength(2);
  });
});

describe('forgery and tampering: each is refused and logged, and nothing is sold', () => {
  let till: Till;
  beforeEach(async () => {
    await enableOffline();
    till = await getPass();
  });
  const nothingSold = async () => {
    expect(await orders()).toHaveLength(0);
    expect(await store.list('payments')).toHaveLength(0);
  };

  it('a sale made up by someone without the pass key', async () => {
    const fake: Till = { ...till, key: await derivePassKey('not-the-servers-key', till.passId, till.userId, 'x') };
    const q = await queue(fake, [{ payload: sale() }]);
    expect(statuses(await replay(till, q))).toEqual(['rejected']);
    await nothingSold();
    expect((await refusals()).length).toBe(1);
  });

  it('a made-up tag', async () => {
    const [a] = await queue(till, [{ payload: sale() }]);
    expect(statuses(await replay(till, [{ ...a!, tag: 'a'.repeat(64) }]))).toEqual(['rejected']);
    await nothingSold();
  });

  it.each([
    ['the quantity', (a: QueuedAction) => ({ ...a, payload: { ...(a.payload as object), items: [{ combinationId: cake.combinationId, qty: 5 }] } })],
    ['the payment method', (a: QueuedAction) => ({ ...a, payload: { ...(a.payload as object), method: 'mobile_money' } })],
    ['the total shown', (a: QueuedAction) => ({ ...a, payload: { ...(a.payload as object), expectedTotal: 1 } })],
    ['the item', (a: QueuedAction) => ({ ...a, payload: { ...(a.payload as object), items: [{ combinationId: cake2.combinationId, qty: 1 }] } })],
    ['the request id', (a: QueuedAction) => ({ ...a, requestId: 'another-id' })],
    ['the time', (a: QueuedAction) => ({ ...a, queuedAt: iso(t + 1000) })],
    ['the instruction name', (a: QueuedAction) => ({ ...a, type: 'orders/quick_sale ' })],
    ['an extra field in the sale', (a: QueuedAction) => ({ ...a, payload: { ...(a.payload as object), reference: 'extra' } })],
  ])('an edit to %s', async (_n, edit) => {
    const [a] = await queue(till, [{ payload: sale() }]);
    expect(statuses(await replay(till, [{ ...edit(a!), tag: a!.tag }]))).toEqual(['rejected']);
    await nothingSold();
    expect((await passRow(till.passId)).nextSeq).toBe(1);
  });

  it('the same sale with its keys written in another order is still the same sale', async () => {
    const [a] = await queue(till, [{ payload: sale() }]);
    const p = a!.payload as Record<string, unknown>;
    const shuffled = Object.fromEntries(Object.entries(p).reverse());
    expect(statuses(await replay(till, [{ ...a!, payload: shuffled }]))).toEqual(['done']);
  });

  it('a sale taken out of the middle: later ones wait, and arrive once the missing one is sent', async () => {
    const q = await queue(till, [{ payload: sale() }, { payload: sale() }, { payload: sale() }]);
    const r = await replay(till, [q[0]!, q[2]!]);
    expect(statuses(r)).toEqual(['done', 'rejected']);
    expect(results(r)[1]!.message).toMatch(/sale 2 is missing/);
    expect(await orders()).toHaveLength(1);
    expect(statuses(await replay(till, [q[1]!, q[2]!]))).toEqual(['done', 'done']);
    expect(await orders()).toHaveLength(3);
  });

  it('sales sent out of order', async () => {
    const q = await queue(till, [{ payload: sale() }, { payload: sale() }]);
    expect(statuses(await replay(till, [q[1]!, q[0]!]))).toEqual(['rejected', 'done']);
    expect((await orders()).length).toBe(1);
  });

  it('a different sale sent under a number that was already used', async () => {
    const q = await queue(till, [{ payload: sale() }]);
    expect(statuses(await replay(till, q))).toEqual(['done']);
    const evil = await queue(till, [{ payload: sale(3) }]);
    expect(statuses(await replay(till, evil))).toEqual(['rejected']);
    expect(await orders()).toHaveLength(1);
  });

  it("a sale signed with another till's pass key", async () => {
    await signIn('cashier', devB);
    const tillB = await getPass('cashier', devB);
    const q = await queue(tillB, [{ payload: sale() }]);
    expect(statuses(await replay(till, q))).toEqual(['rejected']); // B's key, A's pass
    await nothingSold();
    expect(statuses(await replay(tillB, q, devB))).toEqual(['done']); // the same sale is fine on its own pass
  });

  it('a pass number that does not exist', async () => {
    const q = await queue({ ...till, passId: 'nope' }, [{ payload: sale() }]);
    const r = await replay('nope', q);
    expect(r.ok).toBe(false);
    await nothingSold();
    expect((await refusals()).length).toBe(1);
  });

  it("someone else's device cannot send a till's queue, and gets the same answer as for a pass that does not exist", async () => {
    const q = await queue(till, [{ payload: sale() }]);
    const wrong = await replay(till, q, devB);
    const missing = await replay('nope', q, devB);
    expect(wrong.ok).toBe(false);
    expect(missing.ok).toBe(false);
    expect(JSON.stringify(wrong)).toBe(JSON.stringify(missing));
    await nothingSold();
    expect((await refusals()).length).toBe(2);
  });

  it('a device that is not registered', async () => {
    const q = await queue(till, [{ payload: sale() }]);
    expect((await replay(till, q, 'made-up-secret')).ok).toBe(false);
    expect((await replay(till, q, '')).ok).toBe(false);
    await nothingSold();
    expect((await refusals()).length).toBe(2);
  });

  it('a device that has been revoked', async () => {
    const q = await queue(till, [{ payload: sale() }]);
    const id = (await store.list<{ id: string; name: string }>('devices')).find((d) => d.name === 'Counter A')!.id;
    await signIn('owner', devB);
    ok(await send('owner', 'devices/revoke', { deviceId: id }, devB));
    expect((await replay(till, q, devA)).ok).toBe(false);
    await nothingSold();
  });

  it('a person who has been switched off', async () => {
    const q = await queue(till, [{ payload: sale() }]);
    ok(await send('owner', 'staff/set_active', { userId: till.userId, active: false }));
    const r = await replay(till, q);
    expect(r.ok).toBe(false);
    await nothingSold();
    expect((await refusals()).length).toBe(1);
  });

  it('a person who is no longer allowed to sell', async () => {
    const q = await queue(till, [{ payload: sale() }]);
    ok(await send('owner', 'staff/set_role', { userId: till.userId, role: 'baker' }));
    expect((await replay(till, q)).ok).toBe(false);
    await nothingSold();
  });

  it('malformed input is refused without touching anything', async () => {
    for (const bad of [null, 'x', {}, { passId: till.passId }, { passId: till.passId, actions: [] }, { passId: till.passId, actions: [{ seq: 1 }] }, { passId: till.passId, actions: [{ seq: 'a', requestId: 'r', type: 't', payload: {}, queuedAt: 'x', tag: 'y' }] }, { passId: till.passId, actions: [], extra: 1 }]) {
      const r = await panel.replayOffline(bad, devA);
      expect(r.ok).toBe(false);
    }
    const many = await queue(till, Array.from({ length: 201 }, () => ({ payload: sale() })));
    expect((await replay(till, many)).ok).toBe(false);
    await nothingSold();
  });

  it('a pass key from the wrong person or device does not verify', async () => {
    const stolen: Till = { ...till, key: await derivePassKey('whatever', till.passId, 'other-person', 'other-device') };
    expect(statuses(await replay(till, await queue(stolen, [{ payload: sale() }])))).toEqual(['rejected']);
    await nothingSold();
  });
});

describe('what the owner decides: held sales', () => {
  let till: Till;
  beforeEach(async () => {
    await enableOffline();
    till = await getPass();
  });
  const held = () => store.list<HeldAction>('heldActions');

  it('a sale whose price changed is held, not forced through; the owner sees why and approves it at today\'s price', async () => {
    const q = await queue(till, [{ payload: sale(), at: t + 5 * MIN }]);
    ok(await send('owner', 'catalogue/set_price', { combinationId: cake.combinationId, price: (cake.price ?? 0) + 500 }));
    t += HOUR;
    const r = await replay(till, q);
    expect(statuses(r)).toEqual(['held']);
    expect(results(r)[0]!.message).toMatch(/Held for the owner/);
    expect(await orders()).toHaveLength(0);
    const view = await feed<{ held: Array<{ id: string; reasons: string[]; items: string[]; expectedTotal: number; totalNow: number; canApprove: boolean; userName: string }> }>('owner', 'offline_review');
    expect(view.held).toHaveLength(1);
    expect(view.held[0]!.reasons.join(' ')).toMatch(/Prices changed/);
    expect([view.held[0]!.expectedTotal, view.held[0]!.totalNow]).toEqual([cake.price, (cake.price ?? 0) + 500]);
    expect(view.held[0]!.canApprove).toBe(true);
    expect(view.held[0]!.items[0]).toMatch(/^1 × /);

    const a = ok<{ orderId: string; number: string }>(await send('owner', 'offline/review', { heldId: view.held[0]!.id, action: 'approve' }));
    const o = (await orders())[0]!;
    expect(o.id).toBe(a.orderId);
    expect(o.createdBy).toBe(till.userId); // under the cashier's name
    expect(o.createdAt).toBe(iso(t - HOUR + 5 * MIN)); // at the time it really happened
    expect((await store.list<Payment>('payments'))[0]!.amount).toBe((cake.price ?? 0) + 500);
    expect((await feed<{ held: unknown[]; recent: Array<{ status: string }> }>('owner', 'offline_review')).held).toHaveLength(0);
    expect((await feed<{ recent: Array<{ status: string; orderId: string }> }>('owner', 'offline_review')).recent[0]).toMatchObject({ status: 'approved', orderId: a.orderId });
  });

  it('approving twice is refused, and sells once', async () => {
    const q = await queue(till, [{ payload: { ...sale(), expectedTotal: 1 } }]);
    await replay(till, q);
    const h = (await held())[0]!;
    ok(await send('owner', 'offline/review', { heldId: h.id, action: 'approve' }));
    expect(errOf(await send('owner', 'offline/review', { heldId: h.id, action: 'approve' }))).toMatch(/already been dealt with/);
    expect(await orders()).toHaveLength(1);
  });

  it('dismissing needs a note, and sells nothing', async () => {
    await replay(till, await queue(till, [{ payload: { ...sale(), expectedTotal: 1 } }]));
    const h = (await held())[0]!;
    expect(errOf(await send('owner', 'offline/review', { heldId: h.id, action: 'dismiss' }))).toMatch(/note/);
    ok(await send('owner', 'offline/review', { heldId: h.id, action: 'dismiss', note: 'Customer left without it' }));
    expect(await orders()).toHaveLength(0);
    const row = (await held())[0]!;
    expect([row.status, row.note]).toEqual(['dismissed', 'Customer left without it']);
    expect(row.resolvedByName).toBeTruthy();
  });

  it('only the owner can review', async () => {
    await replay(till, await queue(till, [{ payload: { ...sale(), expectedTotal: 1 } }]));
    const h = (await held())[0]!;
    await signIn('cashier', devA);
    expect(errOf(await send('cashier', 'offline/review', { heldId: h.id, action: 'approve' }))).toMatch(/forbidden/);
    expect((await panel.feed('offline_review', {}, sid.cashier)).ok).toBe(false);
    expect(await orders()).toHaveLength(0);
  });

  it('an item that is gone is held, cannot be approved, and can be dismissed', async () => {
    const product = (await store.list<{ id: string; name: string }>('products'))[0]!;
    const comboProduct = (await store.list<{ id: string; productId: string }>('combinations')).find((c) => c.id === cake.combinationId)!.productId;
    const q = await queue(till, [{ payload: sale() }]);
    void product;
    ok(await send('owner', 'catalogue/archive_product', { productId: comboProduct }));
    const r = await replay(till, q);
    expect(statuses(r)).toEqual(['held']);
    const h = (await held())[0]!;
    expect(errOf(await send('owner', 'offline/review', { heldId: h.id, action: 'approve' }))).toMatch(/archived|no longer/);
    expect((await held())[0]!.status).toBe('held'); // a failed approval changes nothing
    ok(await send('owner', 'offline/review', { heldId: h.id, action: 'dismiss', note: 'Product was removed' }));
  });

  it('a payment method the shop stopped taking is held', async () => {
    ok(await send('owner', 'settings/update', { paymentMethods: ['mobile_money'] }));
    expect(statuses(await replay(till, await queue(till, [{ payload: sale(1, cake, 'cash') }])))).toEqual(['held']);
  });

  it('limits: sales past the count are held, and the chain carries on so later sales are not blocked by them', async () => {
    await enableOffline({ offlineMaxSales: 2 });
    till = await getPass();
    const q = await queue(till, [{ payload: sale() }, { payload: sale() }, { payload: sale() }]);
    expect(statuses(await replay(till, q))).toEqual(['done', 'done', 'held']);
    expect((await held())[0]!.reasons.join(' ')).toMatch(/limit of 2 sales/);
    expect((await passRow(till.passId)).nextSeq).toBe(4);
  });

  it('limits: money past the total is held', async () => {
    const price = cake.price ?? 1000;
    await enableOffline({ offlineMaxTotal: price * 2 + 1 });
    till = await getPass();
    const q = await queue(till, [{ payload: sale(2) }, { payload: sale(1) }]);
    expect(statuses(await replay(till, q))).toEqual(['done', 'held']);
    expect((await held())[0]!.reasons.join(' ')).toMatch(/over the limit/);
  });

  it('a held sale does not use up the limits', async () => {
    await enableOffline({ offlineMaxSales: 1 });
    till = await getPass();
    const q = await queue(till, [{ payload: { ...sale(), expectedTotal: 1 } }, { payload: sale() }]);
    expect(statuses(await replay(till, q))).toEqual(['held', 'done']);
  });

  it('a sale with no total shown to the customer is held', async () => {
    const { expectedTotal: _drop, ...bare } = sale();
    expect(statuses(await replay(till, await queue(till, [{ payload: bare }])))).toEqual(['held']);
    expect((await held())[0]!.reasons.join(' ')).toMatch(/total the customer was shown/);
  });

  it('a sale that does not fit the shape of a sale is held with plain reasons, never run', async () => {
    expect(statuses(await replay(till, await queue(till, [{ payload: { items: [], method: 'cash', expectedTotal: 0 } }])))).toEqual(['held']);
    expect(await orders()).toHaveLength(0);
  });

  it('any other kind of action, even correctly signed, is held and cannot be approved', async () => {
    const q = await queue(till, [{ type: 'payments/approve_refund', payload: { orderId: 'x', amount: 1, reason: 'r', method: 'cash' } }]);
    expect(statuses(await replay(till, q))).toEqual(['held']);
    const h = (await held())[0]!;
    expect(h.reasons.join(' ')).toMatch(/not allowed offline/);
    expect(errOf(await send('owner', 'offline/review', { heldId: h.id, action: 'approve' }))).toMatch(/cannot be approved/);
    expect(await store.list('refunds')).toHaveLength(0);
  });

  describe('time', () => {
    it('made before the pass was issued', async () => {
      expect(statuses(await replay(till, await queue(till, [{ payload: sale(), at: t - 20 * MIN }])))).toEqual(['held']);
      expect((await held())[0]!.reasons.join(' ')).toMatch(/before it was given permission/);
    });
    it('made after the pass ran out', async () => {
      t += 20 * HOUR;
      expect(statuses(await replay(till, await queue(till, [{ payload: sale(), at: Date.parse(till.expiresAt) + 30 * MIN }])))).toEqual(['held']);
      expect((await held())[0]!.reasons.join(' ')).toMatch(/ran out/);
    });
    it('made in the future', async () => {
      expect(statuses(await replay(till, await queue(till, [{ payload: sale(), at: t + 2 * HOUR }])))).toEqual(['held']);
      expect((await held())[0]!.reasons.join(' ')).toMatch(/clock is ahead/);
    });
    it('a small clock difference is allowed', async () => {
      expect(statuses(await replay(till, await queue(till, [{ payload: sale(), at: t - 3 * MIN }])))).toEqual(['done']);
    });
    it('time going backwards along the chain', async () => {
      t += 2 * HOUR;
      const q = await queue(till, [{ payload: sale(), at: t - 30 * MIN }, { payload: sale(), at: t - 60 * MIN }]);
      expect(statuses(await replay(till, q))).toEqual(['done', 'held']);
      expect((await held())[0]!.reasons.join(' ')).toMatch(/before the sale that came before/);
    });
    it('records when the server received it next to when the till says it was made', async () => {
      await replay(till, await queue(till, [{ payload: { ...sale(), expectedTotal: 1 }, at: t + MIN }]));
      const h = (await held())[0]!;
      expect([h.queuedAt, h.receivedAt]).toEqual([iso(t + MIN), iso()]);
    });
  });

  describe('a newer pass replaces the old one', () => {
    it('sales made before the replacement count; sales dated after it do not', async () => {
      const q = await queue(till, [{ payload: sale(), at: t + MIN }, { payload: sale(), at: t + 30 * MIN }]);
      t += 10 * MIN;
      const fresh = await getPass();
      expect(fresh.passId).not.toBe(till.passId);
      expect((await passRow(till.passId)).closedAt).toBe(iso());
      t += HOUR;
      expect(statuses(await replay(till, q))).toEqual(['done', 'held']);
      expect((await held())[0]!.reasons.join(' ')).toMatch(/newer offline permission/);
    });
    it('the old key does not work on the new pass', async () => {
      const fresh = await getPass();
      const q = await queue({ ...fresh, key: till.key }, [{ payload: sale() }]);
      expect(statuses(await replay(fresh, q))).toEqual(['rejected']);
    });
    it('only one pass is open per device', async () => {
      await getPass();
      await getPass();
      const open = (await store.list<OfflinePass>('offlinePasses')).filter((p) => !p.closedAt);
      expect(open).toHaveLength(1);
    });
  });
});

describe('the owner is told', () => {
  it('shows open passes with how much was sold under each, and nothing once they expire or are replaced', async () => {
    await enableOffline();
    const till = await getPass();
    await replay(till, await queue(till, [{ payload: sale() }]));
    const v = await feed<{ passes: Array<{ sales: number; total: number; deviceName: string }> }>('owner', 'offline_review');
    expect(v.passes).toHaveLength(1);
    expect([v.passes[0]!.sales, v.passes[0]!.total, v.passes[0]!.deviceName]).toEqual([1, cake.price, 'Counter A']);
    t += 13 * HOUR;
    await signIn('owner', devA);
    expect((await feed<{ passes: unknown[] }>('owner', 'offline_review')).passes).toHaveLength(0);
  });
});

describe('selling online, with the total shown', () => {
  it('goes through when the total matches, and is refused with a clear message when prices moved', async () => {
    ok(await send('cashier', 'orders/quick_sale', sale() as never, devA));
    ok(await send('owner', 'catalogue/set_price', { combinationId: cake.combinationId, price: (cake.price ?? 0) + 100 }));
    expect(errOf(await send('cashier', 'orders/quick_sale', sale() as never, devA))).toMatch(/Prices changed/);
    expect(await orders()).toHaveLength(1);
  });
  it('is not required for an ordinary online sale', async () => {
    const { expectedTotal: _d, ...bare } = sale();
    ok(await send('cashier', 'orders/quick_sale', bare as never, devA));
  });
});

describe('the sale reads the same as any other', () => {
  it('a replayed sale shows up as a finished instant order with its receipt', async () => {
    await enableOffline();
    const till = await getPass();
    const r = results(await replay(till, await queue(till, [{ payload: sale() }])));
    const card = await feed<OrderCardData>('cashier', 'order_card', { orderId: r[0]!.orderId });
    expect(card.number).toBe(r[0]!.number);
    expect(card.payments.length).toBe(1);
  });
});

describe('the signing code', () => {
  it('gives the published SHA-256 and HMAC-SHA-256 test values', async () => {
    const { sha256Bytes, hmacSha256Bytes } = await import('./offline-proof');
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(hex(sha256Bytes(enc('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256Bytes(enc('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256Bytes(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    // RFC 4231 test case 2
    expect(hex(hmacSha256Bytes(enc('Jefe'), enc('what do ya want for nothing?')))).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    // RFC 4231 test case 6: a key longer than one block
    expect(hex(hmacSha256Bytes(new Uint8Array(131).fill(0xaa), enc('Test Using Larger Than Block-Size Key - Hash Key First')))).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  });

  it('agrees with the platform on random inputs, including every length around a block boundary', async () => {
    const { hmacHexSync, bytesToBase64Local } = await import('./offline-proof');
    const subtle = globalThis.crypto.subtle;
    for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const key = globalThis.crypto.getRandomValues(new Uint8Array(1 + (n % 97)));
      const msg = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => String.fromCharCode(b)).join('') + 'é€😀';
      const k = await subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const expected = Array.from(new Uint8Array(await subtle.sign('HMAC', k, new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, '0')).join('');
      expect(hmacHexSync(bytesToBase64Local(key), msg)).toBe(expected);
    }
  });
});
