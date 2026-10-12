import type { CountResult, CountSession, Ingredient, IngredientUnit } from '../domain';
import type { FeedDef } from '../feeds';
import type { HandlerCtx, Registry } from '../intents';
import { formatQty } from '../units';
import { hhmm, localDay, todayLocal } from './dates';
import { applyCount, qtyFor, round3, unitProblem } from './inventory';
import { buildRequest } from './requests';
import { loadSettings } from './settings';

/** A difference this big (a tenth of what was expected, or more) is flagged and goes to the owner. */
/** A count off by at least this share of what was expected is "big". The share is the owner's setting (percent). */
export const isBig = (expected: number, counted: number, percent: number) => Math.abs(counted - expected) / Math.max(expected, 1e-4) >= percent / 100;

const kindOf = (i: Pick<Ingredient, 'kind'>) => i.kind ?? 'ingredient';
/** Ingredients first, then packaging, each in name order. */
const countOrder = (list: Ingredient[]) =>
  list
    .filter((i) => i.active)
    .sort((a, b) => Number(kindOf(a) === 'packaging') - Number(kindOf(b) === 'packaging') || a.name.localeCompare(b.name));

const openSession = async (ctx: Pick<HandlerCtx, 'store'>) => (await ctx.store.find<CountSession>('countSessions', { where: { status: 'open' } }))[0];

const signed = (n: number, unit: IngredientUnit) => (n === 0 ? 'matches' : `${n > 0 ? '+' : '−'}${formatQty(Math.abs(n), unit)}`);

export const countIntents = {
  'count/start': {
    circuit: 'Inventory',
    roles: ['owner', 'inventory'],
    validate: async (_p, ctx) => {
      if (await openSession(ctx)) return [];
      const items = await ctx.store.list<Ingredient>('ingredients');
      return items.some((i) => i.active) ? [] : ['There is nothing to count yet. Add ingredients or packaging in Stock first.'];
    },
    handle: async (_p, ctx) => {
      const existing = await openSession(ctx);
      if (existing) return { summary: 'Picked up the daily count', target: existing.id, data: { sessionId: existing.id, resumed: true } };
      const me = ctx.session!;
      const s: CountSession = { id: ctx.ids.next('cnt'), status: 'open', startedById: me.userId, startedByName: me.name, startedAt: ctx.now(), counts: {} };
      await ctx.store.put('countSessions', s);
      return { summary: 'Started the daily count', target: s.id, data: { sessionId: s.id, resumed: false } };
    },
  },

  'count/record': {
    circuit: 'Inventory',
    roles: ['owner', 'inventory'],
    validate: async (p, ctx) => {
      const s = await ctx.store.get<CountSession>('countSessions', p.sessionId);
      if (!s || s.status !== 'open') return ['That count is no longer open.'];
      const ing = await ctx.store.get<Ingredient>('ingredients', p.ingredientId);
      if (!ing || !ing.active) return ['That item is not in the count.'];
      if (p.counted === null) return [];
      if (!(p.counted >= 0)) return ['The count cannot be negative.'];
      const bad = unitProblem(ing, p.unit);
      return bad ? [bad] : [];
    },
    handle: async (p, ctx) => {
      const s = (await ctx.store.get<CountSession>('countSessions', p.sessionId))!;
      const ing = (await ctx.store.get<Ingredient>('ingredients', p.ingredientId))!;
      const counts = { ...s.counts };
      if (p.counted === null) delete counts[ing.id];
      else counts[ing.id] = qtyFor(ing, p.counted, p.unit)!;
      await ctx.store.put('countSessions', { ...s, counts });
      return { summary: p.counted === null ? `Skipped ${ing.name} in the daily count` : `Counted ${ing.name}: ${formatQty(counts[ing.id], ing.unit)} (not applied yet)`, target: s.id };
    },
  },

  'count/submit': {
    circuit: 'Inventory',
    roles: ['owner', 'inventory'],
    validate: async (p, ctx) => {
      const s = await ctx.store.get<CountSession>('countSessions', p.sessionId);
      if (!s || s.status !== 'open') return ['That count is no longer open.'];
      if (!Object.keys(s.counts).length) return ['Count at least one item first.'];
      return [];
    },
    handle: async (p, ctx) => {
      const me = ctx.session!;
      const s = (await ctx.store.get<CountSession>('countSessions', p.sessionId))!;
      const results: CountResult[] = [];
      const bigPercent = (await loadSettings(ctx.store)).bigDifferencePercent;
      const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
      for (const [id, counted] of Object.entries(s.counts)) {
        const ing = await ctx.store.get<Ingredient>('ingredients', id);
        if (!ing) continue;
        const expected = ing.onHand;
        const r = await applyCount(ctx, ing, counted, 'Daily count');
        events.push(...r.events);
        results.push({ ingredientId: ing.id, name: ing.name, unit: ing.unit, expected, counted, difference: r.delta, big: isBig(expected, counted, bigPercent) });
      }
      await ctx.store.put('countSessions', { ...s, status: 'submitted', submittedAt: ctx.now(), results });
      const differences = results.filter((r) => r.difference !== 0).length;
      const big = results.filter((r) => r.big);
      // The owner hears about big differences. If the owner counted, they already know.
      if (big.length && me.role !== 'owner') {
        const req = buildRequest(ctx, me, {
          toRole: 'owner',
          category: 'Stock and supplies',
          title: 'Count differences need a look',
          body: `Big differences: ${big.map((r) => `${r.name} (expected ${formatQty(r.expected, r.unit)}, counted ${formatQty(r.counted, r.unit)})`).join('; ')}`.slice(0, 500),
          link: 'Daily count',
        });
        await ctx.store.put('staffRequests', req);
        events.push({ type: 'RequestSent', payload: { requestId: req.id, urgent: false, audience: 'owner' } });
      }
      events.push({ type: 'CountSubmitted', payload: { sessionId: s.id, items: results.length, differences, big: big.length } });
      return {
        summary: `Daily count saved: ${results.length} items, ${differences} differences${big.length ? `, ${big.length} big` : ''}`,
        target: s.id,
        data: { counted: results.length, differences, big: big.length, ownerNotified: big.length > 0 && me.role !== 'owner' },
        events,
      };
    },
  },

  'count/discard': {
    circuit: 'Inventory',
    roles: ['owner', 'inventory'],
    validate: async (p, ctx) => {
      const s = await ctx.store.get<CountSession>('countSessions', p.sessionId);
      if (!s || s.status !== 'open') return ['That count is no longer open.'];
      return [];
    },
    handle: async (p, ctx) => {
      const s = (await ctx.store.get<CountSession>('countSessions', p.sessionId))!;
      await ctx.store.put('countSessions', { ...s, status: 'discarded' });
      return { summary: `Threw away the daily count (${Object.keys(s.counts).length} items counted)`, target: s.id };
    },
  },
} satisfies Partial<Registry>;

