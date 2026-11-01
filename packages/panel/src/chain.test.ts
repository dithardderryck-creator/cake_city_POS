import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, createPanel, seedDemo, verifyChain, linkId, DEMO_STAFF, type DispatchResult, type Panel, type Staff, type Store } from './index';
import type { AuditEntry, ChainHead, ChainLink } from './domain';
import { createIds } from './index';

let t = Date.UTC(2026, 9, 27, 8, 0, 0);
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;
const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const id = async (role: string) => (await store.list<Staff>('staff')).find((s) => s.role === role)!.id;
async function signIn(role: string, p = panel) {
  return ok<{ sessionId: string }>(await p.dispatch('auth/sign_in', { userId: await id(role), pin: DEMO_STAFF.find((s) => s.role === role)!.pin })).sessionId;
}
const env = () => ({ store, ids: createIds(), clock });
const head = async () => (await store.get<ChainHead>('chainHead', 'head'))!;
const link = async (n: number) => (await store.get<ChainLink>('chain', linkId(n)))!;

beforeEach(async () => {
  t = Date.UTC(2026, 9, 27, 8, 0, 0);
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  await seedDemo(store, panel);
});

describe('every action is sealed', () => {
  it('adds one link per audit entry and the chain checks out', async () => {
    const owner = await signIn('owner');
    ok(await panel.dispatch('staff/create', { name: 'Zawadi', role: 'cashier', pin: '5555' }, owner));
    const audits = (await store.list<AuditEntry>('audit')).length;
    expect((await head()).seq).toBe(audits);
    const r = await verifyChain(env(), { full: true });
    expect(r).toMatchObject({ ok: true, problems: [] });
    expect(r.checked).toBe(audits);
  });

  it('seals refusals too, not only what worked', async () => {
    const cashier = await signIn('cashier');
    const before = (await head()).seq;
    expect((await panel.dispatch('staff/create', { name: 'X', role: 'baker', pin: '5555' }, cashier)).ok).toBe(false);
    expect((await head()).seq).toBe(before + 1);
    expect((await link(before + 1)).outcome).toBe('denied');
  });

  it('keeps no details in the chain: no names, no summaries', async () => {
    const owner = await signIn('owner');
    ok(await panel.dispatch('staff/create', { name: 'Secret Name', role: 'cashier', pin: '5555' }, owner));
    const links = await store.list<ChainLink>('chain');
    expect(JSON.stringify(links)).not.toMatch(/Secret Name|Added /);
  });

  it('seals the action and its record together, or neither', async () => {
    const owner = await signIn('owner');
    const before = { audit: (await store.list('audit')).length, chain: (await head()).seq, staff: (await store.list('staff')).length };
    // A store that fails when the seal is written, as a crash or a full disk would.
    let failOnce = true;
    const flaky: Store = { ...store, put: async (c, r) => (c === 'chain' && failOnce ? ((failOnce = false), Promise.reject(new Error('disk full'))) : store.put(c, r)) } as Store;
    const p2 = createPanel({ store: flaky, clock });
    const r = await p2.dispatch('staff/create', { name: 'Ghost', role: 'cashier', pin: '5555' }, owner);
    expect(r.ok).toBe(false);
    expect((await store.list('staff')).length).toBe(before.staff);
    // Nothing of the action stays. The one thing written afterwards is the note that it failed, sealed like any other.
    expect((await store.list('audit')).length).toBe(before.audit + 1);
    expect((await head()).seq).toBe(before.chain + 1);
    expect((await link(before.chain + 1)).outcome).toBe('error');
    // The next attempt works, and the chain still checks out.
    ok(await p2.dispatch('staff/create', { name: 'Ghost', role: 'cashier', pin: '5555' }, owner));
    expect((await verifyChain(env(), { full: true })).ok).toBe(true);
  });
});

