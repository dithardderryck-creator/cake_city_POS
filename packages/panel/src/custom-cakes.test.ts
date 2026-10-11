import { beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryStore,
  createPanel,
  seedDemo,
  DEMO_STAFF,
  type CakeSpecInput,
  type DispatchResult,
  type OrderCardData,
  type Panel,
  type Staff,
  type Store,
} from './index';

/* 2026-09-29 08:00 UTC. Dates below are days ahead of that, far from midnight in any time zone. */
let t: number;
const clock = { now: () => new Date(t) };
let store: Store;
let panel: Panel;

const sid: Record<string, string> = {};
async function signIn(role: (typeof DEMO_STAFF)[number]['role']) {
  const pin = DEMO_STAFF.find((s) => s.role === role)!.pin;
  const staff = (await store.list<Staff>('staff')).find((s) => s.role === role)!;
  const r = await panel.dispatch('auth/sign_in', { userId: staff.id, pin });
  if (!r.ok) throw new Error('sign in failed');
  sid[role] = (r.data as { sessionId: string }).sessionId;
}

const ok = <T = unknown>(r: DispatchResult) => {
  if (!r.ok) throw new Error(`Expected ok, got ${r.error.code}: ${r.error.messages.join(' ')}`);
  return r.data as T;
};
const errOf = (r: DispatchResult) => (r.ok ? '' : `${r.error.code}: ${r.error.messages.join(' ')}`);

type Role = 'owner' | 'cashier' | 'baker';
const send = <K extends Parameters<Panel['dispatch']>[0]>(role: Role, type: K, payload: Parameters<Panel['dispatch']>[1]) =>
  panel.dispatch(type, payload as never, sid[role]);

const SPEC: CakeSpecInput = { servings: 12, flavor: 'Chocolate', filling: 'Vanilla cream', layers: 2, dietary: ['eggless'], inscription: 'Happy Birthday Zawadi', allergyNotes: 'No nuts' };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

async function orderWithCake(opts: { date?: string; fulfilment?: 'pickup' | 'delivery' } = {}) {
  const fulfilment = opts.fulfilment ?? 'pickup';
  const { orderId } = ok<{ orderId: string }>(
    await send('cashier', 'orders/create_order', {
      customerName: 'Zawadi',
      source: 'phone',
      fulfilment,
      deliveryDate: opts.date ?? '2026-10-05',
      deliveryAddress: fulfilment === 'delivery' ? '12 Baker Street' : undefined,
    }),
  );
  const { lineId } = ok<{ lineId: string }>(await send('cashier', 'orders/add_custom_line', { orderId, spec: SPEC }));
  return { orderId, lineId };
}

async function quoted(price = 120) {
  const o = await orderWithCake();
  const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId: o.orderId, lineId: o.lineId, note: 'Customer wants pink roses' }));
  ok(await send('owner', 'quotes/provide', { quoteId, price }));
  return { ...o, quoteId };
}

async function card(role: Role, orderId: string) {
  const r = await panel.feed('order_card', { orderId }, sid[role]);
  if (!r.ok) throw new Error(`card failed: ${r.error.messages.join(' ')}`);
  return r.data as OrderCardData;
}

beforeEach(async () => {
  t = Date.UTC(2026, 8, 29, 8, 0, 0);
  store = createMemoryStore();
  panel = createPanel({ store, clock });
  await seedDemo(store, panel);
  for (const r of ['owner', 'cashier', 'baker'] as const) await signIn(r);
});

