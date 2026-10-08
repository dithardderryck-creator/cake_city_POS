import type { Batch, Combination, OptionGroup, OptionValue, Product, StockMovement } from '../domain';
import type { FeedDef } from '../feeds';
import type { Registry } from '../intents';
import { hhmm, localDay, todayLocal } from './dates';

/** The baker has this long to take back a batch they logged by mistake. */
export const UNDO_MINUTES = 30;

/** "Chocolate cake, 8-inch" for a product with options, or just the product's name when it has none. */
export function versionLabel(product: Pick<Product, 'name'>, combo: Combination, values: OptionValue[], groups: OptionGroup[]): string {
  const order = new Map(groups.map((g) => [g.id, g.order]));
  const parts = combo.valueIds
    .map((id) => values.find((v) => v.id === id))
    .filter((v): v is OptionValue => !!v)
    .sort((a, b) => (order.get(a.groupId) ?? 0) - (order.get(b.groupId) ?? 0))
    .map((v) => v.label);
  return parts.length ? `${product.name}, ${parts.join(', ')}` : product.name;
}

export const batchIntents = {
  'batches/log': {
    circuit: 'Stock',
    roles: ['baker', 'owner'],
    validate: async (p, ctx) => {
      const combo = await ctx.store.get<Combination>('combinations', p.combinationId);
      if (!combo) return ['Choose what you made.'];
      const product = await ctx.store.get<Product>('products', combo.productId);
      if (!product || product.status !== 'active') return ['That item is no longer on the menu.'];
      return [];
    },
    handle: async (p, ctx) => {
      const me = ctx.session!;
      const combo = (await ctx.store.get<Combination>('combinations', p.combinationId))!;
      const product = (await ctx.store.get<Product>('products', combo.productId))!;
      const [values, groups] = await Promise.all([ctx.store.list<OptionValue>('optionValues'), ctx.store.list<OptionGroup>('optionGroups')]);
      const label = versionLabel(product, combo, values, groups);
      const batch: Batch = {
        id: ctx.ids.next('bat'),
        combinationId: combo.id,
        productId: product.id,
        label,
        qty: p.qty,
        note: p.note?.trim() || undefined,
        byId: me.userId,
        byName: me.name,
        at: ctx.now(),
      };
      await ctx.store.put('batches', batch);
      await ctx.store.put('combinations', { ...combo, stockCount: combo.stockCount + p.qty });
      const movement: StockMovement = { id: ctx.ids.next('mov'), combinationId: combo.id, qty: p.qty, reason: 'batch', by: me.userId, at: batch.at };
      await ctx.store.put('stockMovements', movement);
      return {
        summary: `Logged a batch: ${label} × ${p.qty}`,
        target: batch.id,
        data: { batchId: batch.id, onHand: combo.stockCount + p.qty },
        events: [{ type: 'StockMoved', payload: { combinationId: combo.id, delta: p.qty } }],
      };
    },
  },

  'batches/undo': {
    circuit: 'Stock',
    roles: ['baker', 'owner'],
    validate: async (p, ctx) => {
      const me = ctx.session!;
      const b = await ctx.store.get<Batch>('batches', p.batchId);
      if (!b) return ['That batch does not exist.'];
      if (b.undoneAt) return ['That batch was already taken back.'];
      if (me.role !== 'owner') {
        if (b.byId !== me.userId) return ['Only the person who logged a batch can take it back. Ask the owner.'];
        if (Date.parse(ctx.now()) - Date.parse(b.at) > UNDO_MINUTES * 60_000) return [`A batch can be taken back for ${UNDO_MINUTES} minutes. Ask the owner.`];
      }
      const combo = await ctx.store.get<Combination>('combinations', b.combinationId);
      if (!combo || combo.stockCount < b.qty) return ['Some of this batch has already been sold, so it cannot be taken back. Ask the owner to set the stock.'];
      return [];
    },
    handle: async (p, ctx) => {
      const b = (await ctx.store.get<Batch>('batches', p.batchId))!;
      const combo = (await ctx.store.get<Combination>('combinations', b.combinationId))!;
      await ctx.store.put('batches', { ...b, undoneAt: ctx.now() });
      await ctx.store.put('combinations', { ...combo, stockCount: combo.stockCount - b.qty });
      const movement: StockMovement = { id: ctx.ids.next('mov'), combinationId: combo.id, qty: -b.qty, reason: 'batch', by: ctx.session!.userId, at: ctx.now() };
      await ctx.store.put('stockMovements', movement);
      return {
        summary: `Took back a batch: ${b.label} × ${b.qty}`,
        target: b.id,
        events: [{ type: 'StockMoved', payload: { combinationId: combo.id, delta: -b.qty } }],
      };
    },
  },
} satisfies Partial<Registry>;

/* ---------- Feed ---------- */

export interface BatchOption {
  combinationId: string;
  productId: string;
  label: string;
  onHand: number;
}
export interface BatchRow {
  batchId: string;
  label: string;
  qty: number;
  note?: string;
  byName: string;
  at: string;
  /** Time of day, such as "08:25". For an earlier day it is the date and time. */
  timeText: string;
  today: boolean;
  /** The person looking may take it back right now. */
  canUndo: boolean;
}
export interface BatchLogData {
  /** What can be logged: every active product's versions, by name. */
  options: BatchOption[];
  /** Most recent first, up to 40. Batches taken back are left out. */
  rows: BatchRow[];
  today: { batches: number; items: number };
  can: { log: boolean };
  undoMinutes: number;
}

export const batchFeeds = {
  batch_log: {
    roles: ['baker', 'owner', 'inventory'],
    build: async ({ store, session, clock }) => {
      const me = session!;
      const now = clock.now();
      const today = todayLocal(now);
      const [products, combos, values, groups, batches] = await Promise.all([
        store.list<Product>('products'),
        store.list<Combination>('combinations'),
        store.list<OptionValue>('optionValues'),
        store.list<OptionGroup>('optionGroups'),
        store.list<Batch>('batches'),
      ]);
      const options: BatchOption[] = [];
      for (const p of products.filter((x) => x.status === 'active')) {
        for (const c of combos.filter((x) => x.productId === p.id)) {
          options.push({ combinationId: c.id, productId: p.id, label: versionLabel(p, c, values, groups), onHand: c.stockCount });
        }
      }
      options.sort((a, b) => a.label.localeCompare(b.label));
      const live = batches.filter((b) => !b.undoneAt).sort((a, b) => b.at.localeCompare(a.at));
      const canLog = me.role === 'baker' || me.role === 'owner';
      const rows = live.slice(0, 40).map((b): BatchRow => {
        const isToday = localDay(b.at) === today;
        const recent = now.getTime() - Date.parse(b.at) <= UNDO_MINUTES * 60_000;
        return {
          batchId: b.id,
          label: b.label,
          qty: b.qty,
          note: b.note,
          byName: b.byName,
          at: b.at,
          timeText: isToday ? hhmm(b.at) : `${localDay(b.at)} ${hhmm(b.at)}`,
          today: isToday,
          canUndo: me.role === 'owner' || (me.role === 'baker' && b.byId === me.userId && recent),
        };
      });
      const todays = live.filter((b) => localDay(b.at) === today);
      return {
        options,
        rows,
        today: { batches: todays.length, items: todays.reduce((s, b) => s + b.qty, 0) },
        can: { log: canLog },
        undoMinutes: UNDO_MINUTES,
      };
    },
  },
} satisfies { batch_log: FeedDef<'batch_log'> };