describe('a change is noticed', () => {
  beforeEach(async () => {
    const owner = await signIn('owner');
    for (let i = 0; i < 5; i++) ok(await panel.dispatch('staff/create', { name: `P${i}`, role: 'cashier', pin: '5555' }, owner));
    expect((await verifyChain(env(), { full: true })).ok).toBe(true);
  });

  it('an entry that was edited', async () => {
    const [a] = await store.find<AuditEntry>('audit', { where: { intent: 'staff/create' }, limit: 1 });
    await store.put('audit', { ...a!, summary: 'Added nobody' });
    const r = await verifyChain(env(), { full: true });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/changed after it was sealed/);
  });

  it('a link that was removed from the middle', async () => {
    await store.delete('chain', linkId(4));
    const r = await verifyChain(env(), { full: true });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/Record 4 is missing/);
  });

  it('a link that was edited', async () => {
    await store.put('chain', { ...(await link(3)), kind: 'something/else' });
    const r = await verifyChain(env(), { full: true });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/Record 3 .*changed/);
  });

  it('two links swapped', async () => {
    const a = await link(3);
    const b = await link(4);
    await store.put('chain', { ...b, id: a.id, seq: 3 });
    await store.put('chain', { ...a, id: b.id, seq: 4 });
    expect((await verifyChain(env(), { full: true })).ok).toBe(false);
  });

  it('the end cut off', async () => {
    const h = await head();
    await store.put('chainHead', { ...h, seq: h.seq - 2, hash: (await link(h.seq - 2)).hash });
    const r = await verifyChain(env(), { full: true });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/after the end/);
  });

  it('an entry slipped in with no seal, found by the full check', async () => {
    await store.put<AuditEntry>('audit', { id: 'aud_fake', at: '2026-10-27T07:00:00.000Z', actorName: 'Nobody', intent: 'payments/approve_refund', summary: 'Refunded everything', outcome: 'ok' });
    const q = await verifyChain(env(), { full: true });
    expect(q.ok).toBe(false);
    expect(q.problems.join(' ')).toMatch(/no seal/);
  });

  it('details moved to the archive are reported, not called tampering', async () => {
    const [a] = await store.find<AuditEntry>('audit', { orderBy: { field: 'at', dir: 'asc' }, limit: 1 });
    await store.delete('audit', a!.id);
    const r = await verifyChain(env(), { full: true });
    expect(r).toMatchObject({ ok: true, detailsGone: 1 });
  });

  it('the quick check starts from the last good point, and still catches a changed anchor', async () => {
    const first = await verifyChain(env());
    expect(first.ok).toBe(true);
    const owner = await signIn('owner');
    ok(await panel.dispatch('staff/create', { name: 'Late', role: 'baker', pin: '5555' }, owner));
    const second = await verifyChain(env());
    expect(second.ok).toBe(true);
    expect(second.checked).toBeLessThan((await head()).seq / 2);
    // Rewriting the point it started from is noticed.
    await store.put('chain', { ...(await link(second.upTo)), kind: 'x/y' });
    expect((await verifyChain(env())).ok).toBe(false);
  });

  it('the full check finds an old entry the quick check does not look at again, and says so honestly', async () => {
    await verifyChain(env());
    const [a] = await store.find<AuditEntry>('audit', { orderBy: { field: 'at', dir: 'asc' }, limit: 1 });
    await store.put('audit', { ...a!, summary: 'Changed long ago' });
    expect((await verifyChain(env(), { full: true })).ok).toBe(false);
  });
});