describe('a custom cake from request to handover', () => {
  it('goes draft, quote, pay, bake, hand over, and the order completes', async () => {
    const { orderId, lineId } = await orderWithCake();
    let c = await card('cashier', orderId);
    expect(c.lines[0]).toMatchObject({ kind: 'custom', status: 'draft', totalLabel: 'Not priced yet', canRequestQuote: true, canEdit: true });
    expect(c.lines[0]!.cake).toMatchObject({ servings: 12, flavor: 'Chocolate', layers: 2, dietary: ['eggless'], allergyNotes: 'No nuts' });
    expect(c.quotePending).toBe(true);
    expect(c.canRecordPayment).toBe(false);
    expect(errOf(await send('cashier', 'payments/record_payment', { orderId, method: 'cash', amount: 10, allowPartial: true }))).toMatch(/no price yet/);
    expect(await store.list('payments')).toHaveLength(0);

    const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId, note: 'Pink roses please' }));
    expect(errOf(await send('cashier', 'payments/record_payment', { orderId, method: 'cash', amount: 10, allowPartial: true }))).toMatch(/no price yet/);
    c = await card('cashier', orderId);
    expect(c.status).toBe('awaiting_quote');
    expect(c.needsQuote).toBe(true);
    expect(c.lines[0]!.quote).toMatchObject({ status: 'sent', note: 'Pink roses please' });
    expect(c.lines[0]!.canWithdrawQuote).toBe(true);

    ok(await send('owner', 'quotes/mark_seen', { quoteId }));
    const seen = (await card('cashier', orderId)).lines[0]!.quote!;
    expect(seen.status).toBe('seen');

    ok(await send('owner', 'quotes/provide', { quoteId, price: 120, note: 'Includes the roses' }));
    c = await card('cashier', orderId);
    expect(c).toMatchObject({ status: 'new', total: 120, quotePending: false, canRecordPayment: true });
    expect(c.lines[0]).toMatchObject({ totalLabel: 'TSh 120', quote: { status: 'quoted', priceLabel: 'TSh 120', answer: 'Includes the roses' } });

    ok(await send('cashier', 'payments/record_payment', { orderId, method: 'cash', amount: 120 }));

    // The baker sees it and does the baking steps.
    const q = await panel.feed('bake_queue', {}, sid.baker);
    if (!q.ok) throw new Error('queue failed');
    expect(q.data.rows).toHaveLength(1);
    expect(q.data.rows[0]).toMatchObject({ lineId, orderNumber: c.number, dueLabel: 'In 6 days', status: 'new', actions: [{ to: 'in_production' }] });
    expect(q.data.rows[0]!.cake.inscription).toBe('Happy Birthday Zawadi');

    ok(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'in_production' }));
    expect((await card('cashier', orderId)).status).toBe('in_production');
    ok(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'ready' }));
    expect((await card('cashier', orderId)).status).toBe('ready');

    // Handover belongs to the front desk, not the kitchen.
    expect(errOf(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'completed' }))).toMatch(/invalid/);
    ok(await send('cashier', 'orders/advance_line', { orderId, lineId, to: 'completed' }));
    expect(await card('cashier', orderId)).toMatchObject({ status: 'completed', paymentStatus: 'paid' });
    expect(await store.list('stockMovements')).toHaveLength(await countAdjustments());
  });

  it('only passes through Decorating when the owner turns that stage on', async () => {
    const { orderId, lineId } = await quoted();
    ok(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'in_production' }));
    expect(errOf(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'decorating' }))).toMatch(/invalid/);

    ok(await send('owner', 'settings/update', { decoratingStage: true }));
    const q = await panel.feed('bake_queue', {}, sid.baker);
    if (!q.ok) throw new Error('queue failed');
    expect(q.data.decoratingStage).toBe(true);
    expect(q.data.rows[0]!.actions.map((a) => a.to)).toEqual(['decorating']);
    expect(errOf(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'ready' }))).toMatch(/invalid/);
    ok(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'decorating' }));
    ok(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'ready' }));
  });

  it('sends a delivery cake out and records it delivered', async () => {
    const o = await orderWithCake({ fulfilment: 'delivery' });
    const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId: o.orderId, lineId: o.lineId }));
    ok(await send('owner', 'quotes/provide', { quoteId, price: 90 }));
    ok(await send('baker', 'orders/advance_line', { orderId: o.orderId, lineId: o.lineId, to: 'in_production' }));
    ok(await send('baker', 'orders/advance_line', { orderId: o.orderId, lineId: o.lineId, to: 'ready' }));
    expect(errOf(await send('cashier', 'orders/advance_line', { orderId: o.orderId, lineId: o.lineId, to: 'completed' }))).toMatch(/invalid/);
    ok(await send('cashier', 'orders/advance_line', { orderId: o.orderId, lineId: o.lineId, to: 'out_for_delivery' }));
    const done = await send('cashier', 'orders/advance_line', { orderId: o.orderId, lineId: o.lineId, to: 'completed' });
    expect(done.ok).toBe(true);
    expect(done.ok && done.warnings.join(' ')).toMatch(/unpaid/); // Q-01: allowed, with a warning
  });
});

