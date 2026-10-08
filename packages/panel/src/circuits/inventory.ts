import type { Ingredient, IngredientMovement, IngredientRange, RecipeRule } from '../domain';
import type { HandlerCtx, Registry } from '../intents';
import { baseUnitOf, formatQty, roundQty, toBaseQty, unitMismatch, type BaseUnit } from '../units';

/** Stock arithmetic is kept to a milligram / millilitre so nothing is lost when quantities are converted. */
export const round3 = roundQty;

/** A quantity written in `unit` (or already in the ingredient's base unit) as the ingredient's base unit. Null if the unit does not fit. */
export const qtyFor = (ing: Pick<Ingredient, 'unit'>, qty: number, unit?: string) => toBaseQty(qty, ing.unit, unit);

/** The one-line error for a unit that does not fit an ingredient, or null when it fits (or none was given). */
export const unitProblem = (ing: Pick<Ingredient, 'unit' | 'name'>, unit?: string) =>
  unit === undefined || toBaseQty(1, ing.unit, unit) !== null ? null : unitMismatch(ing.name, ing.unit, unit);

interface RangeInput {
  id?: string;
  label: string;
  min: number;
  max: number;
}

function rangeProblems(ranges: RangeInput[] | undefined): string[] {
  if (!ranges) return [];
  const errors: string[] = [];
  for (const r of ranges) {
    if (!r.label.trim()) errors.push('Give each amount a name, such as "Light".');
    else if (!(r.min >= 0) || !(r.max >= r.min)) errors.push(`Check the amounts for "${r.label}": the top must not be below the bottom.`);
  }
  if (new Set(ranges.map((r) => r.label.trim().toLowerCase())).size !== ranges.length) errors.push('Two amounts have the same name.');
  return errors;
}

const toRanges = (ctx: HandlerCtx, ranges: RangeInput[], base: BaseUnit, unit?: string): IngredientRange[] =>
  ranges.map((r) => ({ id: r.id ?? ctx.ids.next('rng'), label: r.label.trim(), min: toBaseQty(r.min, base, unit)!, max: toBaseQty(r.max, base, unit)! }));

export async function moveIngredient(ctx: HandlerCtx, ing: Ingredient, m: Omit<IngredientMovement, 'id' | 'ingredientId' | 'by' | 'at'>) {
  const movement: IngredientMovement = { id: ctx.ids.next('imv'), ingredientId: ing.id, by: ctx.session!.userId, at: ctx.now(), ...m };
  await ctx.store.put('ingredientMovements', movement);
  return movement;
}

/** An alert-worthy drop: on hand fell to or below the reorder level from above it. */
export const crossedReorder = (before: number, after: number, level?: number) => level !== undefined && before > level && after <= level;

/**
 * Set an item's stock to what was counted. Writes the correction movement, remembers when it was counted, and says
 * whether the item fell to its reorder level. Used by a single count and by the daily count.
 */
export async function applyCount(ctx: HandlerCtx, ing: Ingredient, counted: number, note?: string) {
  const delta = round3(counted - ing.onHand);
  await ctx.store.put('ingredients', { ...ing, onHand: counted, countedAt: ctx.now() });
  if (delta !== 0) await moveIngredient(ctx, ing, { qty: delta, reason: 'correction', note });
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [{ type: 'StockMoved', payload: { ingredientId: ing.id, delta } }];
  if (crossedReorder(ing.onHand, counted, ing.reorderLevel)) events.push({ type: 'ReorderLevelBreached', payload: { ingredientId: ing.id } });
  return { delta, events };
}

