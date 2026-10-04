import type { Ingredient, IngredientMovement, Order, OrderLine, RecipeRule, UsageReport, UsageSuggestion } from './domain';
import { todayLocal } from './circuits/dates';
import { generateSuggestionLines } from './circuits/recipes';
import type { Store } from './ports';
import { formatQty, roundQty, type BaseUnit } from './units';

/**
 * Stock forecast (D-63). One stock line per ingredient: what it was (from the stock movements), what it is now,
 * and what it is expected to be, built from two things:
 *
 *  1. Booked cakes. Every custom cake still to be baked is turned into ingredient amounts with the recipe
 *     suggestion, placed on the day it will be baked, and corrected by how the chefs' real (confirmed) use has
 *     compared with the suggestions so far.
 *  2. The kitchen's usual daily use, from confirmed usage over the last 14 days.
 *
 * The next few days follow the bookings. Further out, bookings are thin because customers have not ordered yet, so
 * the projection drifts toward the usual rate. It never goes below what is already booked.
 * Plain arithmetic, no internet, same answer every time. When there is too little history it says so.
 */

export interface ForecastOptions {
  /** Days of past stock to show. */
  historyDays: number;
  /** Days ahead to project. */
  horizonDays: number;
  /** "Stockout soon" when stock runs out within this many days (today counts as 0). */
  stockoutDays: number;
  /** "Reorder soon" when stock falls to the reorder level within this many days. */
  reorderDays: number;
  /** A cake that has not been started is baked this many days before its delivery date. */
  bakeLeadDays: number;
}

export const FORECAST_DEFAULTS: ForecastOptions = { historyDays: 14, horizonDays: 14, stockoutDays: 3, reorderDays: 7, bakeLeadDays: 1 };

/** Days over which the usual rate is measured (BR-14). */
const USAGE_WINDOW_DAYS = 14;
const MIN_USAGE_RECORDS = 3;
const MIN_HISTORY_DAYS = 3;
/** Past confirmed cakes used to learn how the chefs' real use compares with the suggestion. */
const CALIBRATION_DAYS = 60;
const MIN_CALIBRATION_SAMPLES = 3;
const CALIBRATION_CLAMP: [number, number] = [0.5, 2];
/** The usual rate takes over from bookings over this many days. */
const RAMP_DAYS = 7;

export type ForecastStatus = 'ok' | 'reorder_soon' | 'stockout_soon' | 'out' | 'no_data';

export interface ForecastPoint {
  date: string;
  /** Past days and today use the real stock. Later days are projected. */
  kind: 'actual' | 'today' | 'projected';
  /** Stock at the end of the day: real up to now, projected after. */
  stock: number;
  /** Real confirmed use that day, or the expected use for a future day. */
  used: number;
  /** Future days only: use coming from cakes already booked, after correcting with real use. */
  booked: number;
  /** Future days only: the part of the expected use that comes from the usual daily rate. */
  usual: number;
}

export interface ForecastRow {
  ingredientId: string;
  name: string;
  unit: BaseUnit;
  onHand: number;
  onHandText: string;
  reorderLevel: number | null;
  status: ForecastStatus;
  /** Days from today until stock runs out (0 means during today). Null when it does not within the horizon. */
  daysUntilOut: number | null;
  outDate: string | null;
  /** Days until stock reaches the reorder level. Null when it does not, or there is no level. */
  daysUntilReorder: number | null;
  reorderDate: string | null;
  /** How much to have on the shelf to cover the whole horizon, beyond what is on hand. 0 when nothing is needed. */
  shortfallInHorizon: number;
  shortfallText: string;
  /** What the kitchen usually uses a day (kg, l or pcs). Null with too little history. */
  usualPerDay: number | null;
  /** Use expected over the next 7 days, from bookings and the usual rate. */
  next7Days: number;
  next7DaysText: string;
  /** high: the usual rate is known and bookings exist. medium: one of them. low: neither. */
  confidence: 'high' | 'medium' | 'low';
  /** How the chefs' real use has compared with the suggestions. 1.1 means they use about 10% more. */
  calibration: { factor: number; samples: number; applied: boolean };
  /** One plain sentence. */
  text: string;
  series: ForecastPoint[];
}