async function countAdjustments() {
  // Seeding sets stock counts through adjustments. Handing over a custom cake must add no movement of its own.
  return (await store.list<{ id: string; reason: string }>('stockMovements')).filter((m) => m.reason === 'adjustment').length;
}

describe('who may do what', () => {
  it('keeps pricing, baking and money in the right hands', async () => {
    const { orderId, lineId } = await orderWithCake();
    const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId }));
    expect(errOf(await send('cashier', 'quotes/provide', { quoteId, price: 50 }))).toMatch(/^forbidden/);
    expect(errOf(await send('baker', 'quotes/provide', { quoteId, price: 50 }))).toMatch(/^forbidden/);
    expect(errOf(await send('baker', 'quotes/request', { orderId, lineId }))).toMatch(/^forbidden/);
    expect(errOf(await send('cashier', 'settings/update', { decoratingStage: true }))).toMatch(/^forbidden/);

    ok(await send('owner', 'quotes/provide', { quoteId, price: 50 }));
    expect(errOf(await send('cashier', 'orders/advance_line', { orderId, lineId, to: 'in_production' }))).toMatch(/invalid/);
    const feed = await panel.feed('order_card', { orderId }, sid.baker);
    expect(feed.ok).toBe(false); // the baker never sees prices or payments
    const inbox = await panel.feed('quote_inbox', {}, sid.baker);
    expect(inbox.ok).toBe(false);
  });

  it('stops the baker moving catalogue items', async () => {
    const g = await panel.feed('catalogue_grid', {}, sid.cashier);
    if (!g.ok) throw new Error('grid');
    const combo = g.data[0]!.combinations.find((c) => c.sellable)!;
    const { orderId } = ok<{ orderId: string }>(await send('cashier', 'orders/create_order', { source: 'walk_in', fulfilment: 'pickup' }));
    const { lineId } = ok<{ lineId: string }>(await send('cashier', 'orders/add_catalogue_line', { orderId, combinationId: combo.combinationId, qty: 1 }));
    expect(errOf(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'ready' }))).toMatch(/invalid/);
    ok(await send('cashier', 'orders/advance_line', { orderId, lineId, to: 'ready' }));
  });
});

