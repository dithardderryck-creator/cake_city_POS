import type {
  Combination,
  CountDifference,
  Order,
  OrderLine,
  OptionGroup,
  OptionValue,
  Payment,
  Product,
  Refund,
  StockMovement,
} from '../domain';
import { DomainError, type HandlerCtx, type Registry } from '../intents';
import { canAdvance, moneySummary, deriveOrderStatus, activeLines } from './order-logic';

export async function loadOrderBundle(ctx: Pick<HandlerCtx, 'store'>, orderId: string) {
  const order = await ctx.store.get<Order>('orders', orderId);
  if (!order) throw new DomainError('invalid', ['That order no longer exists.']);
  const [lines, payments, refunds] = await Promise.all([
    ctx.store.list<OrderLine>('orderLines'),
    ctx.store.list<Payment>('payments'),
    ctx.store.list<Refund>('refunds'),
  ]);
  return {
    order,
    lines: lines.filter((l) => l.orderId === orderId),
    payments: payments.filter((p) => p.orderId === orderId),
    refunds: refunds.filter((r) => r.orderId === orderId),
  };
}

interface Counter {
  id: string;
  value: number;
}

async function nextOrderNumber(ctx: HandlerCtx) {
  const counter = (await ctx.store.get<Counter>('counters', 'order_seq')) ?? { id: 'order_seq', value: 0 };
  counter.value += 1;
  await ctx.store.put('counters', counter);
  // The device prefix keeps numbers unique when several devices are offline at once (BR-26).
  return `${ctx.config.devicePrefix}-${String(counter.value).padStart(4, '0')}`;
}

