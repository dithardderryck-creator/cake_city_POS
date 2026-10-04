import { describe, expect, it } from 'vitest';
import type { Ingredient, IngredientMovement } from './domain';
import { calibrationFor, forecastIngredient, usualDailyUse, type BookedLine, type CalibrationSample } from './forecast';

const NOW = new Date(2026, 9, 4, 12, 0, 0); // Sun 4 Oct 2026, midday (local)
const day = (k: number, hour = 9) => new Date(2026, 9, 4 + k, hour, 0, 0).toISOString();
const ymd = (k: number) => {
  const d = new Date(2026, 9, 4 + k);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const flour = (o: Partial<Ingredient> = {}): Ingredient => ({ id: 'flour', name: 'Flour', unit: 'kg', onHand: 1, allergens: [], ranges: [], active: true, createdAt: '', ...o });
const mv = (k: number, qty: number, reason: IngredientMovement['reason'] = 'usage'): IngredientMovement => ({ id: `m${k}${qty}${reason}`, ingredientId: 'flour', qty, reason, by: 'u', at: day(k) });
const book = (k: number, qty: number): BookedLine => ({ date: ymd(k), ingredientId: 'flour', qty });
const run = (o: Partial<Parameters<typeof forecastIngredient>[0]> = {}) =>
  forecastIngredient({ now: NOW, ingredient: flour(), movements: [], booked: [], samples: [], hasRecipe: true, ...o });

describe('usual daily use', () => {
  it('needs three records over three days, like days-of-stock-left', () => {
    expect(usualDailyUse([mv(-1, -0.1), mv(-2, -0.1)], NOW)).toBeNull();
    expect(usualDailyUse([mv(-1, -0.1), mv(-1, -0.1), mv(-1, -0.1)], NOW)).toBeNull(); // history under 3 days
    expect(usualDailyUse([mv(-4, -0.1), mv(-2, -0.1), mv(-1, -0.1)], NOW)).toBeCloseTo(0.3 / 4.125, 3);
  });
  it('is zero when nothing was used recently, and ignores deliveries', () => {
    expect(usualDailyUse([mv(-40, -0.1), mv(-41, -0.1), mv(-42, -0.1)], NOW)).toBe(0);
    expect(usualDailyUse([mv(-4, 5, 'delivery'), mv(-3, 5, 'delivery'), mv(-2, 5, 'delivery')], NOW)).toBeNull();
  });
});

describe('calibration against the chefs’ real use', () => {
  const sample = (suggested: number, actual: number, k = -1): CalibrationSample => ({ ingredientId: 'flour', suggested, actual, at: day(k) });
  it('does nothing until there are three cakes to learn from', () => {
    expect(calibrationFor([sample(1, 1.5), sample(1, 1.5)], NOW)).toEqual({ factor: 1, samples: 2, applied: false });
  });
  it('scales by real use over suggested use, and limits the swing', () => {
    expect(calibrationFor([sample(1, 1.2), sample(2, 2.4), sample(1, 1.2)], NOW)).toEqual({ factor: 1.2, samples: 3, applied: true });
    expect(calibrationFor([sample(1, 9), sample(1, 9), sample(1, 9)], NOW).factor).toBe(2);
    expect(calibrationFor([sample(1, 0), sample(1, 0), sample(1, 0)], NOW).factor).toBe(0.5);
  });
  it('ignores old cakes and cakes with no suggestion for this ingredient', () => {
    expect(calibrationFor([sample(1, 2, -90), sample(1, 2, -80), sample(1, 2, -70)], NOW).applied).toBe(false);
    expect(calibrationFor([sample(0, 2), sample(0, 2), sample(0, 2)], NOW).applied).toBe(false);
  });
});

describe('the stock line', () => {
  it('rebuilds past stock from the movements and ends at what is on hand now', () => {
    const r = run({ ingredient: flour({ onHand: 4.5 }), movements: [mv(-3, 5, 'opening'), mv(-1, -0.5)] });
    const past = r.series.filter((p) => p.kind !== 'projected');
    expect(past).toHaveLength(15); // 14 days back plus today
    const at = (k: number) => past.find((p) => p.date === ymd(k))!;
    expect(at(-4).stock).toBe(0);
    expect(at(-3).stock).toBe(5);
    expect(at(-2).stock).toBe(5);
    expect(at(-1)).toMatchObject({ stock: 4.5, used: 0.5, kind: 'actual' });
    expect(at(0)).toMatchObject({ stock: 4.5, kind: 'today' });
  });

  it('is one continuous line: the first projected day continues from today', () => {
    const r = run({ ingredient: flour({ onHand: 2 }), booked: [book(1, 0.5)] });
    const proj = r.series.filter((p) => p.kind === 'projected');
    expect(proj).toHaveLength(14);
    expect(proj[0]).toMatchObject({ date: ymd(1), stock: 1.5, used: 0.5, booked: 0.5, usual: 0 });
    expect(r.series.findIndex((p) => p.kind === 'projected')).toBe(r.series.findIndex((p) => p.kind === 'today') + 1);
  });

  it('follows the bookings and finds the day stock runs out', () => {
    const r = run({ ingredient: flour({ onHand: 1 }), booked: [book(1, 0.6), book(2, 0.6)] });
    expect(r).toMatchObject({ status: 'stockout_soon', daysUntilOut: 2, outDate: ymd(2), shortfallInHorizon: 0.2, shortfallText: '200 g' });
    expect(r.text).toBe('Flour is expected to run out in 2 days (' + ymd(2) + '). About 200 g more is needed over the next 14 days.');
  });

  it('counts what is due today against today, and treats late bookings as today', () => {
    const r = run({ ingredient: flour({ onHand: 1 }), booked: [book(0, 0.7), book(-2, 0.5)] });
    expect(r.daysUntilOut).toBe(0);
    expect(r.text).toMatch(/run out today/);
  });

  it('drifts toward the usual rate further out, and never goes below what is booked', () => {
    const usage = [mv(-4, -0.1), mv(-3, -0.1), mv(-2, -0.1), mv(-1, -0.1)]; // 0.4 over a 4.4-day history
    const r = run({ ingredient: flour({ onHand: 50 }), movements: usage, booked: [book(2, 0.3)] });
    const p = (k: number) => r.series.find((x) => x.date === ymd(k))!;
    const usual = r.usualPerDay!;
    expect(usual).toBeGreaterThan(0.08);
    expect(p(1).used).toBeCloseTo(usual / 7, 3); // little ramp yet
    expect(p(2).used).toBeCloseTo(0.3, 3); // booked is more than the ramped usual rate
    expect(p(2).usual).toBe(0);
    expect(p(10).used).toBeCloseTo(usual, 3); // fully the usual rate
    expect(p(10).usual).toBeCloseTo(usual, 3);
    expect(r.confidence).toBe('high');
  });

  it('corrects bookings by how the chefs really use the ingredient', () => {
    const samples: CalibrationSample[] = [1, 2, 3].map((k) => ({ ingredientId: 'flour', suggested: 1, actual: 1.5, at: day(-k) }));
    const r = run({ ingredient: flour({ onHand: 10 }), booked: [book(1, 1)], samples });
    expect(r.calibration).toEqual({ factor: 1.5, samples: 3, applied: true });
    expect(r.series.find((p) => p.date === ymd(1))!.booked).toBe(1.5);
  });

  it('raises the reorder warning from the projection, and straight away when already low', () => {
    const soon = run({ ingredient: flour({ onHand: 3, reorderLevel: 1 }), booked: [book(3, 1.5), book(4, 1)] });
    expect(soon).toMatchObject({ status: 'reorder_soon', daysUntilReorder: 4, reorderDate: ymd(4) }); // 3 - 1.5 = 1.5 on day 3, 0.5 on day 4
    expect(run({ ingredient: flour({ onHand: 1, reorderLevel: 1 }) })).toMatchObject({ status: 'reorder_soon', daysUntilReorder: 0 });
    expect(run({ ingredient: flour({ onHand: 9, reorderLevel: 1 }), booked: [book(1, 0.1)] }).status).toBe('ok');
  });

  it('says out, and is honest about having nothing to go on', () => {
    expect(run({ ingredient: flour({ onHand: 0, reorderLevel: 1 }) })).toMatchObject({ status: 'out', text: 'Flour is out of stock.' });
    const blind = run({ ingredient: flour({ onHand: 3, reorderLevel: 1 }) });
    expect(blind).toMatchObject({ status: 'no_data', confidence: 'low', usualPerDay: null });
    expect(blind.text).toMatch(/Not enough history/);
    expect(run({ ingredient: flour({ onHand: 0 }), hasRecipe: false }).status).toBe('no_data'); // never used, never listed
  });

  it('reports the next seven days of expected use', () => {
    const r = run({ ingredient: flour({ onHand: 10 }), booked: [book(1, 0.5), book(6, 0.25), book(8, 9)] });
    expect(r.next7Days).toBe(0.75);
    expect(r.next7DaysText).toBe('750 g');
  });
});
