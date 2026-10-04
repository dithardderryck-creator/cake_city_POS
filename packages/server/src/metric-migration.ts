import type Database from 'better-sqlite3';
import { legacyBase, legacyFactor, roundQty } from '@cake-pos/panel';

type Doc = Record<string, any>;

/**
 * Migration 2: stock used to be kept in g and ml. The shop's base units are now kg and l (D-62), so every stored
 * quantity that was in g or ml is divided by 1000 and its unit relabelled. kg, l and pcs are left alone.
 * Safe on a database that has no ingredient tables yet.
 */
export function convertToMetric(db: Database.Database): { ingredients: number } {
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!has('ingredients')) return { ingredients: 0 };

  const rows = (t: string): Array<{ id: string; doc: Doc }> =>
    has(t) ? (db.prepare(`SELECT id, data FROM "${t}"`).all() as Array<{ id: string; data: string }>).map((r) => ({ id: r.id, doc: JSON.parse(r.data) })) : [];
  const save = (t: string, id: string, doc: Doc) => db.prepare(`UPDATE "${t}" SET data = ? WHERE id = ?`).run(JSON.stringify(doc), id);
  const scale = (n: unknown, f: number) => (typeof n === 'number' ? roundQty(n * f) : n);

  const factorOf = new Map<string, number>();
  const ingredients = rows('ingredients');
  for (const { id, doc } of ingredients) {
    const f = legacyFactor(doc.unit);
    factorOf.set(id, f);
    doc.unit = legacyBase(doc.unit);
    doc.onHand = scale(doc.onHand, f);
    if (doc.reorderLevel !== undefined) doc.reorderLevel = scale(doc.reorderLevel, f);
    for (const r of doc.ranges ?? []) {
      r.min = scale(r.min, f);
      r.max = scale(r.max, f);
    }
    save('ingredients', id, doc);
  }

  for (const { id, doc } of rows('ingredientMovements')) {
    const f = factorOf.get(doc.ingredientId) ?? 1;
    if (f === 1) continue;
    doc.qty = scale(doc.qty, f);
    if (doc.shortfall !== undefined) doc.shortfall = scale(doc.shortfall, f);
    save('ingredientMovements', id, doc);
  }
  for (const { id, doc } of rows('recipeRules')) {
    const f = factorOf.get(doc.ingredientId) ?? 1;
    if (f === 1) continue;
    doc.quantity = scale(doc.quantity, f);
    save('recipeRules', id, doc);
  }
  for (const { id, doc } of rows('usageSuggestions')) {
    for (const l of doc.lines ?? []) {
      const f = legacyFactor(l.unit);
      l.unit = legacyBase(l.unit);
      l.qty = scale(l.qty, f);
    }
    save('usageSuggestions', id, doc);
  }
  for (const { id, doc } of rows('usageReports')) {
    for (const it of doc.items ?? []) {
      const f = legacyFactor(it.unit);
      it.unit = legacyBase(it.unit);
      it.min = scale(it.min, f);
      it.max = scale(it.max, f);
    }
    for (const c of doc.confirmed ?? []) c.qty = scale(c.qty, factorOf.get(c.ingredientId) ?? 1);
    save('usageReports', id, doc);
  }
  return { ingredients: ingredients.length };
}
