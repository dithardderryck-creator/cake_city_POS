import type { CakeSpec, Ingredient, RecipeRule, UsageSuggestion, UsageSuggestionLine } from '../domain';
import type { HandlerCtx, Registry } from '../intents';
import { DomainError } from '../intents';

/** "Eggless", "eggless" and "Gluten-free" / "gluten free" compare equal. */
export const normaliseTag = (s: string) => s.trim().toLowerCase().replace(/[-_\s]+/g, ' ');

const roundFor = (unit: Ingredient['unit'], n: number) => (unit === 'pcs' ? Math.ceil(n - 1e-9) : Math.round(n * 100) / 100);

export function ruleApplies(rule: RecipeRule, spec: CakeSpec): boolean {
  const dietary = new Set(spec.dietary.map(normaliseTag));
  const flavor = normaliseTag(spec.flavor);
  const filling = spec.filling ? normaliseTag(spec.filling) : null;
  if (rule.flavors.length && !rule.flavors.map(normaliseTag).includes(flavor)) return false;
  if (rule.fillings.length && (filling === null || !rule.fillings.map(normaliseTag).includes(filling))) return false;
  if (!rule.needsDietary.every((d) => dietary.has(normaliseTag(d)))) return false;
  if (rule.excludedByDietary.some((d) => dietary.has(normaliseTag(d)))) return false;
  return true;
}

export function ruleQuantity(rule: RecipeRule, spec: CakeSpec): number {
  switch (rule.scaling) {
    case 'per_serving':
      return rule.quantity * spec.servings;
    case 'per_layer_gap':
      return rule.quantity * spec.servings * Math.max(spec.layers - 1, 0);
    case 'fixed':
      return rule.quantity;
  }
}

/**
 * Works out a likely ingredient list for a cake from the shop's recipe rules. Plain arithmetic, so it gives the
 * same answer every time and needs no internet (D-16). The baker corrects it with what was really used.
 */
export function generateSuggestionLines(spec: CakeSpec, rules: RecipeRule[], ingredients: Ingredient[]): UsageSuggestionLine[] {
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const totals = new Map<string, number>();
  for (const rule of rules) {
    const ing = byId.get(rule.ingredientId);
    if (!ing || !ing.active || !ruleApplies(rule, spec)) continue;
    totals.set(ing.id, (totals.get(ing.id) ?? 0) + ruleQuantity(rule, spec));
  }
  return [...totals.entries()]
    .map(([id, qty]) => {
      const ing = byId.get(id)!;
      return { ingredientId: id, name: ing.name, unit: ing.unit, qty: roundFor(ing.unit, qty) };
    })
    .filter((l) => l.qty > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Stores the suggestion for a cake the first time it goes into production. Returns it (existing or new). */
export async function ensureSuggestion(ctx: HandlerCtx, orderId: string, lineId: string, spec: CakeSpec): Promise<UsageSuggestion> {
  const existing = await ctx.store.get<UsageSuggestion>('usageSuggestions', lineId);
  if (existing) return existing;
  const [rules, ingredients] = await Promise.all([ctx.store.list<RecipeRule>('recipeRules'), ctx.store.list<Ingredient>('ingredients')]);
  const suggestion: UsageSuggestion = {
    id: lineId,
    orderId,
    lineId,
    lines: generateSuggestionLines(spec, rules, ingredients),
    generatedAt: ctx.now(),
    generator: 'rules',
  };
  await ctx.store.put('usageSuggestions', suggestion);
  return suggestion;
}

const cleanTags = (tags: string[] | undefined) => [...new Set((tags ?? []).map((t) => t.trim()).filter(Boolean))];

export const recipeIntents = {
  'recipes/save_rule': {
    circuit: 'Recipes',
    roles: ['owner', 'baker'],
    validate: async (p, ctx) => {
      const errors: string[] = [];
      if (!(p.quantity > 0)) errors.push('Enter an amount greater than zero.');
      const ing = await ctx.store.get<Ingredient>('ingredients', p.ingredientId);
      if (!ing) errors.push('That ingredient does not exist.');
      else if (!ing.active) errors.push(`${ing.name} is switched off.`);
      if (p.ruleId && !(await ctx.store.get<RecipeRule>('recipeRules', p.ruleId))) errors.push('That recipe line no longer exists.');
      return errors;
    },
    handle: async (p, ctx) => {
      const ing = (await ctx.store.get<Ingredient>('ingredients', p.ingredientId))!;
      const rule: RecipeRule = {
        id: p.ruleId ?? ctx.ids.next('rul'),
        ingredientId: p.ingredientId,
        quantity: p.quantity,
        scaling: p.scaling,
        flavors: cleanTags(p.flavors),
        fillings: cleanTags(p.fillings),
        needsDietary: cleanTags(p.needsDietary),
        excludedByDietary: cleanTags(p.excludedByDietary),
        note: p.note?.trim() || undefined,
      };
      await ctx.store.put('recipeRules', rule);
      return {
        summary: `${p.ruleId ? 'Changed' : 'Added'} a recipe line for ${ing.name}`,
        target: rule.id,
        data: { ruleId: rule.id },
        events: [{ type: 'RecipeRuleSaved', payload: { ruleId: rule.id } }],
      };
    },
  },

  'recipes/remove_rule': {
    circuit: 'Recipes',
    roles: ['owner', 'baker'],
    validate: async (p, ctx) => ((await ctx.store.get('recipeRules', p.ruleId)) ? [] : ['That recipe line no longer exists.']),
    handle: async (p, ctx) => {
      const rule = (await ctx.store.get<RecipeRule>('recipeRules', p.ruleId))!;
      const ing = await ctx.store.get<Ingredient>('ingredients', rule.ingredientId);
      await ctx.store.delete('recipeRules', p.ruleId);
      return { summary: `Removed a recipe line for ${ing?.name ?? 'an ingredient'}`, target: p.ruleId };
    },
  },
} satisfies Partial<Registry>;

export { DomainError };
