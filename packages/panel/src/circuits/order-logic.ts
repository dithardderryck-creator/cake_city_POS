import type { LineStatus, Order, OrderLine, OrderStatus, Payment, PaymentStatus, Refund, Role } from '../domain';

export const round2 = (n: number) => Math.round(n * 100) / 100;

export const activeLines = (lines: OrderLine[]) => lines.filter((l) => l.status !== 'cancelled');
export const lineTotal = (l: OrderLine) => round2(l.qty * l.snapshot.unitPrice);
export const orderTotal = (lines: OrderLine[]) => round2(activeLines(lines).reduce((s, l) => s + lineTotal(l), 0));

/** Order status is derived from its lines (assumption A-07). */
export function deriveOrderStatus(lines: OrderLine[]): OrderStatus {
  if (lines.length === 0) return 'empty';
  const active = activeLines(lines);
  if (active.length === 0) return 'cancelled';
  if (active.every((l) => l.status === 'completed')) return 'completed';
  const beyondNew = active.every((l) => l.status !== 'new');
  if (beyondNew) return active.some((l) => l.status === 'out_for_delivery') ? 'out_for_delivery' : 'ready';
  return 'new';
}

export interface MoneySummary {
  total: number;
  paid: number;
  refunded: number;
  net: number;
  balance: number;
  overpaid: number;
  status: PaymentStatus;
}

export function moneySummary(lines: OrderLine[], payments: Payment[], refunds: Refund[]): MoneySummary {
  const total = orderTotal(lines);
  const paid = round2(payments.reduce((s, p) => s + p.amount, 0));
  const refunded = round2(refunds.reduce((s, r) => s + r.amount, 0));
  const net = round2(paid - refunded);
  const balance = Math.max(0, round2(total - net));
  const overpaid = Math.max(0, round2(net - total));
  let status: PaymentStatus;
  if (paid > 0 && refunded >= paid) status = 'refunded';
  else if (net <= 0) status = 'unpaid';
  else if (total > 0 && net + 0.005 >= total) status = 'paid';
  else status = 'partial';
  return { total, paid, refunded, net, balance, overpaid, status };
}

/** Which forward steps a line can take right now. The UI renders these; it never decides them (BR-22). */
export interface LineAction {
  to: LineStatus;
  label: string;
}

export function nextActions(order: Order, line: OrderLine, role: Role): LineAction[] {
  if (role !== 'owner' && role !== 'cashier') return [];
  switch (line.status) {
    case 'new':
      return [{ to: 'ready', label: 'Mark ready' }];
    case 'ready':
      return order.fulfilment === 'delivery'
        ? [{ to: 'out_for_delivery', label: 'Send out' }]
        : [{ to: 'completed', label: 'Hand over' }];
    case 'out_for_delivery':
      return [{ to: 'completed', label: 'Mark delivered' }];
    default:
      return [];
  }
}

export function canAdvance(order: Order, line: OrderLine, to: LineStatus): boolean {
  // Role is checked by the breaker; here we only check the transition itself.
  return nextActions(order, line, 'owner').some((a) => a.to === to);
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  empty: 'No items yet',
  new: 'New',
  ready: 'Ready',
  out_for_delivery: 'Out for delivery',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export type Tone = 'neutral' | 'attention' | 'ready' | 'done' | 'muted' | 'danger';

export const STATUS_TONE: Record<OrderStatus, Tone> = {
  empty: 'muted',
  new: 'attention',
  ready: 'ready',
  out_for_delivery: 'ready',
  completed: 'done',
  cancelled: 'muted',
};

export const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  unpaid: 'Unpaid',
  partial: 'Part paid',
  paid: 'Paid',
  refunded: 'Refunded',
};

export const PAYMENT_TONE: Record<PaymentStatus, Tone> = {
  unpaid: 'danger',
  partial: 'attention',
  paid: 'done',
  refunded: 'muted',
};