describe('the quote conversation', () => {
  it('needs a delivery date before the owner is asked', async () => {
    const { orderId } = ok<{ orderId: string }>(await send('cashier', 'orders/create_order', { source: 'phone', fulfilment: 'pickup' }));
    const { lineId } = ok<{ lineId: string }>(await send('cashier', 'orders/add_custom_line', { orderId, spec: SPEC }));
    expect(errOf(await send('cashier', 'quotes/request', { orderId, lineId }))).toMatch(/delivery date/);
    const c = await card('cashier', orderId);
    expect(c.lines[0]).toMatchObject({ canRequestQuote: false, quoteBlockedReason: expect.stringMatching(/delivery date/) });
    ok(await send('cashier', 'orders/set_delivery', { orderId, deliveryDate: '2026-10-08' }));
    ok(await send('cashier', 'quotes/request', { orderId, lineId }));
  });

  it('shows the owner an inbox, soonest delivery first', async () => {
    const a = await orderWithCake({ date: '2026-10-20' });
    const b = await orderWithCake({ date: '2026-10-02' });
    ok(await send('cashier', 'quotes/request', { orderId: a.orderId, lineId: a.lineId }));
    t += 60_000;
    ok(await send('cashier', 'quotes/request', { orderId: b.orderId, lineId: b.lineId }));
    const r = await panel.feed('quote_inbox', {}, sid.owner);
    if (!r.ok) throw new Error('inbox');
    expect(r.data.open.map((x) => x.deliveryDate)).toEqual(['2026-10-02', '2026-10-20']);
    expect(r.data.open[0]).toMatchObject({ customerName: 'Zawadi', status: 'sent', requestedByName: 'Baraka (Cashier)' });
    expect(r.data.open[0]!.cake.flavor).toBe('Chocolate');
    expect(r.data.can).toEqual({ provide: true, withdraw: true });
    const cashierView = await panel.feed('quote_inbox', {}, sid.cashier);
    expect(cashierView.ok && cashierView.data.can.provide).toBe(false);
  });

  it('lets the owner decline with a reason; the cake goes back to draft and can be asked again', async () => {
    const { orderId, lineId } = await orderWithCake();
    const first = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId }));
    expect(errOf(await send('owner', 'quotes/decline', { quoteId: first.quoteId, reason: '  ' }))).toMatch(/Say why/);
    ok(await send('owner', 'quotes/decline', { quoteId: first.quoteId, reason: 'Too many layers for that date' }));
    let c = await card('cashier', orderId);
    expect(c.lines[0]).toMatchObject({ status: 'draft', canEdit: true, quote: { status: 'declined', answer: 'Too many layers for that date' } });
    ok(await send('cashier', 'orders/update_custom_line', { orderId, lineId, spec: { ...SPEC, layers: 1 } }));
    const second = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId }));
    expect(second.quoteId).not.toBe(first.quoteId);
    c = await card('cashier', orderId);
    expect(c.lines[0]!.quote).toMatchObject({ quoteId: second.quoteId, status: 'sent' });
    expect(errOf(await send('owner', 'quotes/provide', { quoteId: first.quoteId, price: 10 }))).toMatch(/already closed/);
  });

  it('lets the sender or the owner withdraw, but not someone else, and not after the answer', async () => {
    const { orderId, lineId } = await orderWithCake();
    const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId }));
    // A second cashier is not the sender.
    const other = (await store.list<Staff>('staff')).find((s) => s.role === 'cashier')!;
    await panel.dispatch('staff/create', { name: 'Second Cashier', role: 'cashier', pin: '5555' }, sid.owner);
    const created = (await store.list<Staff>('staff')).find((s) => s.name === 'Second Cashier')!;
    expect(created.id).not.toBe(other.id);
    const s2 = ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: created.id, pin: '5555' }));
    expect(errOf(await panel.dispatch('quotes/withdraw', { quoteId }, s2.sessionId))).toMatch(/Only the person who asked/);

    ok(await send('cashier', 'quotes/withdraw', { quoteId }));
    expect((await card('cashier', orderId)).lines[0]).toMatchObject({ status: 'draft', quote: { status: 'withdrawn' } });
    expect(errOf(await send('cashier', 'quotes/withdraw', { quoteId }))).toMatch(/already closed/);
  });

  it('treats opening a request twice as harmless', async () => {
    const { orderId, lineId } = await orderWithCake();
    const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId }));
    ok(await send('owner', 'quotes/mark_seen', { quoteId }));
    ok(await send('owner', 'quotes/mark_seen', { quoteId }));
    const q = await store.get<{ id: string; timeline: unknown[] }>('quotes', quoteId);
    expect(q!.timeline).toHaveLength(2); // sent, seen: not three
  });

  it('refuses a zero, negative or absurd price', async () => {
    const { orderId, lineId } = await orderWithCake();
    const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId }));
    for (const price of [0, -5]) expect(errOf(await send('owner', 'quotes/provide', { quoteId, price }))).toMatch(/greater than zero|invalid/);
    expect(errOf(await send('owner', 'quotes/provide', { quoteId, price: 1e12 }))).toMatch(/invalid/);
    expect((await card('owner', orderId)).lines[0]!.status).toBe('awaiting_quote');
  });

  it('lets the owner change a price before baking, with a reason and a warning about money already taken', async () => {
    const { orderId, lineId, quoteId } = await quoted(100);
    ok(await send('cashier', 'payments/record_payment', { orderId, method: 'cash', amount: 100 }));
    expect(errOf(await send('cashier', 'quotes/revise', { quoteId, price: 150, reason: 'x' }))).toMatch(/^forbidden/);
    expect(errOf(await send('owner', 'quotes/revise', { quoteId, price: 150, reason: '' }))).toMatch(/Say why/);
    expect(errOf(await send('owner', 'quotes/revise', { quoteId, price: 100, reason: 'same' }))).toMatch(/same as the current/);
    const r = await send('owner', 'quotes/revise', { quoteId, price: 150, reason: 'Customer added a tier' });
    expect(r.ok && r.warnings.join(' ')).toMatch(/TSh 50 is now due/);
    expect(await card('owner', orderId)).toMatchObject({ total: 150, balance: 50, paymentStatus: 'partial' });

    ok(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'in_production' }));
    expect(errOf(await send('owner', 'quotes/revise', { quoteId, price: 200, reason: 'late change' }))).toMatch(/Baking has started/);
    const audit = await panel.feed('audit_view', {}, sid.owner);
    expect(audit.ok && audit.data.some((a) => a.summary.includes('from TSh 100 to TSh 150') && a.summary.includes('Customer added a tier'))).toBe(true);
  });
});