/* ---------- Feed ---------- */

export interface CountItemRow {
  ingredientId: string;
  name: string;
  kind: 'ingredient' | 'packaging';
  unit: IngredientUnit;
  expected: number;
  expectedText: string;
  /** How much the + and − buttons change the count by. */
  step: number;
  counted: number | null;
  countedText: string | null;
  difference: number | null;
  differenceText: string | null;
  big: boolean;
  /** Last counted, as a time of day if that was today. */
  lastCountedText: string | null;
}
export interface CountSessionData {
  /** Counted today at this time of day, or null. */
  countedToday: string | null;
  session: null | {
    sessionId: string;
    startedByName: string;
    startedAt: string;
    total: number;
    done: number;
    skipped: number;
    differences: number;
    big: number;
    items: CountItemRow[];
  };
  history: { sessionId: string; at: string; byName: string; items: number; differences: number; big: number }[];
  bigDifferencePercent: number;
  can: { start: boolean };
}

export const countFeeds = {
  count_session: {
    roles: ['owner', 'inventory'],
    build: async ({ store, clock }) => {
      const now = clock.now();
      const today = todayLocal(now);
      const [ingredients, sessions, settings] = await Promise.all([store.list<Ingredient>('ingredients'), store.list<CountSession>('countSessions'), loadSettings(store)]);
      const bigPercent = settings.bigDifferencePercent;
      const submitted = sessions.filter((s) => s.status === 'submitted' && s.submittedAt).sort((a, b) => b.submittedAt!.localeCompare(a.submittedAt!));
      const lastToday = submitted.find((s) => localDay(s.submittedAt!) === today);
      const open = sessions.find((s) => s.status === 'open');

      let session: CountSessionData['session'] = null;
      if (open) {
        const list = countOrder(ingredients);
        const items = list.map((i): CountItemRow => {
          const counted = open.counts[i.id];
          const has = counted !== undefined;
          return {
            ingredientId: i.id,
            name: i.name,
            kind: kindOf(i),
            unit: i.unit,
            expected: i.onHand,
            expectedText: formatQty(i.onHand, i.unit),
            step: i.unit === 'pcs' ? 1 : i.onHand < 2 ? 0.05 : 0.5,
            counted: has ? counted : null,
            countedText: has ? formatQty(counted, i.unit) : null,
            difference: has ? round3(counted - i.onHand) : null,
            differenceText: has ? signed(round3(counted - i.onHand), i.unit) : null,
            big: has && isBig(i.onHand, counted, bigPercent),
            lastCountedText: i.countedAt ? (localDay(i.countedAt) === today ? `today ${hhmm(i.countedAt)}` : localDay(i.countedAt)) : null,
          };
        });
        const done = items.filter((i) => i.counted !== null);
        session = {
          sessionId: open.id,
          startedByName: open.startedByName,
          startedAt: open.startedAt,
          total: items.length,
          done: done.length,
          skipped: items.length - done.length,
          differences: done.filter((i) => i.difference !== 0).length,
          big: done.filter((i) => i.big).length,
          items,
        };
      }
      return {
        countedToday: lastToday ? hhmm(lastToday.submittedAt!) : null,
        session,
        history: submitted.slice(0, 10).map((s) => ({
          sessionId: s.id,
          at: s.submittedAt!,
          byName: s.startedByName,
          items: s.results?.length ?? 0,
          differences: (s.results ?? []).filter((r) => r.difference !== 0).length,
          big: (s.results ?? []).filter((r) => r.big).length,
        })),
        bigDifferencePercent: bigPercent,
        can: { start: true },
      };
    },
  },
} satisfies { count_session: FeedDef<'count_session'> };

