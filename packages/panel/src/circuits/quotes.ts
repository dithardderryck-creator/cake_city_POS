import type { Quote } from '../domain';
import type { HandlerCtx, Registry } from '../intents';
import { DomainError } from '../intents';
import { customSnapshot, loadCustomLine } from './custom';
import { isIsoDate, todayLocal } from './dates';
import { moneySummary, round2 } from './order-logic';
import { OPEN_QUOTE as OPEN, quoteEvent as event } from './quote-util';

async function loadQuote(ctx: Pick<HandlerCtx, 'store'>, quoteId: string) {
  const quote = await ctx.store.get<Quote>('quotes', quoteId);
  if (!quote) throw new DomainError('invalid', ['That quote request no longer exists.']);
  return quote;
}

const validPrice = (n: number) => Number.isFinite(n) && n > 0 && n <= 1_000_000_000;

export const quoteIntents = {
  'quotes/request': {
    circuit: 'Quotes',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      const { order, line } = await loadCustomLine(ctx, p.orderId, p.lineId);
      if (line.status === 'awaiting_quote') return ['The owner has already been asked to price this cake.'];
      if (line.status !== 'draft') return ['This cake already has a price.'];
      if (!order.deliveryDate) return ['Set the delivery date first. The owner needs it to price the cake.'];
      if (!isIsoDate(order.deliveryDate) || order.deliveryDate < todayLocal(ctx.clock.now()))
        return ['The delivery date has passed. Choose a new one first.'];
      return [];
    },
    handle: async (p, ctx) => {
      const { order, line } = await loadCustomLine(ctx, p.orderId, p.lineId);
      const quote: Quote = {
        id: ctx.ids.next('quo'),
        orderId: order.id,
        lineId: line.id,
        status: 'sent',
        requestedBy: ctx.session!.userId,
        requestedByName: ctx.session!.name,
        requestedAt: ctx.now(),
        note: p.note?.trim() || undefined,
        timeline: [event(ctx, 'sent', { note: p.note?.trim() || undefined })],
      };
      await ctx.store.put('quotes', quote);
      await ctx.store.put('orderLines', { ...line, status: 'awaiting_quote' as const, custom: { ...line.custom, quoteId: quote.id } });
      return {
        summary: `Asked the owner to price a custom cake for order ${order.number}`,
        target: quote.id,
        data: { quoteId: quote.id },
        events: [{ type: 'QuoteRequested', payload: { quoteId: quote.id, orderId: order.id, lineId: line.id } }],
      };
    },
  },

  'quotes/mark_seen': {
    circuit: 'Quotes',
    roles: ['owner'],
    validate: async (p, ctx) => {
      const q = await loadQuote(ctx, p.quoteId);
      return OPEN.includes(q.status) ? [] : ['This quote request is already closed.'];
    },
    handle: async (p, ctx) => {
      const q = await loadQuote(ctx, p.quoteId);
      if (q.status === 'seen') return { summary: 'Quote request already seen', target: q.id };
      await ctx.store.put('quotes', { ...q, status: 'seen' as const, timeline: [...q.timeline, event(ctx, 'seen')] });
      return { summary: 'Opened a quote request', target: q.id, events: [{ type: 'QuoteSeen', payload: { quoteId: q.id } }] };
    },
  },

  'quotes/provide': {
    circuit: 'Quotes',
    roles: ['owner'],
    validate: async (p, ctx) => {
      const q = await loadQuote(ctx, p.quoteId);
      if (!OPEN.includes(q.status)) return ['This quote request is already closed.'];
      if (!validPrice(p.price)) return ['Enter a price greater than zero.'];
      return [];
    },
    handle: async (p, ctx) => {
      const q = await loadQuote(ctx, p.quoteId);
      const { order, line } = await loadCustomLine(ctx, q.orderId, q.lineId);
      const price = round2(p.price);
      const note = p.note?.trim() || undefined;
      await ctx.store.put('quotes', {
        ...q,
        status: 'quoted' as const,
        price,
        answer: note,
        resolvedAt: ctx.now(),
        timeline: [...q.timeline, event(ctx, 'quoted', { price, note })],
      });
      // BR-05: the line is confirmed only now that it has a price.
      await ctx.store.put('orderLines', {
        ...line,
        status: 'new' as const,
        snapshot: customSnapshot(line.custom.spec, price),
        custom: { ...line.custom, quotedBy: ctx.session!.userId, quotedAt: ctx.now() },
      });
      return {
        summary: `Quoted ${ctx.config.formatMoney(price)} for the custom cake on order ${order.number}`,
        target: q.id,
        events: [{ type: 'QuoteProvided', payload: { quoteId: q.id, orderId: order.id, lineId: line.id, price } }],
      };
    },
  },

  'quotes/decline': {
    circuit: 'Quotes',
    roles: ['owner'],
    validate: async (p, ctx) => {
      const q = await loadQuote(ctx, p.quoteId);
      if (!OPEN.includes(q.status)) return ['This quote request is already closed.'];
      if (!p.reason?.trim()) return ['Say why, so the cashier can tell the customer.'];
      return [];
    },
    handle: async (p, ctx) => {
      const q = await loadQuote(ctx, p.quoteId);
      const { order, line } = await loadCustomLine(ctx, q.orderId, q.lineId);
      const reason = p.reason.trim();
      await ctx.store.put('quotes', {
        ...q,
        status: 'declined' as const,
        answer: reason,
        resolvedAt: ctx.now(),
        timeline: [...q.timeline, event(ctx, 'declined', { note: reason })],
      });
      await ctx.store.put('orderLines', { ...line, status: 'draft' as const });
      return {
        summary: `Declined to price the custom cake on order ${order.number}`,
        target: q.id,
        events: [{ type: 'QuoteDeclined', payload: { quoteId: q.id, orderId: order.id, lineId: line.id } }],
      };
    },
  },

  'quotes/withdraw': {
    circuit: 'Quotes',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      const q = await loadQuote(ctx, p.quoteId);
      if (!OPEN.includes(q.status)) return ['This quote request is already closed.'];
      if (ctx.session?.role !== 'owner' && q.requestedBy !== ctx.session?.userId)
        return ['Only the person who asked, or the owner, can withdraw this request.'];
      return [];
    },
    handle: async (p, ctx) => {
      const q = await loadQuote(ctx, p.quoteId);
      const { line } = await loadCustomLine(ctx, q.orderId, q.lineId);
      await ctx.store.put('quotes', {
        ...q,
        status: 'withdrawn' as const,
        resolvedAt: ctx.now(),
        timeline: [...q.timeline, event(ctx, 'withdrawn')],
      });
      await ctx.store.put('orderLines', { ...line, status: 'draft' as const });
      return {
        summary: 'Withdrew a quote request',
        target: q.id,
        events: [{ type: 'QuoteWithdrawn', payload: { quoteId: q.id, lineId: line.id } }],
      };
    },
  },

  'quotes/revise': {
    circuit: 'Quotes',
    roles: ['owner'],
    validate: async (p, ctx) => {
      const q = await loadQuote(ctx, p.quoteId);
      if (q.status !== 'quoted') return ['Only a quote that has been given can be revised.'];
      if (!validPrice(p.price)) return ['Enter a price greater than zero.'];
      if (!p.reason?.trim()) return ['Say why the price changed.'];
      const { line } = await loadCustomLine(ctx, q.orderId, q.lineId);
      if (line.status !== 'new') return ['Baking has started, so the price can no longer be changed here.'];
      if (round2(p.price) === q.price) return ['That is the same as the current price.'];
      return [];
    },
    handle: async (p, ctx) => {
      const q = await loadQuote(ctx, p.quoteId);
      const bundle = await loadCustomLine(ctx, q.orderId, q.lineId);
      const price = round2(p.price);
      const reason = p.reason.trim();
      await ctx.store.put('quotes', { ...q, price, timeline: [...q.timeline, event(ctx, 'revised', { price, note: reason })] });
      await ctx.store.put('orderLines', { ...bundle.line, snapshot: customSnapshot(bundle.line.custom.spec, price) });
      const after = moneySummary(
        bundle.lines.map((l) => (l.id === bundle.line.id ? { ...l, snapshot: { ...l.snapshot, unitPrice: price } } : l)),
        bundle.payments,
        bundle.refunds,
      );
      const warnings: string[] = [];
      if (after.balance > 0 && after.paid > 0) warnings.push(`The customer has paid ${ctx.config.formatMoney(after.paid)}. ${ctx.config.formatMoney(after.balance)} is now due.`);
      if (after.overpaid > 0) warnings.push(`The customer has paid ${ctx.config.formatMoney(after.overpaid)} more than the new total. Consider a refund.`);
      return {
        summary: `Changed a custom cake price from ${ctx.config.formatMoney(q.price ?? 0)} to ${ctx.config.formatMoney(price)}: ${reason}`,
        target: q.id,
        warnings,
        events: [{ type: 'QuoteRevised', payload: { quoteId: q.id, orderId: q.orderId, price } }],
      };
    },
  },
} satisfies Partial<Registry>;