describe('IT reads the records', () => {
  it('shows money and stock as a sealed signal and everything else in plain words', async () => {
    const owner = await signIn('owner');
    ok(await panel.dispatch('staff/create', { name: 'Zawadi', role: 'cashier', pin: '5555' }, owner));
    ok(await panel.dispatch('staff/set_pin', { userId: await id('baker'), pin: '3434' }, owner));
    const it = await signIn('it');
    const r = await panel.feed('records_view', {}, it);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const added = r.data.rows.find((x) => x.intent === 'staff/create')!;
    expect(added.sealed).toBe(false);
    expect(added.summary).toMatch(/Added Zawadi/);
    expect(added.ref).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(r.data.chain.sealed).toBeGreaterThan(0);
  });

  it('hides what a sealed record says until it is opened, and opening is itself sealed', async () => {
    const cashier = await signIn('cashier');
    const grid = await panel.feed('catalogue_grid', {}, cashier);
    const combo = grid.ok ? grid.data.flatMap((p) => p.combinations).find((c) => c.sellable && c.price) : undefined;
    const o = ok<{ orderId: string }>(await panel.dispatch('orders/create_order', { source: 'walk_in', fulfilment: 'pickup', customerName: 'Joe', deliveryDate: '2026-10-27' }, cashier));
    ok(await panel.dispatch('orders/add_catalogue_line', { orderId: o.orderId, combinationId: combo!.combinationId, qty: 1 }, cashier));
    const it = await signIn('it');
    const list = await panel.feed('records_view', {}, it);
    const sealed = list.ok ? list.data.rows.find((x) => x.sealed) : undefined;
    expect(sealed).toBeTruthy();
    expect(sealed!.summary).toBeNull();
    const before = (await head()).seq;
    const opened = ok<{ summary: string; intact: boolean; ref: string }>(await panel.dispatch('records/open', { seq: sealed!.seq }, it));
    expect(opened.summary).toBeTruthy();
    expect(opened.intact).toBe(true);
    expect(opened.ref).toBe(sealed!.ref);
    expect((await head()).seq).toBe(before + 1);
    const again = await panel.feed('records_view', { kind: 'opened' }, it);
    expect(again.ok && again.data.rows.map((x) => x.summary)).toEqual([`Opened record ${sealed!.ref}`]);
  });

  it('refuses a record that does not exist', async () => {
    const it = await signIn('it');
    expect((await panel.dispatch('records/open', { seq: 99999 }, it)).ok).toBe(false);
  });

  it('pages back through the whole chain, past 200', async () => {
    const owner = await signIn('owner');
    for (let i = 0; i < 230; i++) await panel.dispatch('staff/set_pin', { userId: await id('baker'), pin: '3333' }, owner);
    const it = await signIn('it');
    let before: number | undefined;
    let seen = 0;
    let pages = 0;
    const seqs = new Set<number>();
    for (;;) {
      const r = await panel.feed('records_view', before ? { before } : {}, it);
      if (!r.ok) throw new Error('feed failed');
      r.data.rows.forEach((x) => seqs.add(x.seq));
      seen += r.data.rows.length;
      pages++;
      if (r.data.nextBefore === null) break;
      before = r.data.nextBefore;
    }
    expect(seen).toBe((await head()).seq);
    expect(seqs.size).toBe(seen);
    expect(pages).toBeGreaterThan(5);
  });

  it('can show only what was refused', async () => {
    const cashier = await signIn('cashier');
    await panel.dispatch('staff/create', { name: 'X', role: 'baker', pin: '5555' }, cashier);
    const it = await signIn('it');
    const r = await panel.feed('records_view', { kind: 'refused' }, it);
    expect(r.ok && r.data.rows.every((x) => x.outcome !== 'ok')).toBe(true);
    expect(r.ok && r.data.rows.length).toBeGreaterThan(0);
  });

  it('is for IT alone; the owner has her own read-only list of what IT did', async () => {
    for (const role of ['owner', 'cashier', 'baker', 'inventory']) {
      const sid = await signIn(role);
      expect((await panel.feed('records_view', {}, sid)).ok).toBe(false);
      expect((await panel.dispatch('records/open', { seq: 1 }, sid)).ok).toBe(false);
      expect((await panel.dispatch('records/verify', {}, sid)).ok).toBe(false);
    }
    const it = await signIn('it');
    for (let i = 0; i < 5; i++) await panel.dispatch('auth/sign_in', { userId: await id('baker'), pin: '0000' });
    ok(await panel.dispatch('staff/unlock', { userId: await id('baker') }, it));
    const owner = await signIn('owner');
    const mine = await panel.feed('it_activity', {}, owner);
    expect(mine.ok && mine.data.rows.length).toBeGreaterThan(0);
    expect(mine.ok && mine.data.rows.every((x) => !/Amina/.test(x.who))).toBe(true);
    expect((await panel.feed('it_activity', {}, await signIn('cashier'))).ok).toBe(false);
    expect((await panel.feed('it_activity', {}, it)).ok).toBe(false);
  });
});

describe('the check runs by itself', () => {
  it('checks once a day and writes that down, without being asked', async () => {
    await signIn('owner');
    await panel.tick();
    const first = await store.get<{ id: string; at: string }>('chainChecks', 'last');
    expect(first).toBeTruthy();
    const n = (await store.list('audit')).length;
    await panel.tick();
    expect((await store.list('audit')).length).toBe(n);
    t += 24 * 3_600_000;
    await panel.tick();
    const second = await store.get<{ id: string; at: string }>('chainChecks', 'last');
    expect(second!.at > first!.at).toBe(true);
    const audits = await store.find<AuditEntry>('audit', { where: { intent: 'records/verify' } });
    expect(audits.some((a) => /daily/.test(a.summary))).toBe(true);
  });

  it('rings IT, and only IT, when the records no longer match', async () => {
    await signIn('owner');
    const [a] = await store.find<AuditEntry>('audit', { orderBy: { field: 'at', dir: 'asc' }, limit: 1 });
    await panel.tick();
    await store.put('audit', { ...a!, summary: 'Changed by hand' });
    t += 24 * 3_600_000;
    await verifyChain(env(), { full: true });
    await panel.tick();
    const it = await signIn('it');
    const inbox = await panel.feed('alert_inbox', {}, it);
    expect(inbox.ok && inbox.data.open.map((x) => x.title)).toContain('The sealed records do not match');
    for (const role of ['owner', 'cashier']) {
      const other = await panel.feed('alert_inbox', {}, await signIn(role));
      expect(other.ok && other.data.open.map((x) => x.title)).not.toContain('The sealed records do not match');
    }
    const notice = await panel.feed('system_notice', {}, await signIn('owner'));
    expect(notice.ok && notice.data.openForDay).toBe(false);
  });
});