export const inventoryIntents = {
  'inventory/create_ingredient': {
    circuit: 'Inventory',
    roles: ['owner', 'inventory'],
    validate: async (p, ctx) => {
      const errors: string[] = [];
      if (!p.name.trim()) errors.push('Enter a name.');
      const dupe = (await ctx.store.list<Ingredient>('ingredients')).some((i) => i.name.trim().toLowerCase() === p.name.trim().toLowerCase());
      if (dupe) errors.push('There is already an ingredient with that name.');
      if (p.openingStock !== undefined && !(p.openingStock >= 0)) errors.push('Opening stock cannot be negative.');
      errors.push(...rangeProblems(p.ranges));
      if (p.kind === 'packaging' && p.ranges?.length) errors.push('Packaging has no usage amounts for the baker.');
      return errors;
    },
    handle: async (p, ctx) => {
      // The unit chosen decides the kind (weight, volume, count); everything is stored in that kind's base unit.
      const base = baseUnitOf(p.unit);
      const ing: Ingredient = {
        id: ctx.ids.next('ing'),
        name: p.name.trim(),
        unit: base,
        onHand: p.openingStock === undefined ? 0 : toBaseQty(p.openingStock, base, p.unit)!,
        reorderLevel: p.reorderLevel === undefined ? undefined : toBaseQty(p.reorderLevel, base, p.unit)!,
        allergens: [...new Set((p.allergens ?? []).map((a) => a.trim()).filter(Boolean))],
        ranges: toRanges(ctx, p.ranges ?? [], base, p.unit),
        active: true,
        kind: p.kind ?? 'ingredient',
        createdAt: ctx.now(),
      };
      await ctx.store.put('ingredients', ing);
      if (ing.onHand > 0) await moveIngredient(ctx, ing, { qty: ing.onHand, reason: 'opening' });
      return { summary: `Added ingredient ${ing.name}`, target: ing.id, data: { ingredientId: ing.id }, events: [{ type: 'IngredientAdded', payload: { ingredientId: ing.id } }] };
    },
  },

  'inventory/update_ingredient': {
    circuit: 'Inventory',
    roles: ['owner', 'inventory'],
    validate: async (p, ctx) => {
      const ing = await ctx.store.get<Ingredient>('ingredients', p.ingredientId);
      if (!ing) return ['That ingredient does not exist.'];
      const errors: string[] = [];
      if (p.name !== undefined) {
        if (!p.name.trim()) errors.push('Enter a name.');
        const dupe = (await ctx.store.list<Ingredient>('ingredients')).some((i) => i.id !== ing.id && i.name.trim().toLowerCase() === p.name!.trim().toLowerCase());
        if (dupe) errors.push('There is already an ingredient with that name.');
      }
      if (p.reorderLevel !== undefined && p.reorderLevel !== null && !(p.reorderLevel >= 0)) errors.push('The reorder level cannot be negative.');
      errors.push(...rangeProblems(p.ranges));
      const bad = unitProblem(ing, p.unit);
      if (bad) errors.push(bad);
      if (p.kind === 'packaging' && (ing.kind ?? 'ingredient') !== 'packaging') {
        const used = (await ctx.store.list<RecipeRule>('recipeRules')).some((r) => r.ingredientId === ing.id);
        if (used) errors.push(`${ing.name} is used in a recipe rule, so it cannot be packaging.`);
        if ((p.ranges ?? ing.ranges).length) errors.push('Remove its usage amounts first. Packaging has none.');
      }
      if ((p.kind ?? ing.kind) === 'packaging' && p.ranges?.length) errors.push('Packaging has no usage amounts for the baker.');
      return errors;
    },
    handle: async (p, ctx) => {
      const ing = (await ctx.store.get<Ingredient>('ingredients', p.ingredientId))!;
      const next: Ingredient = {
        ...ing,
        name: p.name !== undefined ? p.name.trim() : ing.name,
        reorderLevel: p.reorderLevel === undefined ? ing.reorderLevel : p.reorderLevel === null ? undefined : toBaseQty(p.reorderLevel, ing.unit, p.unit)!,
        allergens: p.allergens ? [...new Set(p.allergens.map((a) => a.trim()).filter(Boolean))] : ing.allergens,
        ranges: p.ranges ? toRanges(ctx, p.ranges, ing.unit, p.unit) : ing.ranges,
        active: p.active ?? ing.active,
        kind: p.kind ?? ing.kind,
      };
      await ctx.store.put('ingredients', next);
      return { summary: `Changed ingredient ${next.name}`, target: ing.id, events: [{ type: 'IngredientChanged', payload: { ingredientId: ing.id } }] };
    },
  },

  'inventory/receive': {
    circuit: 'Inventory',
    roles: ['owner', 'inventory'],
    validate: async (p, ctx) => {
      if (!(p.qty > 0)) return ['Enter an amount greater than zero.'];
      const ing = await ctx.store.get<Ingredient>('ingredients', p.ingredientId);
      if (!ing) return ['That ingredient does not exist.'];
      const bad = unitProblem(ing, p.unit);
      if (bad) return [bad];
      return qtyFor(ing, p.qty, p.unit)! > 0 ? [] : ['That amount is too small to count.'];
    },
    handle: async (p, ctx) => {
      const ing = (await ctx.store.get<Ingredient>('ingredients', p.ingredientId))!;
      const qty = qtyFor(ing, p.qty, p.unit)!;
      const next = { ...ing, onHand: round3(ing.onHand + qty) };
      await ctx.store.put('ingredients', next);
      await moveIngredient(ctx, ing, { qty, reason: 'delivery', note: p.note?.trim() || undefined });
      return {
        summary: `Received ${formatQty(qty, ing.unit)} of ${ing.name}`,
        target: ing.id,
        events: [{ type: 'StockMoved', payload: { ingredientId: ing.id, delta: qty } }],
      };
    },
  },

  'inventory/count': {
    circuit: 'Inventory',
    roles: ['owner', 'inventory'],
    validate: async (p, ctx) => {
      if (!(p.counted >= 0)) return ['The count cannot be negative.'];
      const ing = await ctx.store.get<Ingredient>('ingredients', p.ingredientId);
      if (!ing) return ['That ingredient does not exist.'];
      const bad = unitProblem(ing, p.unit);
      return bad ? [bad] : [];
    },
    handle: async (p, ctx) => {
      const ing = (await ctx.store.get<Ingredient>('ingredients', p.ingredientId))!;
      const counted = qtyFor(ing, p.counted, p.unit)!;
      const { events } = await applyCount(ctx, ing, counted, p.note?.trim() || undefined);
      return { summary: `Counted ${ing.name}: ${formatQty(counted, ing.unit)} (was ${formatQty(ing.onHand, ing.unit)})`, target: ing.id, events };
    },
  },

  'inventory/write_off': {
    circuit: 'Inventory',
    roles: ['owner', 'inventory'],
    validate: async (p, ctx) => {
      if (!(p.qty > 0)) return ['Enter an amount greater than zero.'];
      if (!p.note?.trim()) return ['Say what happened, such as "spoiled" or "spilled".'];
      const ing = await ctx.store.get<Ingredient>('ingredients', p.ingredientId);
      if (!ing) return ['That ingredient does not exist.'];
      const bad = unitProblem(ing, p.unit);
      if (bad) return [bad];
      if (qtyFor(ing, p.qty, p.unit)! > ing.onHand) return [`Only ${formatQty(ing.onHand, ing.unit)} is on hand.`];
      return [];
    },
    handle: async (p, ctx) => {
      const ing = (await ctx.store.get<Ingredient>('ingredients', p.ingredientId))!;
      const qty = qtyFor(ing, p.qty, p.unit)!;
      const after = round3(ing.onHand - qty);
      await ctx.store.put('ingredients', { ...ing, onHand: after });
      await moveIngredient(ctx, ing, { qty: -qty, reason: 'waste', note: p.note!.trim() });
      const events: Array<{ type: string; payload?: Record<string, unknown> }> = [{ type: 'StockMoved', payload: { ingredientId: ing.id, delta: -qty } }];
      if (crossedReorder(ing.onHand, after, ing.reorderLevel)) events.push({ type: 'ReorderLevelBreached', payload: { ingredientId: ing.id } });
      return { summary: `Wrote off ${formatQty(qty, ing.unit)} of ${ing.name}: ${p.note!.trim()}`, target: ing.id, events };
    },
  },
} satisfies Partial<Registry>;
