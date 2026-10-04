/**
 * Units. The shop's base units are metric (D-62): kilograms for weight, litres for liquid, pieces for things you count.
 * Every stored quantity is in the ingredient's base unit. Anything typed in another unit (grams, millilitres, pounds,
 * cups, a dozen) is converted on the way in, so the numbers in the database always add up.
 */

export type Dimension = 'mass' | 'volume' | 'count';
export type BaseUnit = 'kg' | 'l' | 'pcs';

export interface UnitDef {
  code: string;
  label: string;
  dimension: Dimension;
  /** How many base units one of these is (1 g = 0.001 kg). */
  toBase: number;
  /** Shown to the owner so odd ones are not a surprise. */
  note?: string;
}

export const UNITS = [
  { code: 'mg', label: 'milligram', dimension: 'mass', toBase: 0.000001 },
  { code: 'g', label: 'gram', dimension: 'mass', toBase: 0.001 },
  { code: 'kg', label: 'kilogram', dimension: 'mass', toBase: 1 },
  { code: 't', label: 'tonne', dimension: 'mass', toBase: 1000 },
  { code: 'oz', label: 'ounce', dimension: 'mass', toBase: 0.028349523125, note: 'International ounce, 28.3495 g' },
  { code: 'lb', label: 'pound', dimension: 'mass', toBase: 0.45359237, note: 'International pound, 0.4536 kg' },

  { code: 'ml', label: 'millilitre', dimension: 'volume', toBase: 0.001 },
  { code: 'cl', label: 'centilitre', dimension: 'volume', toBase: 0.01 },
  { code: 'dl', label: 'decilitre', dimension: 'volume', toBase: 0.1 },
  { code: 'l', label: 'litre', dimension: 'volume', toBase: 1 },
  { code: 'tsp', label: 'teaspoon', dimension: 'volume', toBase: 0.005, note: 'Metric teaspoon, 5 ml' },
  { code: 'tbsp', label: 'tablespoon', dimension: 'volume', toBase: 0.015, note: 'Metric tablespoon, 15 ml' },
  { code: 'cup', label: 'cup', dimension: 'volume', toBase: 0.25, note: 'Metric cup, 250 ml (a US cup is 237 ml)' },
  { code: 'fl_oz', label: 'fluid ounce', dimension: 'volume', toBase: 0.0295735295625, note: 'US fluid ounce, 29.57 ml' },

  { code: 'pcs', label: 'piece', dimension: 'count', toBase: 1 },
  { code: 'dozen', label: 'dozen', dimension: 'count', toBase: 12 },
] as const satisfies readonly UnitDef[];

export type UnitCode = (typeof UNITS)[number]['code'];
export const UNIT_CODES = UNITS.map((u) => u.code) as [UnitCode, ...UnitCode[]];

export const BASE_UNIT_FOR: Record<Dimension, BaseUnit> = { mass: 'kg', volume: 'l', count: 'pcs' };
export const BASE_UNITS: BaseUnit[] = ['kg', 'l', 'pcs'];

const BY_CODE = new Map<string, UnitDef>(UNITS.map((u) => [u.code, u]));

export const isUnitCode = (s: string): s is UnitCode => BY_CODE.has(s);
export const unitDef = (code: string): UnitDef | undefined => BY_CODE.get(code);
export const baseUnitOf = (code: UnitCode): BaseUnit => BASE_UNIT_FOR[BY_CODE.get(code)!.dimension];

/** Enough decimals for a milligram of anything measured in kilograms or litres, and no floating-point crumbs. */
export const roundQty = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Converts a quantity written in `unit` into the base unit `base`. Returns null when the two cannot be compared
 * (kilograms of something counted in pieces). With no unit given, the number is taken to be in the base unit already.
 */
export function toBaseQty(qty: number, base: BaseUnit, unit?: string): number | null {
  if (unit === undefined) return roundQty(qty);
  const def = BY_CODE.get(unit);
  if (!def || BASE_UNIT_FOR[def.dimension] !== base) return null;
  return roundQty(qty * def.toBase);
}

/** General conversion between any two units of the same kind. Null when they are different kinds. */
export function convert(qty: number, from: string, to: string): number | null {
  const a = BY_CODE.get(from);
  const b = BY_CODE.get(to);
  if (!a || !b || a.dimension !== b.dimension) return null;
  return roundQty((qty * a.toBase) / b.toBase);
}

/** The message shown when a unit does not fit the ingredient. */
export function unitMismatch(ingredientName: string, base: BaseUnit, unit: string): string {
  const what = base === 'kg' ? 'weighed (kg, g, lb...)' : base === 'l' ? 'measured by volume (l, ml, cups...)' : 'counted (pieces, dozen)';
  return BY_CODE.has(unit) ? `${ingredientName} is ${what}, so "${unit}" does not fit.` : `"${unit}" is not a unit this shop knows.`;
}

const trim = (n: number, d: number) => String(Math.round(n * 10 ** d) / 10 ** d);

/** Plain text for a person: 0.25 kg reads "250 g", 1.5 kg reads "1.5 kg", 3 pieces reads "3 pcs". */
export function formatQty(qty: number, base: BaseUnit): string {
  const q = roundQty(qty);
  if (base === 'pcs') return `${trim(q, 3)} pcs`;
  const small = base === 'kg' ? 'g' : 'ml';
  if (q !== 0 && Math.abs(q) < 1) return `${trim(q * 1000, 1)} ${small}`;
  return `${trim(q, 3)} ${base}`;
}

/** The conversion table for the UI's unit pickers. */
export function unitTable() {
  return UNITS.map((u) => ({ code: u.code, label: u.label, dimension: u.dimension, base: BASE_UNIT_FOR[u.dimension], perUnit: u.toBase, note: 'note' in u ? u.note : undefined }));
}

/**
 * Old data stored grams and millilitres. This is the factor that turns an old quantity into the new base unit
 * (used once, by the database migration).
 */
export const legacyFactor = (oldUnit: string): number => (oldUnit === 'g' || oldUnit === 'ml' ? 0.001 : 1);
export const legacyBase = (oldUnit: string): BaseUnit => (oldUnit === 'g' || oldUnit === 'kg' ? 'kg' : oldUnit === 'ml' || oldUnit === 'l' ? 'l' : 'pcs');