describe('changing a custom cake', () => {
  it('cannot be edited while the owner is pricing it, and warns when a quoted cake changes size', async () => {
    const { orderId, lineId } = await orderWithCake();
    const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId }));
    expect(errOf(await send('cashier', 'orders/update_custom_line', { orderId, lineId, spec: SPEC }))).toMatch(/Withdraw/);
    ok(await send('owner', 'quotes/provide', { quoteId, price: 80 }));

    const same = await send('cashier', 'orders/update_custom_line', { orderId, lineId, spec: { ...SPEC, inscription: 'Happy Birthday Neema' } });
    expect(same.ok && same.warnings).toEqual([]);
    const bigger = await send('cashier', 'orders/update_custom_line', { orderId, lineId, spec: { ...SPEC, servings: 30 } });
    expect(bigger.ok && bigger.warnings.join(' ')).toMatch(/Ask the owner/);
    const c = await card('cashier', orderId);
    expect(c.lines[0]!.cake!.servings).toBe(30);
    expect(c.total).toBe(80); // the price does not move by itself

    ok(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'in_production' }));
    expect(errOf(await send('cashier', 'orders/update_custom_line', { orderId, lineId, spec: SPEC }))).toMatch(/already been started/);
  });

  it('rejects incomplete details in plain words', async () => {
    const { orderId } = ok<{ orderId: string }>(await send('cashier', 'orders/create_order', { source: 'walk_in', fulfilment: 'pickup' }));
    expect(errOf(await send('cashier', 'orders/add_custom_line', { orderId, spec: { ...SPEC, flavor: '   ' } }))).toMatch(/Choose a flavor/);
    expect(errOf(await send('cashier', 'orders/add_custom_line', { orderId, spec: { ...SPEC, servings: 0 } }))).toMatch(/invalid/);
    expect(errOf(await send('cashier', 'orders/add_custom_line', { orderId, spec: { ...SPEC, colour: 'pink' } as never }))).toMatch(/Unexpected field/);
    expect((await card('cashier', orderId)).lines).toHaveLength(0);
  });
});

