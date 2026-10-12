import type { Payment, Refund } from '../domain';
import { DomainError, type Registry } from '../intents';
import { deriveOrderStatus, moneySummary, round2 } from './order-logic';
import { loadOrderBundle } from './orders';
import { methodProblem } from './settings';

export const paymentIntents = {
  'payments/record_payment': {
    circuit: 'Payments',
    roles: ['owner', 'cashier'],
    validate: async (p, ctx) => {
      if (!Number.isFinite(p.amount) || p.amount <= 0) return ['Enter an amount greater than zero.'];
      const notTaken = await methodProblem(ctx.store, p.method);
      if (notTaken.length) return notTaken;
      const { order, lines, payments, refunds } = await loadOrderBundle(ctx, p.orderId);
      if (deriveOrderStatus(lines) === 'cancelled') return [`Order ${order.number} is cancelled.`];
      const money = moneySummary(lines, payments, refunds);
      if (money.quotePending) return ['A custom cake on this order has no price yet. Wait for the owner\'s quote, or remove the cake, before taking payment.'];
      if (money.total <= 0) return ['Add items to the order before taking a payment.'];
      const amount = round2(p.amount);
      if (amount > money.balance + 0.005)
        return [`That is more than the balance of ${ctx.config.formatMoney(money.balance)}.`];
      if (amount + 0.005 < money.balance && !order.partialAllowed && !p.allowPartial)
        return [
          `The balance is ${ctx.config.formatMoney(money.balance)}. Confirm the partial payment exception to take less.`,
        ];
      return [];
    },
    handle: async (p, ctx) => {
      const { order, lines, payments, refunds } = await loadOrderBundle(ctx, p.orderId);
      const before = moneySummary(lines, payments, refunds);
      const amount = round2(p.amount);
      const payment: Payment = {
        id: ctx.ids.next('pay'),
        orderId: order.id,
        method: p.method,
        amount,
        reference: p.reference?.trim() || undefined,
        receivedBy: ctx.session!.userId,
        receivedAt: ctx.now(),
      };
      await ctx.store.put('payments', payment);
      const remaining = round2(before.balance - amount);
      // BR-06: the exception is recorded on the order so later part-payments do not need it again.
      if (remaining > 0.005 && !order.partialAllowed) {
        await ctx.store.put('orders', { ...order, partialAllowed: true });
      }
      return {
        summary:
          remaining > 0.005
            ? `Took ${ctx.config.formatMoney(amount)}. ${ctx.config.formatMoney(remaining)} still to pay`
            : `Paid in full: ${ctx.config.formatMoney(amount)}`,
        target: order.id,
        data: { paymentId: payment.id, remaining },
        events: [{ type: 'PaymentRecorded', payload: { orderId: order.id, amount, method: p.method } }],
      };
    },
  },

  'payments/approve_refund': {
    circuit: 'Payments',
    roles: ['owner'],
    validate: async (p, ctx) => {
      if (!p.reason?.trim()) return ['Add a reason for the refund.'];
      if (!Number.isFinite(p.amount) || p.amount <= 0) return ['Enter a refund amount greater than zero.'];
      const { lines, payments, refunds } = await loadOrderBundle(ctx, p.orderId);
      const money = moneySummary(lines, payments, refunds);
      if (round2(p.amount) > money.net + 0.005)
        return [`Only ${ctx.config.formatMoney(money.net)} is left to refund on this order.`];
      return [];
    },
    handle: async (p, ctx) => {
      const { order } = await loadOrderBundle(ctx, p.orderId);
      const refund: Refund = {
        id: ctx.ids.next('rfd'),
        orderId: order.id,
        amount: round2(p.amount),
        reason: p.reason.trim(),
        method: p.method,
        approvedBy: ctx.session!.userId,
        at: ctx.now(),
      };
      await ctx.store.put('refunds', refund);
      return {
        summary: `Refunded ${ctx.config.formatMoney(refund.amount)} on order ${order.number}`,
        target: order.id,
        events: [{ type: 'RefundApproved', payload: { orderId: order.id, amount: refund.amount } }],
      };
    },
  },
} satisfies Partial<Registry>;

// Re-exported so the error type is available to callers that only import payments.
export { DomainError };