const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export const orderIntents = {
  'orders/create_order': {
    circuit: 'Orders',
    roles: ['owner', 'cashier'],
    validate: (p) => {
      const errors: string[] = [];
      if (p.fulfilment === 'delivery' && !p.deliveryAddress?.trim()) errors.push('Add a delivery address.');
      if (p.deliveryDate && !isIsoDate(p.deliveryDate)) errors.push('Choose a valid delivery date.');
      return errors;
    },
    handle: async (p, ctx) => {
      const order: Order = {
        id: ctx.ids.next('ord'),
        number: await nextOrderNumber(ctx),
        customerName: p.customerName?.trim() || 'Walk-in customer',
        source: p.source,
        fulfilment: p.fulfilment,
        deliveryDate: p.deliveryDate,
        deliveryAddress: p.fulfilment === 'delivery' ? p.deliveryAddress?.trim() : undefined,
        partialAllowed: false,
        createdBy: ctx.session!.userId,
        createdAt: ctx.now(),
      };
      await ctx.store.put('orders', order);
      return {
        summary: `Started order ${order.number}`,
        target: order.id,
        data: { orderId: order.id, number: order.number },
        events: [{ type: 'OrderCreated', payload: { orderId: order.id } }],
      };
    },
  },

  'orders/add_catalogue_line': {
    circuit: 'Orders',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      if (!Number.isInteger(p.qty) || p.qty < 1) return ['Enter a quantity of 1 or more.'];
      const { lines, order } = await loadOrderBundle(ctx, p.orderId);
      const status = deriveOrderStatus(lines);
      if (status === 'completed' || status === 'cancelled')
        return [`Order ${order.number} is ${status}. Start a new order instead.`];
      const combo = await ctx.store.get<Combination>('combinations', p.combinationId);
      if (!combo) return ['That item is no longer in the catalogue.'];
      const product = await ctx.store.get<Product>('products', combo.productId);
      if (!product || product.status === 'archived') return ['That product has been archived.'];
      if (!product.availableToday) return [`${product.name} is off the menu today.`];
      if (combo.status !== 'available') return ['That version is not available.'];
      if (combo.price === null) return ['That version has no price yet. Ask the owner to set one.'];
      return [];
    },
    handle: async (p, ctx) => {
      const { lines } = await loadOrderBundle(ctx, p.orderId);
      const combo = (await ctx.store.get<Combination>('combinations', p.combinationId))!;
      const product = (await ctx.store.get<Product>('products', combo.productId))!;

      // Same item already waiting on this order: add to it and keep its frozen price.
      const same = lines.find((l) => l.combinationId === combo.id && l.status === 'new');
      if (same) {
        await ctx.store.put('orderLines', { ...same, qty: same.qty + p.qty });
        return {
          summary: `Added ${p.qty} more ${product.name}`,
          target: same.id,
          data: { lineId: same.id },
          events: [{ type: 'LineAdded', payload: { orderId: p.orderId, lineId: same.id } }],
        };
      }

      const [groups, values] = await Promise.all([
        ctx.store.list<OptionGroup>('optionGroups'),
        ctx.store.list<OptionValue>('optionValues'),
      ]);
      const chosen = values.filter((v) => combo.valueIds.includes(v.id));
      const options: Record<string, string> = {};
      for (const g of groups.sort((a, b) => a.order - b.order)) {
        const v = chosen.find((x) => x.groupId === g.id);
        if (v) options[g.name] = v.label;
      }
      const allergens = [...new Set([...product.allergens, ...chosen.flatMap((v) => v.allergens)])];
      const line: OrderLine = {
        id: ctx.ids.next('lin'),
        orderId: p.orderId,
        type: 'catalogue',
        combinationId: combo.id,
        qty: p.qty,
        snapshot: { productName: product.name, options, unitPrice: combo.price!, allergens },
        status: 'new',
      };
      await ctx.store.put('orderLines', line);
      return {
        summary: `Added ${p.qty} ${product.name}`,
        target: line.id,
        data: { lineId: line.id },
        events: [{ type: 'LineAdded', payload: { orderId: p.orderId, lineId: line.id } }],
      };
    },
  },

  'orders/cancel_line': {
    circuit: 'Orders',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      const { lines, payments } = await loadOrderBundle(ctx, p.orderId);
      const line = lines.find((l) => l.id === p.lineId);
      if (!line) return ['That item is not on the order.'];
      if (line.status !== 'new') return ['Only items that have not been prepared can be removed.'];
      if (payments.length > 0 && ctx.session?.role !== 'owner')
        return ['This order has payments. Ask the owner to change it.'];
      return [];
    },
    handle: async (p, ctx) => {
      const { lines } = await loadOrderBundle(ctx, p.orderId);
      const line = lines.find((l) => l.id === p.lineId)!;
      await ctx.store.put('orderLines', { ...line, status: 'cancelled' as const });
      return { summary: `Removed ${line.snapshot.productName}`, target: line.id };
    },
  },

  'orders/advance_line': {
    circuit: 'Orders',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      const { order, lines } = await loadOrderBundle(ctx, p.orderId);
      const line = lines.find((l) => l.id === p.lineId);
      if (!line) return ['That item is not on the order.'];
      return canAdvance(order, line, p.to) ? [] : ['That step is not available for this item right now.'];
    },
    handle: async (p, ctx) => {
      const bundle = await loadOrderBundle(ctx, p.orderId);
      const line = bundle.lines.find((l) => l.id === p.lineId)!;
      await ctx.store.put('orderLines', { ...line, status: p.to });
      const warnings: string[] = [];
      const events: Array<{ type: string; payload?: Record<string, unknown> }> = [
        { type: 'StatusChanged', payload: { orderId: p.orderId, lineId: line.id, to: p.to } },
      ];

      if (p.to === 'completed') {
        // BR-03: stock drops only now. A shortfall is allowed but recorded, never silently lost.
        const combo = await ctx.store.get<Combination>('combinations', line.combinationId);
        if (combo) {
          const taken = Math.min(combo.stockCount, line.qty);
          const shortfall = line.qty - taken;
          await ctx.store.put('combinations', { ...combo, stockCount: combo.stockCount - taken });
          const movement: StockMovement = {
            id: ctx.ids.next('mov'),
            combinationId: combo.id,
            qty: -taken,
            reason: 'sale',
            orderId: p.orderId,
            by: ctx.session!.userId,
            at: ctx.now(),
          };
          await ctx.store.put('stockMovements', movement);
          events.push({ type: 'StockMoved', payload: { combinationId: combo.id, delta: -taken } });
          if (shortfall > 0) {
            const diff: CountDifference = {
              id: ctx.ids.next('dif'),
              combinationId: combo.id,
              expected: -shortfall,
              counted: 0,
              difference: -shortfall,
              reason: 'shortfall_at_completion',
              orderId: p.orderId,
              at: ctx.now(),
            };
            await ctx.store.put('countDifferences', diff);
            events.push({ type: 'CountDifferenceRecorded', payload: { combinationId: combo.id, shortfall } });
            warnings.push(
              `Stock was short by ${shortfall} for ${line.snapshot.productName}. It has been logged for the daily count.`,
            );
          }
        }
        // Open question Q-01: allowed for now, but flagged.
        const money = moneySummary(bundle.lines, bundle.payments, bundle.refunds);
        if (money.balance > 0) {
          warnings.push(`Order ${bundle.order.number} still has ${ctx.config.formatMoney(money.balance)} unpaid.`);
          events.push({ type: 'BalanceUnpaidAtHandover', payload: { orderId: p.orderId, balance: money.balance } });
        }
      }

      const verb: Record<string, string> = {
        ready: 'Marked ready',
        out_for_delivery: 'Sent out for delivery',
        completed: bundle.order.fulfilment === 'delivery' ? 'Delivered' : 'Handed over',
      };
      return {
        summary: `${verb[p.to] ?? 'Updated'}: ${line.snapshot.productName}`,
        target: line.id,
        warnings,
        events,
      };
    },
  },

  'orders/cancel_order': {
    circuit: 'Orders',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      const { order, lines, payments, refunds } = await loadOrderBundle(ctx, p.orderId);
      const status = deriveOrderStatus(lines);
      if (status === 'cancelled') return [`Order ${order.number} is already cancelled.`];
      if (lines.some((l) => l.status === 'completed')) return ['Some items were already handed over, so the order cannot be cancelled.'];
      const money = moneySummary(lines, payments, refunds);
      if (money.net > 0 && ctx.session?.role !== 'owner')
        return ['This order has been paid. Only the owner can cancel it and decide on a refund.'];
      return [];
    },
    handle: async (p, ctx) => {
      const { order, lines } = await loadOrderBundle(ctx, p.orderId);
      for (const l of activeLines(lines)) await ctx.store.put('orderLines', { ...l, status: 'cancelled' as const });
      return {
        summary: `Cancelled order ${order.number}`,
        target: order.id,
        events: [{ type: 'OrderCancelled', payload: { orderId: order.id } }],
      };
    },
  },
} satisfies Partial<Registry>;