describe('reference photos', () => {
  it('stores, attaches, shows to the baker, and removes pictures', async () => {
    const { orderId, lineId } = await orderWithCake();
    const up = await panel.uploadPhoto(PNG, sid.cashier);
    if (!up.ok) throw new Error('upload');
    expect(up).toMatchObject({ mime: 'image/png', size: PNG.length });
    ok(await send('cashier', 'orders/attach_reference_photo', { orderId, lineId, photoId: up.photoId }));
    expect((await card('cashier', orderId)).lines[0]!.cake!.photoIds).toEqual([up.photoId]);

    const read = await panel.readPhoto(up.photoId, sid.baker);
    expect(read.ok && Array.from(read.bytes)).toEqual(Array.from(PNG));
    expect(read.ok && read.mime).toBe('image/png');

    expect(errOf(await send('cashier', 'orders/attach_reference_photo', { orderId, lineId, photoId: up.photoId }))).toMatch(/already on this cake/);
    ok(await send('cashier', 'orders/remove_reference_photo', { orderId, lineId, photoId: up.photoId }));
    expect((await card('cashier', orderId)).lines[0]!.cake!.photoIds).toEqual([]);
  });

  it('accepts only real pictures, only from the front desk, and only up to the size limit', async () => {
    const text = new TextEncoder().encode('<script>alert(1)</script>');
    const bad = await panel.uploadPhoto(text, sid.cashier);
    expect(!bad.ok && bad.error.messages[0]).toMatch(/JPEG, PNG or WebP/);
    expect((await panel.uploadPhoto(new Uint8Array(0), sid.cashier)).ok).toBe(false);
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(JPG);
    const tooBig = await panel.uploadPhoto(big, sid.cashier);
    expect(!tooBig.ok && tooBig.error.messages[0]).toMatch(/too big/);
    const fromBaker = await panel.uploadPhoto(JPG, sid.baker);
    expect(!fromBaker.ok && fromBaker.error.code).toBe('forbidden');
    const anon = await panel.uploadPhoto(JPG, undefined);
    expect(!anon.ok && anon.error.code).toBe('unauthenticated');
    expect((await panel.readPhoto('pho_nope', sid.owner)).ok).toBe(false);
    const inv = await signInOther('inventory');
    const up = await panel.uploadPhoto(JPG, sid.cashier);
    if (!up.ok) throw new Error('upload');
    const denied = await panel.readPhoto(up.photoId, inv);
    expect(!denied.ok && denied.error.code).toBe('forbidden');
  });

  it('keeps a picture to one cake and a cake to six pictures', async () => {
    const a = await orderWithCake();
    const b = await orderWithCake();
    const first = await panel.uploadPhoto(JPG, sid.cashier);
    if (!first.ok) throw new Error('upload');
    ok(await send('cashier', 'orders/attach_reference_photo', { ...a, photoId: first.photoId }));
    expect(errOf(await send('cashier', 'orders/attach_reference_photo', { ...b, photoId: first.photoId }))).toMatch(/another cake/);
    for (let i = 0; i < 5; i++) {
      const p = await panel.uploadPhoto(PNG, sid.cashier);
      if (!p.ok) throw new Error('upload');
      ok(await send('cashier', 'orders/attach_reference_photo', { ...a, photoId: p.photoId }));
    }
    const seventh = await panel.uploadPhoto(PNG, sid.cashier);
    if (!seventh.ok) throw new Error('upload');
    expect(errOf(await send('cashier', 'orders/attach_reference_photo', { ...a, photoId: seventh.photoId }))).toMatch(/up to 6/);
    expect(errOf(await send('cashier', 'orders/attach_reference_photo', { ...a, photoId: 'pho_missing' }))).toMatch(/not found/);
  });

  it('cleans up pictures nobody attached after a day, and never touches attached ones', async () => {
    const { orderId, lineId } = await orderWithCake();
    const kept = await panel.uploadPhoto(JPG, sid.cashier);
    const lost = await panel.uploadPhoto(PNG, sid.cashier);
    if (!kept.ok || !lost.ok) throw new Error('upload');
    ok(await send('cashier', 'orders/attach_reference_photo', { orderId, lineId, photoId: kept.photoId }));
    t += 23 * 3_600_000;
    expect((await panel.maintain()).photosPruned).toBe(0);
    t += 2 * 3_600_000;
    expect((await panel.maintain()).photosPruned).toBe(1);
    // A day has passed, so sessions have ended too: look in the store directly.
    expect(await store.get('photoData', kept.photoId)).toBeDefined();
    expect(await store.get('photos', lost.photoId)).toBeUndefined();
    expect(await store.get('photoData', lost.photoId)).toBeUndefined();
  });
});

