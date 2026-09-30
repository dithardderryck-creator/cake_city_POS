import type { Combination, StockMovement } from '../domain';
import { DomainError, type Registry } from '../intents';

export const stockIntents = {
  'stock/set_count': {
    circuit: 'Stock',
    roles: ['owner', 'inventory'],
    validate: (p) => (Number.isInteger(p.count) && p.count >= 0 ? [] : ['Enter a whole number of zero or more.']),
    handle: async (p, ctx) => {
      const combo = await ctx.store.get<Combination>('combinations', p.combinationId);
      if (!combo) throw new DomainError('invalid', ['That combination no longer exists.']);
      const delta = p.count - combo.stockCount;
      await ctx.store.put('combinations', { ...combo, stockCount: p.count });
      const movement: StockMovement = {
        id: ctx.ids.next('mov'),
        combinationId: combo.id,
        qty: delta,
        reason: 'adjustment',
        by: ctx.session!.userId,
        at: ctx.now(),
      };
      await ctx.store.put('stockMovements', movement);
      return {
        summary: `Stock set to ${p.count}`,
        target: combo.id,
        events: [{ type: 'StockMoved', payload: { combinationId: combo.id, delta } }],
      };
    },
  },
} satisfies Partial<Registry>;
