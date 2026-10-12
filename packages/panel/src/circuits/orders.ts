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
import { isIsoDate, todayLocal } from './dates';
import { canAdvance, canRemoveLine, moneySummary, deriveOrderStatus, activeLines, isCustom, round2 } from './order-logic';
import { normalisePhone } from './notify';
import { closeOpenQuote } from './quote-util';
import { ensureSuggestion } from './recipes';
import { loadSettings, methodProblem } from './settings';

export async function loadOrderBundle(ctx: Pick<HandlerCtx, 'store'>, orderId: string) {
  const order = await ctx.store.get<Order>('orders', orderId);
  if (!order) throw new DomainError('invalid', ['That order no longer exists.']);
  const [lines, payments, refunds] = await Promise.all([
    ctx.store.find<OrderLine>('orderLines', { where: { orderId } }),
    ctx.store.find<Payment>('payments', { where: { orderId } }),
    ctx.store.find<Refund>('refunds', { where: { orderId } }),
  ]);
  return { order, lines, payments, refunds };
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

function dateProblems(date: string | undefined, ctx: Pick<HandlerCtx, 'clock'>): string[] {
  if (!date) return [];
  if (!isIsoDate(date)) return ['Choose a valid delivery date.'];
  if (date < todayLocal(ctx.clock.now())) return ['Choose today or a later date.'];
  return [];
}

/** Why a catalogue item cannot be sold right now. Empty means it can. Shared by order lines and instant sales. */
async function catalogueProblems(ctx: Pick<HandlerCtx, 'store'>, combinationId: string): Promise<string[]> {
  const combo = await ctx.store.get<Combination>('combinations', combinationId);
  if (!combo) return ['That item is no longer in the catalogue.'];
  const product = await ctx.store.get<Product>('products', combo.productId);
  if (!product || product.status === 'archived') return ['That product has been archived.'];
  if (product.hidden) return [`${product.name} is hidden from the counter.`];
  if (!product.availableToday) return [`${product.name} is off the menu today.`];
  if (combo.status !== 'available') return ['That version is not available.'];
  if (combo.price === null) return ['That version has no price yet. Ask the owner to set one.'];
  return [];
}

/** A catalogue line with its price and options frozen at the moment of sale. */
async function buildCatalogueLine(ctx: HandlerCtx, orderId: string, combo: Combination, product: Product, qty: number, status: OrderLine['status']): Promise<OrderLine> {
  const [groups, values] = await Promise.all([ctx.store.list<OptionGroup>('optionGroups'), ctx.store.list<OptionValue>('optionValues')]);
  const chosen = values.filter((v) => combo.valueIds.includes(v.id));
  const options: Record<string, string> = {};
  for (const g of groups.sort((a, b) => a.order - b.order)) {
    const v = chosen.find((x) => x.groupId === g.id);
    if (v) options[g.name] = v.label;
  }
  const allergens = [...new Set([...product.allergens, ...chosen.flatMap((v) => v.allergens)])];
  return { id: ctx.ids.next('lin'), orderId, type: 'catalogue', combinationId: combo.id, qty, snapshot: { productName: product.name, options, unitPrice: combo.price!, allergens }, status };
}

/** BR-03: stock drops only at completion. A shortfall is allowed but recorded, never silently lost. */
async function dropStock(ctx: HandlerCtx, o: { combo: Combination; qty: number; productName: string; orderId: string; warnings: string[]; events: Array<{ type: string; payload?: Record<string, unknown> }> }) {
  const { combo, qty, orderId } = o;
  const taken = Math.min(combo.stockCount, qty);
  const shortfall = qty - taken;
  await ctx.store.put('combinations', { ...combo, stockCount: combo.stockCount - taken });
  const movement: StockMovement = { id: ctx.ids.next('mov'), combinationId: combo.id, qty: -taken, reason: 'sale', orderId, by: ctx.session!.userId, at: ctx.now() };
  await ctx.store.put('stockMovements', movement);
  o.events.push({ type: 'StockMoved', payload: { combinationId: combo.id, delta: -taken } });
  if (shortfall > 0) {
    const diff: CountDifference = { id: ctx.ids.next('dif'), combinationId: combo.id, expected: -shortfall, counted: 0, difference: -shortfall, reason: 'shortfall_at_completion', orderId, at: ctx.now() };
    await ctx.store.put('countDifferences', diff);
    o.events.push({ type: 'CountDifferenceRecorded', payload: { combinationId: combo.id, shortfall } });
    o.warnings.push(`Stock was short by ${shortfall} for ${o.productName}. It has been logged for the daily count.`);
  }
}

export const orderIntents = {
  'orders/create_order': {
    circuit: 'Orders',
    roles: ['owner', 'cashier'],
    validate: (p, ctx) => {
      const errors: string[] = [];
      if (p.fulfilment === 'delivery' && !p.deliveryAddress?.trim()) errors.push('Add a delivery address.');
      if (p.customerPhone?.trim() && !normalisePhone(p.customerPhone)) errors.push('Write the phone number with the country code, like +255712345678.');
      errors.push(...dateProblems(p.deliveryDate, ctx));
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
        customerPhone: p.customerPhone?.trim() ? normalisePhone(p.customerPhone)! : undefined,
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

  'orders/set_delivery': {
    circuit: 'Orders',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      const { order, lines } = await loadOrderBundle(ctx, p.orderId);
      const status = deriveOrderStatus(lines);
      if (status === 'completed' || status === 'cancelled') return [`Order ${order.number} is ${status}.`];
      if (p.deliveryDate === undefined && p.fulfilment === undefined && p.deliveryAddress === undefined && p.customerPhone === undefined) return ['Choose what to change.'];
      const errors = dateProblems(p.deliveryDate, ctx);
      if (typeof p.customerPhone === 'string' && p.customerPhone.trim() && !normalisePhone(p.customerPhone)) errors.push('Write the phone number with the country code, like +255712345678.');
      const fulfilment = p.fulfilment ?? order.fulfilment;
      const address = p.deliveryAddress !== undefined ? p.deliveryAddress.trim() : order.deliveryAddress;
      if (fulfilment === 'delivery' && !address) errors.push('Add a delivery address.');
      if (fulfilment === 'pickup' && lines.some((l) => l.status === 'out_for_delivery'))
        errors.push('Something is already out for delivery, so this order cannot become a pickup.');
      return errors;
    },
    handle: async (p, ctx) => {
      const { order, lines } = await loadOrderBundle(ctx, p.orderId);
      const fulfilment = p.fulfilment ?? order.fulfilment;
      const next: Order = {
        ...order,
        fulfilment,
        deliveryDate: p.deliveryDate ?? order.deliveryDate,
        deliveryAddress: fulfilment === 'delivery' ? (p.deliveryAddress !== undefined ? p.deliveryAddress.trim() : order.deliveryAddress) : undefined,
        customerPhone: p.customerPhone === undefined ? order.customerPhone : p.customerPhone && p.customerPhone.trim() ? normalisePhone(p.customerPhone)! : undefined,
      };
      await ctx.store.put('orders', next);
      const warnings: string[] = [];
      if (p.deliveryDate && p.deliveryDate !== order.deliveryDate && lines.some((l) => isCustom(l) && (l.status === 'in_production' || l.status === 'decorating' || l.status === 'ready')))
        warnings.push('The baker has already started a cake on this order. Tell them about the new date.');
      return {
        summary: `Changed delivery details on order ${order.number}`,
        target: order.id,
        warnings,
        events: [{ type: 'DeliveryChanged', payload: { orderId: order.id } }],
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
      return catalogueProblems(ctx, p.combinationId);
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

      const line = await buildCatalogueLine(ctx, p.orderId, combo, product, p.qty, 'new');
      await ctx.store.put('orderLines', line);
      return {
        summary: `Added ${p.qty} ${product.name}`,
        target: line.id,
        data: { lineId: line.id },
        events: [{ type: 'LineAdded', payload: { orderId: p.orderId, lineId: line.id } }],
      };
    },
  },

  'orders/quick_sale': {
    circuit: 'Orders',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      if (p.items.length === 0) return ['Add at least one item to the sale.'];
      const errors: string[] = [...(await methodProblem(ctx.store, p.method))];
      const seen = new Set<string>();
      for (const it of p.items) {
        if (seen.has(it.combinationId)) errors.push('The same item appears twice in this sale.');
        seen.add(it.combinationId);
        errors.push(...(await catalogueProblems(ctx, it.combinationId)));
      }
      return [...new Set(errors)];
    },
    handle: async (p, ctx) => {
      const order: Order = {
        id: ctx.ids.next('ord'),
        number: await nextOrderNumber(ctx),
        customerName: p.customerName?.trim() || 'Walk-in customer',
        source: 'walk_in',
        fulfilment: 'pickup',
        partialAllowed: false,
        createdBy: ctx.session!.userId,
        createdAt: ctx.now(),
      };
      await ctx.store.put('orders', order);
      const warnings: string[] = [];
      const events: Array<{ type: string; payload?: Record<string, unknown> }> = [{ type: 'OrderCreated', payload: { orderId: order.id } }];
      let total = 0;
      for (const it of p.items) {
        const combo = (await ctx.store.get<Combination>('combinations', it.combinationId))!;
        const product = (await ctx.store.get<Product>('products', combo.productId))!;
        // Straight to completed: there is no ticket to walk through for something handed over now.
        const line = await buildCatalogueLine(ctx, order.id, combo, product, it.qty, 'completed');
        await ctx.store.put('orderLines', line);
        total = round2(total + combo.price! * it.qty);
        await dropStock(ctx, { combo, qty: it.qty, productName: product.name, orderId: order.id, warnings, events });
      }
      const payment: Payment = { id: ctx.ids.next('pay'), orderId: order.id, method: p.method, amount: total, reference: p.reference?.trim() || undefined, receivedBy: ctx.session!.userId, receivedAt: ctx.now() };
      await ctx.store.put('payments', payment);
      events.push({ type: 'PaymentRecorded', payload: { orderId: order.id, amount: total, method: p.method } });
      return {
        summary: `Sold order ${order.number} for ${ctx.config.formatMoney(total)}`,
        target: order.id,
        data: { orderId: order.id, number: order.number, total, paymentId: payment.id },
        warnings,
        events,
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
      if (line.status === 'cancelled') return ['That item is already removed.'];
      if (line.status === 'completed') return ['That item has already been handed over.'];
      if (!canRemoveLine(line, ctx.session!.role, payments.length > 0)) {
        if (line.type === 'custom' && line.status !== 'new' && line.status !== 'draft' && line.status !== 'awaiting_quote')
          return ['This cake is already being made. Ask the owner to cancel it.'];
        if (payments.length > 0) return ['This order has payments. Ask the owner to change it.'];
        return ['Only items that have not been prepared can be removed.'];
      }
      return [];
    },
    handle: async (p, ctx) => {
      const { lines } = await loadOrderBundle(ctx, p.orderId);
      const line = lines.find((l) => l.id === p.lineId)!;
      await ctx.store.put('orderLines', { ...line, status: 'cancelled' as const });
      if (line.type === 'custom') await closeOpenQuote(ctx, line.id, 'The cake was removed from the order');
      return { summary: `Removed ${line.snapshot.productName}`, target: line.id };
    },
  },

  'orders/advance_line': {
    circuit: 'Orders',
    roles: ['owner', 'cashier', 'baker'],
    validate: async (p, ctx) => {
      const { order, lines } = await loadOrderBundle(ctx, p.orderId);
      const line = lines.find((l) => l.id === p.lineId);
      if (!line) return ['That item is not on the order.'];
      const settings = await loadSettings(ctx.store);
      return canAdvance(order, line, p.to, ctx.session!.role, settings)
        ? []
        : ['That step is not available for this item right now, or not for your role.'];
    },
    handle: async (p, ctx) => {
      const bundle = await loadOrderBundle(ctx, p.orderId);
      const line = bundle.lines.find((l) => l.id === p.lineId)!;
      await ctx.store.put('orderLines', { ...line, status: p.to });
      const warnings: string[] = [];
      const events: Array<{ type: string; payload?: Record<string, unknown> }> = [
        { type: 'StatusChanged', payload: { orderId: p.orderId, lineId: line.id, to: p.to } },
      ];

      if (line.type === 'custom' && p.to === 'in_production' && line.custom) {
        const suggestion = await ensureSuggestion(ctx, p.orderId, line.id, line.custom.spec);
        events.push({ type: 'UsageSuggested', payload: { lineId: line.id, lines: suggestion.lines.length } });
        if (suggestion.lines.length === 0) warnings.push('No ingredient suggestion could be made because no recipe lines fit this cake. The baker can still report what was used.');
        const money = moneySummary(bundle.lines, bundle.payments, bundle.refunds);
        if (money.paid <= 0) warnings.push(`Nothing has been paid on order ${bundle.order.number} yet.`);
      }

      if (p.to === 'completed') {
        // BR-03: stock drops only now. A shortfall is allowed but recorded, never silently lost.
        // Custom cakes use ingredients, not counter stock; their usage is handled by the production circuits later.
        const combo = line.combinationId ? await ctx.store.get<Combination>('combinations', line.combinationId) : undefined;
        if (combo) await dropStock(ctx, { combo, qty: line.qty, productName: line.snapshot.productName, orderId: p.orderId, warnings, events });
        // Open question Q-01: allowed for now, but flagged.
        const money = moneySummary(bundle.lines, bundle.payments, bundle.refunds);
        if (money.balance > 0) {
          warnings.push(`Order ${bundle.order.number} still has ${ctx.config.formatMoney(money.balance)} unpaid.`);
          events.push({ type: 'BalanceUnpaidAtHandover', payload: { orderId: p.orderId, balance: money.balance } });
        }
      }

      const verb: Record<string, string> = {
        in_production: 'Started baking',
        decorating: 'Started decorating',
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
      if (ctx.session?.role !== 'owner' && lines.some((l) => isCustom(l) && ['in_production', 'decorating', 'ready', 'out_for_delivery'].includes(l.status)))
        return ['A cake on this order is already being made. Only the owner can cancel it.'];
      const money = moneySummary(lines, payments, refunds);
      if (money.net > 0 && ctx.session?.role !== 'owner')
        return ['This order has been paid. Only the owner can cancel it and decide on a refund.'];
      return [];
    },
    handle: async (p, ctx) => {
      const { order, lines } = await loadOrderBundle(ctx, p.orderId);
      for (const l of activeLines(lines)) {
        await ctx.store.put('orderLines', { ...l, status: 'cancelled' as const });
        if (l.type === 'custom') await closeOpenQuote(ctx, l.id, 'The order was cancelled');
      }
      return {
        summary: `Cancelled order ${order.number}`,
        target: order.id,
        events: [{ type: 'OrderCancelled', payload: { orderId: order.id } }],
      };
    },
  },
} satisfies Partial<Registry>;