describe('cancelling', () => {
  it('lets the cashier drop a cake before it is priced and closes the open request', async () => {
    const { orderId, lineId } = await orderWithCake();
    const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId }));
    ok(await send('cashier', 'orders/cancel_line', { orderId, lineId }));
    const q = await store.get<{ id: string; status: string }>('quotes', quoteId);
    expect(q!.status).toBe('withdrawn');
    const inbox = await panel.feed('quote_inbox', {}, sid.owner);
    expect(inbox.ok && inbox.data.open).toHaveLength(0);
  });

  it('leaves a cake being baked to the owner', async () => {
    const { orderId, lineId } = await quoted();
    ok(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'in_production' }));
    expect(errOf(await send('cashier', 'orders/cancel_line', { orderId, lineId }))).toMatch(/Ask the owner/);
    expect(errOf(await send('cashier', 'orders/cancel_order', { orderId }))).toMatch(/Only the owner/);
    const c = await card('cashier', orderId);
    expect(c.canCancel).toBe(false);
    expect(c.lines[0]!.canRemove).toBe(false);
    expect((await card('owner', orderId)).canCancel).toBe(true);
    ok(await send('owner', 'orders/cancel_order', { orderId }));
    expect((await card('owner', orderId)).status).toBe('cancelled');
    const q = await panel.feed('bake_queue', {}, sid.baker);
    expect(q.ok && q.data.rows).toHaveLength(0);
  });

  it('stops a paid, quoted cake being removed by the cashier but lets the owner, who then decides the refund', async () => {
    const { orderId, lineId } = await quoted(60);
    ok(await send('cashier', 'payments/record_payment', { orderId, method: 'cash', amount: 60 }));
    expect(errOf(await send('cashier', 'orders/cancel_line', { orderId, lineId }))).toMatch(/payments/);
    ok(await send('owner', 'orders/cancel_line', { orderId, lineId }));
    const c = await card('owner', orderId);
    expect(c).toMatchObject({ status: 'cancelled', canRefund: true });
  });
});

describe('delivery details', () => {
  it('rejects dates in the past and a delivery without an address', async () => {
    expect(errOf(await send('cashier', 'orders/create_order', { source: 'phone', fulfilment: 'pickup', deliveryDate: '2026-09-01' }))).toMatch(/today or a later date/);
    const { orderId } = await orderWithCake();
    expect(errOf(await send('cashier', 'orders/set_delivery', { orderId, deliveryDate: '2026-02-30' }))).toMatch(/valid delivery date/);
    expect(errOf(await send('cashier', 'orders/set_delivery', { orderId, fulfilment: 'delivery' }))).toMatch(/address/);
    expect(errOf(await send('cashier', 'orders/set_delivery', { orderId }))).toMatch(/Choose what to change/);
    ok(await send('cashier', 'orders/set_delivery', { orderId, fulfilment: 'delivery', deliveryAddress: '5 Rose Lane' }));
    expect(await card('cashier', orderId)).toMatchObject({ fulfilment: 'delivery', deliveryAddress: '5 Rose Lane', canEditDelivery: true });
  });

  it('warns that the baker must be told when the date moves after baking starts', async () => {
    const { orderId, lineId } = await quoted();
    ok(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'in_production' }));
    const r = await send('cashier', 'orders/set_delivery', { orderId, deliveryDate: '2026-10-09' });
    expect(r.ok && r.warnings.join(' ')).toMatch(/Tell them about the new date/);
    const q = await panel.feed('bake_queue', {}, sid.baker);
    expect(q.ok && q.data.rows[0]!.deliveryDate).toBe('2026-10-09');
  });
});

