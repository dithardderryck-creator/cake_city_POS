import type { Ingredient, UsageReport, UsageReportItem, UsageSuggestion } from '../domain';
import type { Registry } from '../intents';
import { loadCustomLine } from './custom';
import { crossedReorder, moveIngredient, round3 } from './inventory';

/** A cake can have its usage reported once it has been started and until it is handed over. */
const REPORTABLE = ['in_production', 'decorating', 'ready', 'out_for_delivery', 'completed'];

export const REPORT_OPEN = ['reported'];

export async function openReportFor(ctx: { store: { find: Function } }, lineId: string): Promise<UsageReport | undefined> {
  const reports = (await ctx.store.find('usageReports', { where: { lineId } })) as UsageReport[];
  return reports.find((r) => r.status === 'reported');
}

export const usageIntents = {
  'usage/report': {
    circuit: 'Usage',
    roles: ['owner', 'baker'],
    validate: async (p, ctx) => {
      const { line } = await loadCustomLine(ctx, p.orderId, p.lineId);
      if (!REPORTABLE.includes(line.status)) return ['Start baking this cake before reporting what was used.'];
      if (p.items.length === 0) return ['Tick at least one ingredient.'];
      if (await openReportFor(ctx, line.id)) return ['A report for this cake is already waiting for Inventory.'];
      const seen = new Set<string>();
      const errors: string[] = [];
      for (const it of p.items) {
        if (seen.has(it.ingredientId)) {
          errors.push('An ingredient is listed twice.');
          continue;
        }
        seen.add(it.ingredientId);
        const ing = await ctx.store.get<Ingredient>('ingredients', it.ingredientId);
        if (!ing) errors.push('An ingredient on the list no longer exists.');
        else if (!ing.active) errors.push(`${ing.name} is switched off.`);
        else if (!ing.ranges.some((r) => r.id === it.rangeId)) errors.push(`Choose an amount for ${ing.name} from its list.`);
      }
      return errors;
    },
    handle: async (p, ctx) => {
      const { order, line } = await loadCustomLine(ctx, p.orderId, p.lineId);
      const suggestion = await ctx.store.get<UsageSuggestion>('usageSuggestions', line.id);
      const suggested = new Set((suggestion?.lines ?? []).map((l) => l.ingredientId));
      const items: UsageReportItem[] = [];
      for (const it of p.items) {
        const ing = (await ctx.store.get<Ingredient>('ingredients', it.ingredientId))!;
        const range = ing.ranges.find((r) => r.id === it.rangeId)!;
        items.push({
          ingredientId: ing.id,
          name: ing.name,
          unit: ing.unit,
          rangeId: range.id,
          rangeLabel: range.label,
          min: range.min,
          max: range.max,
          extra: !suggested.has(ing.id),
        });
      }
      const report: UsageReport = {
        id: ctx.ids.next('rep'),
        orderId: order.id,
        lineId: line.id,
        status: 'reported',
        items,
        reportedBy: ctx.session!.userId,
        reportedByName: ctx.session!.name,
        reportedAt: ctx.now(),
        note: p.note?.trim() || undefined,
      };
      // BR-12: a report alone never moves stock. It waits for Inventory (BR-13).
      await ctx.store.put('usageReports', report);
      return {
        summary: `Reported ingredients used for order ${order.number} (${items.length} items)`,
        target: report.id,
        data: { reportId: report.id },
        events: [{ type: 'UsageReported', payload: { reportId: report.id, orderId: order.id, lineId: line.id } }],
      };
    },
  },

  'usage/confirm': {
    circuit: 'Usage',
    roles: ['owner', 'inventory'],
    validate: async (p, ctx) => {
      const report = await ctx.store.get<UsageReport>('usageReports', p.reportId);
      if (!report) return ['That report no longer exists.'];
      if (report.status !== 'reported') return ['This report has already been dealt with.'];
      const errors: string[] = [];
      const wanted = new Set(report.items.map((i) => i.ingredientId));
      const given = new Set<string>();
      for (const it of p.items) {
        if (!wanted.has(it.ingredientId)) errors.push('One amount is for an ingredient that is not in the report.');
        else if (given.has(it.ingredientId)) errors.push('An ingredient is listed twice.');
        else if (!(it.qty >= 0)) errors.push('Amounts cannot be negative.');
        given.add(it.ingredientId);
      }
      for (const w of wanted) if (!given.has(w)) errors.push('Enter the exact amount for every ingredient in the report (0 if none was used).');
      return [...new Set(errors)];
    },
    handle: async (p, ctx) => {
      const report = (await ctx.store.get<UsageReport>('usageReports', p.reportId))!;
      const warnings: string[] = [];
      const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
      for (const it of p.items) {
        const ing = (await ctx.store.get<Ingredient>('ingredients', it.ingredientId))!;
        const item = report.items.find((i) => i.ingredientId === it.ingredientId)!;
        if (it.qty < item.min || it.qty > item.max)
          warnings.push(`${ing.name}: ${it.qty} ${ing.unit} is outside the "${item.rangeLabel}" amount the baker chose (${item.min} to ${item.max}).`);
        const taken = Math.min(ing.onHand, it.qty);
        const shortfall = round3(it.qty - taken);
        const after = round3(ing.onHand - taken);
        await ctx.store.put('ingredients', { ...ing, onHand: after });
        if (it.qty > 0)
          await moveIngredient(ctx, ing, { qty: -taken, reason: 'usage', shortfall: shortfall > 0 ? shortfall : undefined, reportId: report.id, orderId: report.orderId });
        events.push({ type: 'StockMoved', payload: { ingredientId: ing.id, delta: -taken } });
        if (shortfall > 0) warnings.push(`${ing.name}: only ${ing.onHand} ${ing.unit} was on hand, so the count is ${shortfall} ${ing.unit} short. Do a stock count.`);
        if (crossedReorder(ing.onHand, after, ing.reorderLevel)) events.push({ type: 'ReorderLevelBreached', payload: { ingredientId: ing.id } });
      }
      await ctx.store.put('usageReports', {
        ...report,
        status: 'confirmed' as const,
        confirmed: p.items.map((i) => ({ ingredientId: i.ingredientId, qty: i.qty })),
        confirmedBy: ctx.session!.userId,
        confirmedByName: ctx.session!.name,
        confirmedAt: ctx.now(),
      });
      events.push({ type: 'UsageConfirmed', payload: { reportId: report.id, orderId: report.orderId } });
      return { summary: `Confirmed ingredient usage for a cake (${p.items.length} items); stock updated`, target: report.id, warnings, events };
    },
  },

  'usage/send_back': {
    circuit: 'Usage',
    roles: ['owner', 'inventory'],
    validate: async (p, ctx) => {
      const report = await ctx.store.get<UsageReport>('usageReports', p.reportId);
      if (!report) return ['That report no longer exists.'];
      if (report.status !== 'reported') return ['This report has already been dealt with.'];
      return p.reason.trim() ? [] : ['Say what needs fixing so the baker can correct it.'];
    },
    handle: async (p, ctx) => {
      const report = (await ctx.store.get<UsageReport>('usageReports', p.reportId))!;
      await ctx.store.put('usageReports', { ...report, status: 'sent_back' as const, sentBackReason: p.reason.trim() });
      return { summary: 'Sent a usage report back to the baker', target: report.id, events: [{ type: 'UsageSentBack', payload: { reportId: report.id } }] };
    },
  },
} satisfies Partial<Registry>;