export interface BookedLine {
  /** The day the ingredients are expected to leave stock. */
  date: string;
  ingredientId: string;
  qty: number;
}

export interface CalibrationSample {
  ingredientId: string;
  suggested: number;
  actual: number;
  at: string;
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const localDate = (iso: string) => todayLocal(new Date(iso));

/** The kitchen's usual use per day from confirmed usage (kg, l or pcs). Null when there is too little history (BR-14). */
export function usualDailyUse(usage: IngredientMovement[], now: Date): number | null {
  const used = usage.filter((m) => m.reason === 'usage');
  if (used.length < MIN_USAGE_RECORDS) return null;
  const first = Math.min(...used.map((m) => Date.parse(m.at)));
  const historyDays = (now.getTime() - first) / 86_400_000;
  if (historyDays < MIN_HISTORY_DAYS) return null;
  const windowDays = Math.min(USAGE_WINDOW_DAYS, historyDays);
  const since = now.getTime() - windowDays * 86_400_000;
  const total = used.filter((m) => Date.parse(m.at) >= since).reduce((s, m) => s - m.qty, 0);
  return total <= 0 ? 0 : total / windowDays;
}

/** Real use compared with the suggestion, for one ingredient. Needs a few cakes before it is trusted. */
export function calibrationFor(samples: CalibrationSample[], now: Date): { factor: number; samples: number; applied: boolean } {
  const since = now.getTime() - CALIBRATION_DAYS * 86_400_000;
  const recent = samples.filter((s) => s.suggested > 0 && Date.parse(s.at) >= since);
  if (recent.length < MIN_CALIBRATION_SAMPLES) return { factor: 1, samples: recent.length, applied: false };
  const raw = recent.reduce((s, x) => s + x.actual, 0) / recent.reduce((s, x) => s + x.suggested, 0);
  const factor = Math.min(CALIBRATION_CLAMP[1], Math.max(CALIBRATION_CLAMP[0], raw));
  return { factor: Math.round(factor * 100) / 100, samples: recent.length, applied: true };
}

export interface ForecastInput {
  now: Date;
  ingredient: Ingredient;
  /** Every stock movement for this ingredient. */
  movements: IngredientMovement[];
  booked: BookedLine[];
  samples: CalibrationSample[];
  /** True when at least one recipe line mentions this ingredient. */
  hasRecipe: boolean;
  options?: Partial<ForecastOptions>;
}

export function forecastIngredient(input: ForecastInput): ForecastRow {
  const o: ForecastOptions = { ...FORECAST_DEFAULTS, ...input.options };
  const { now, ingredient: ing } = input;
  const today = todayLocal(now);
  const usage = input.movements.filter((m) => m.reason === 'usage');
  const usual = usualDailyUse(usage, now);
  const calibration = calibrationFor(input.samples, now);

  // Booked use per future day, corrected by how the chefs really use it.
  const bookedByDay = new Map<string, number>();
  for (const b of input.booked) if (b.ingredientId === ing.id) bookedByDay.set(b.date, (bookedByDay.get(b.date) ?? 0) + b.qty * calibration.factor);

  // Real use per past day.
  const usedByDay = new Map<string, number>();
  for (const m of usage) usedByDay.set(localDate(m.at), (usedByDay.get(localDate(m.at)) ?? 0) - m.qty);

  const series: ForecastPoint[] = [];
  // Past and today: walk back from the stock on hand by undoing movements.
  for (let k = -o.historyDays; k <= 0; k++) {
    const date = addDays(today, k);
    const after = input.movements.filter((m) => localDate(m.at) > date).reduce((s, m) => s + m.qty, 0);
    series.push({ date, kind: k === 0 ? 'today' : 'actual', stock: roundQty(ing.onHand - after), used: roundQty(usedByDay.get(date) ?? 0), booked: 0, usual: 0 });
  }

  // Future: bookings, drifting toward the usual rate.
  let stock = ing.onHand;
  let cumulative = 0;
  let outAt: number | null = null;
  let reorderAt: number | null = null;
  let totalNeed = 0;
  let next7 = 0;
  const level = ing.reorderLevel;
  if (level !== undefined && stock <= level) reorderAt = 0;
  for (let k = 0; k <= o.horizonDays; k++) {
    const date = addDays(today, k);
    const booked = k === 0 ? [...bookedByDay.entries()].filter(([d]) => d <= today).reduce((s, [, q]) => s + q, 0) : (bookedByDay.get(date) ?? 0);
    const usualPart = usual === null ? 0 : usual * Math.min(1, k / RAMP_DAYS);
    const expected = Math.max(booked, usualPart);
    cumulative += expected;
    totalNeed += expected;
    if (k < 7) next7 += expected;
    stock = roundQty(ing.onHand - cumulative);
    if (outAt === null && stock < 0) outAt = k;
    if (reorderAt === null && level !== undefined && stock <= level) reorderAt = k;
    if (k > 0)
      series.push({
        date,
        kind: 'projected',
        stock,
        used: roundQty(expected),
        booked: roundQty(booked),
        usual: roundQty(Math.max(0, expected - booked)),
      });
  }

  const shortfall = roundQty(Math.max(0, totalNeed - ing.onHand));
  const inPlay = ing.reorderLevel !== undefined || input.hasRecipe || usage.length > 0 || input.booked.some((b) => b.ingredientId === ing.id);
  const hasBooked = bookedByDay.size > 0;
  const confidence: ForecastRow['confidence'] = usual !== null && hasBooked ? 'high' : usual !== null || hasBooked ? 'medium' : 'low';

  let status: ForecastStatus;
  if (!inPlay) status = 'no_data';
  else if (ing.onHand <= 0) status = 'out';
  else if (outAt !== null && outAt <= o.stockoutDays) status = 'stockout_soon';
  else if (reorderAt !== null && reorderAt <= o.reorderDays) status = 'reorder_soon';
  else if (usual === null && !hasBooked) status = 'no_data';
  else status = 'ok';

  const when = (k: number) => (k === 0 ? 'today' : k === 1 ? 'tomorrow' : `in ${k} days (${addDays(today, k)})`);
  let text: string;
  switch (status) {
    case 'out':
      text = `${ing.name} is out of stock.`;
      break;
    case 'stockout_soon':
      text = `${ing.name} is expected to run out ${when(outAt!)}. About ${formatQty(shortfall, ing.unit)} more is needed over the next ${o.horizonDays} days.`;
      break;
    case 'reorder_soon':
      text = reorderAt === 0 ? `${ing.name} is at or below its reorder level.` : `${ing.name} reaches its reorder level ${when(reorderAt!)}.`;
      break;
    case 'no_data':
      text = inPlay ? `Not enough history yet to forecast ${ing.name}. It improves as the chefs' usage is confirmed.` : `${ing.name} has no recipe lines or usage yet, so there is nothing to forecast.`;
      break;
    default:
      text = outAt === null ? `${ing.name} should last beyond the next ${o.horizonDays} days at the expected rate.` : `${ing.name} is expected to run out ${when(outAt)}.`;
  }

  return {
    ingredientId: ing.id,
    name: ing.name,
    unit: ing.unit,
    onHand: ing.onHand,
    onHandText: formatQty(ing.onHand, ing.unit),
    reorderLevel: ing.reorderLevel ?? null,
    status,
    daysUntilOut: outAt,
    outDate: outAt === null ? null : addDays(today, outAt),
    daysUntilReorder: level === undefined ? null : reorderAt,
    reorderDate: level === undefined || reorderAt === null ? null : addDays(today, reorderAt),
    shortfallInHorizon: shortfall,
    shortfallText: formatQty(shortfall, ing.unit),
    usualPerDay: usual === null ? null : roundQty(usual),
    next7Days: roundQty(next7),
    next7DaysText: formatQty(next7, ing.unit),
    confidence,
    calibration,
    text,
    series,
  };
}

/* ---------- Loading the inputs from the store ---------- */

const NOT_YET_BAKED: OrderLine['status'][] = ['new', 'in_production', 'decorating'];

/**
 * Turns every custom cake still to be baked into ingredient amounts on a day.
 * A cake already confirmed by Inventory is skipped (its stock has moved). A cake whose report is waiting still counts,
 * because its stock has not moved yet.
 */
export async function loadBookedLines(store: Store, now: Date, bakeLeadDays: number): Promise<BookedLine[]> {
  const today = todayLocal(now);
  const lines = (await store.find<OrderLine>('orderLines', { where: { status: NOT_YET_BAKED } })).filter((l) => l.custom);
  if (lines.length === 0) return [];
  const [rules, ingredients, orders, reports, suggestions] = await Promise.all([
    store.list<RecipeRule>('recipeRules'),
    store.list<Ingredient>('ingredients'),
    store.find<Order>('orders', { where: { id: [...new Set(lines.map((l) => l.orderId))] } }),
    store.find<UsageReport>('usageReports', { where: { lineId: lines.map((l) => l.id) } }),
    store.find<UsageSuggestion>('usageSuggestions', { where: { lineId: lines.map((l) => l.id) } }),
  ]);
  const out: BookedLine[] = [];
  for (const line of lines) {
    const mine = reports.filter((r) => r.lineId === line.id);
    if (mine.some((r) => r.status === 'confirmed')) continue;
    const order = orders.find((o) => o.id === line.orderId);
    if (!order) continue;
    const suggestion = suggestions.find((s) => s.lineId === line.id);
    const amounts = suggestion?.lines ?? generateSuggestionLines(line.custom!.spec, rules, ingredients);
    const started = line.status !== 'new';
    let date = started || !order.deliveryDate ? today : addDays(order.deliveryDate, -bakeLeadDays);
    if (date < today) date = today;
    for (const a of amounts) out.push({ date, ingredientId: a.ingredientId, qty: a.qty });
  }
  return out;
}

/** Confirmed cakes where we know both what was suggested and what was really used. */
export async function loadCalibrationSamples(store: Store): Promise<CalibrationSample[]> {
  const confirmed = await store.find<UsageReport>('usageReports', { where: { status: 'confirmed' } });
  if (confirmed.length === 0) return [];
  const suggestions = await store.find<UsageSuggestion>('usageSuggestions', { where: { lineId: confirmed.map((r) => r.lineId) } });
  const out: CalibrationSample[] = [];
  for (const r of confirmed) {
    const sug = suggestions.find((s) => s.lineId === r.lineId);
    if (!sug || !r.confirmedAt) continue;
    for (const c of r.confirmed ?? []) {
      const line = sug.lines.find((l) => l.ingredientId === c.ingredientId);
      if (line) out.push({ ingredientId: c.ingredientId, suggested: line.qty, actual: c.qty, at: r.confirmedAt });
    }
  }
  return out;
}

/** The forecast for every active ingredient, most urgent first. */
export async function buildForecasts(store: Store, now: Date, options: Partial<ForecastOptions> = {}): Promise<ForecastRow[]> {
  const o = { ...FORECAST_DEFAULTS, ...options };
  const [ingredients, movements, rules, booked, samples] = await Promise.all([
    store.list<Ingredient>('ingredients'),
    store.list<IngredientMovement>('ingredientMovements'),
    store.list<RecipeRule>('recipeRules'),
    loadBookedLines(store, now, o.bakeLeadDays),
    loadCalibrationSamples(store),
  ]);
  const order: Record<ForecastStatus, number> = { out: 0, stockout_soon: 1, reorder_soon: 2, ok: 3, no_data: 4 };
  return ingredients
    .filter((i) => i.active)
    .map((ingredient) =>
      forecastIngredient({
        now,
        ingredient,
        movements: movements.filter((m) => m.ingredientId === ingredient.id),
        booked,
        samples: samples.filter((s) => s.ingredientId === ingredient.id),
        hasRecipe: rules.some((r) => r.ingredientId === ingredient.id),
        options: o,
      }),
    )
    .sort((a, b) => order[a.status] - order[b.status] || (a.daysUntilOut ?? 999) - (b.daysUntilOut ?? 999) || a.name.localeCompare(b.name));
}