describe('the baker’s queue', () => {
  it('orders by delivery date and says how urgent each cake is', async () => {
    const dates = { late: '2026-09-27', today: '2026-09-29', tomorrow: '2026-09-30', later: '2026-10-10' };
    // A late date cannot be entered today, so make the order earlier and let time pass.
    t = Date.UTC(2026, 8, 25, 8, 0, 0);
    const ids: Record<string, { orderId: string; lineId: string }> = {};
    for (const [k, d] of Object.entries(dates)) {
      const o = await orderWithCake({ date: d });
      const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId: o.orderId, lineId: o.lineId }));
      ok(await send('owner', 'quotes/provide', { quoteId, price: 50 }));
      ids[k] = o;
    }
    t = Date.UTC(2026, 8, 29, 8, 0, 0);
    ok(await send('baker', 'orders/advance_line', { ...ids.today!, to: 'in_production' }));
    const r = await panel.feed('bake_queue', {}, sid.baker);
    if (!r.ok) throw new Error('queue');
    expect(r.data.rows.map((x) => [x.dueLabel, x.urgency])).toEqual([
      ['2 days late', 'late'],
      ['Today', 'today'],
      ['Tomorrow', 'soon'],
      ['In 11 days', 'later'],
    ]);
    expect(r.data.counts).toEqual({ late: 1, today: 1, toStart: 3, inProduction: 1, ready: 0 });
  });

  it('leaves out cakes that are not yet priced, and finished or cancelled ones', async () => {
    const draft = await orderWithCake();
    const waiting = await orderWithCake();
    ok(await send('cashier', 'quotes/request', waiting));
    const done = await quoted();
    ok(await send('baker', 'orders/advance_line', { orderId: done.orderId, lineId: done.lineId, to: 'in_production' }));
    ok(await send('baker', 'orders/advance_line', { orderId: done.orderId, lineId: done.lineId, to: 'ready' }));
    ok(await send('cashier', 'orders/advance_line', { orderId: done.orderId, lineId: done.lineId, to: 'completed' }));
    const r = await panel.feed('bake_queue', {}, sid.baker);
    expect(r.ok && r.data.rows).toHaveLength(0);
    expect(draft.lineId).toBeTruthy();
  });
});

describe('orders with both kinds of item', () => {
  it('keeps catalogue stock and totals separate from custom cakes', async () => {
    const g = await panel.feed('catalogue_grid', {}, sid.cashier);
    if (!g.ok) throw new Error('grid');
    const combo = g.data[0]!.combinations.find((c) => c.sellable && c.onHand > 0)!;
    const { orderId, lineId } = await orderWithCake();
    ok(await send('cashier', 'orders/add_catalogue_line', { orderId, combinationId: combo.combinationId, qty: 2 }));
    let c = await card('cashier', orderId);
    expect(c.quotePending).toBe(true);
    expect(c.canRecordPayment).toBe(false);
    expect(c.total).toBe(2 * combo.price!); // only the priced part counts

    const { quoteId } = ok<{ quoteId: string }>(await send('cashier', 'quotes/request', { orderId, lineId }));
    ok(await send('owner', 'quotes/provide', { quoteId, price: 100 }));
    c = await card('cashier', orderId);
    expect(c.total).toBe(2 * combo.price! + 100);
    expect(c.status).toBe('new');

    const after = await panel.feed('catalogue_grid', {}, sid.cashier);
    const row = after.ok && after.data.flatMap((p) => p.combinations).find((x) => x.combinationId === combo.combinationId)!;
    expect(row && row.committed).toBe(2); // the custom cake does not appear as committed stock
  });

  it('shows the least advanced stage for the whole order', async () => {
    const g = await panel.feed('catalogue_grid', {}, sid.cashier);
    if (!g.ok) throw new Error('grid');
    const combo = g.data[0]!.combinations.find((c) => c.sellable)!;
    const { orderId, lineId, quoteId } = await quoted();
    const cat = ok<{ lineId: string }>(await send('cashier', 'orders/add_catalogue_line', { orderId, combinationId: combo.combinationId, qty: 1 }));
    ok(await send('cashier', 'orders/advance_line', { orderId, lineId: cat.lineId, to: 'ready' }));
    expect((await card('cashier', orderId)).status).toBe('new');
    ok(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'in_production' }));
    expect((await card('cashier', orderId)).status).toBe('in_production');
    ok(await send('baker', 'orders/advance_line', { orderId, lineId, to: 'ready' }));
    expect((await card('cashier', orderId)).status).toBe('ready');
    expect(quoteId).toBeTruthy();
    const list = await panel.feed('order_list', {}, sid.cashier);
    expect(list.ok && list.data[0]).toMatchObject({ hasCustomCake: true, needsQuote: false, quotePending: false });
  });
});

async function signInOther(role: 'inventory') {
  const pin = DEMO_STAFF.find((s) => s.role === role)!.pin;
  const staff = (await store.list<Staff>('staff')).find((s) => s.role === role)!;
  return ok<{ sessionId: string }>(await panel.dispatch('auth/sign_in', { userId: staff.id, pin })).sessionId;
}
