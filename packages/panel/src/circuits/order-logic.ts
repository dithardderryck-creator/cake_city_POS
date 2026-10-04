import type { LineStatus, Order, OrderLine, OrderStatus, Payment, PaymentStatus, Refund, Role, ShopSettings } from '../domain';

export const round2 = (n: number) => Math.round(n * 100) / 100;

export const activeLines = (lines: OrderLine[]) => lines.filter((l) => l.status !== 'cancelled');
export const lineTotal = (l: OrderLine) => round2(l.qty * l.snapshot.unitPrice);
export const orderTotal = (lines: OrderLine[]) => round2(activeLines(lines).reduce((s, l) => s + lineTotal(l), 0));

/** How far along each status is. Used to derive an order's status from its lines. */
const RANK: Record<LineStatus, number> = {
  draft: 0,
  awaiting_quote: 1,
  new: 2,
  in_production: 3,
  decorating: 4,
  ready: 5,
  out_for_delivery: 6,
  completed: 7,
  cancelled: -1,
};

/** Order status is derived from its lines (assumption A-07): the least advanced line sets it. */
export function deriveOrderStatus(lines: OrderLine[]): OrderStatus {
  if (lines.length === 0) return 'empty';
  const active = activeLines(lines);
  if (active.length === 0) return 'cancelled';
  if (active.every((l) => l.status === 'completed')) return 'completed';
  if (active.every((l) => RANK[l.status] >= RANK.ready)) {
    return active.some((l) => l.status === 'out_for_delivery') ? 'out_for_delivery' : 'ready';
  }
  // Something is still being quoted, baked or decorated: show the least advanced stage.
  const behind = active.filter((l) => l.status !== 'completed').sort((a, b) => RANK[a.status] - RANK[b.status])[0]!;
  return behind.status;
}

export const isCustom = (l: OrderLine) => l.type === 'custom';
export const needsQuote = (l: OrderLine) => l.status === 'draft' || l.status === 'awaiting_quote';

export interface MoneySummary {
  total: number;
  paid: number;
  refunded: number;
  net: number;
  balance: number;
  overpaid: number;
  status: PaymentStatus;
  /** True while a custom cake has no price yet, so the total is not final. */
  quotePending: boolean;
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
  const quotePending = activeLines(lines).some(needsQuote);
  return { total, paid, refunded, net, balance, overpaid, status, quotePending };
}

/** Which forward steps a line can take right now. The UI renders these; it never decides them (BR-22). */
export interface LineAction {
  to: LineStatus;
  label: string;
}

const SHOP_DEFAULTS: Pick<ShopSettings, 'decoratingStage'> = { decoratingStage: false };

/**
 * Which forward steps a line can take right now, for this role.
 * Catalogue lines are the cashier's. Custom cakes are baked by the baker and handed over by the cashier (D-30).
 * The owner can do any of them.
 */
export function nextActions(
  order: Order,
  line: OrderLine,
  role: Role,
  settings: Pick<ShopSettings, 'decoratingStage'> = SHOP_DEFAULTS,
): LineAction[] {
  const front = role === 'owner' || role === 'cashier';
  const kitchen = role === 'owner' || role === 'baker';
  const handover = (): LineAction[] =>
    order.fulfilment === 'delivery' ? [{ to: 'out_for_delivery', label: 'Send out' }] : [{ to: 'completed', label: 'Hand over' }];

  if (line.type === 'custom') {
    switch (line.status) {
      case 'new':
        return kitchen ? [{ to: 'in_production', label: 'Start baking' }] : [];
      case 'in_production':
        if (!kitchen) return [];
        return settings.decoratingStage ? [{ to: 'decorating', label: 'Start decorating' }] : [{ to: 'ready', label: 'Mark ready' }];
      case 'decorating':
        return kitchen ? [{ to: 'ready', label: 'Mark ready' }] : [];
      case 'ready':
        return front ? handover() : [];
      case 'out_for_delivery':
        return front ? [{ to: 'completed', label: 'Mark delivered' }] : [];
      default:
        return []; // draft and awaiting_quote move through the quote instructions, not this one
    }
  }

  if (!front) return [];
  switch (line.status) {
    case 'new':
      return [{ to: 'ready', label: 'Mark ready' }];
    case 'ready':
      return handover();
    case 'out_for_delivery':
      return [{ to: 'completed', label: 'Mark delivered' }];
    default:
      return [];
  }
}

export function canAdvance(
  order: Order,
  line: OrderLine,
  to: LineStatus,
  role: Role,
  settings?: Pick<ShopSettings, 'decoratingStage'>,
): boolean {
  return nextActions(order, line, role, settings).some((a) => a.to === to);
}

/** Whether this person may take this line off the order. The feed and the instruction share it. */
export function canRemoveLine(line: OrderLine, role: Role, hasPayments: boolean): boolean {
  if (role !== 'owner' && role !== 'cashier') return false;
  if (line.status === 'cancelled' || line.status === 'completed') return false;
  if (line.type === 'catalogue') return line.status === 'new' && (!hasPayments || role === 'owner');
  // A custom cake can be cancelled at any stage before it is handed over, but once the owner has quoted it and
  // money or baking is involved, the owner decides (blueprint 5.1).
  if (role === 'owner') return true;
  return (line.status === 'draft' || line.status === 'awaiting_quote' || line.status === 'new') && !hasPayments;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  empty: 'No items yet',
  draft: 'Draft',
  awaiting_quote: 'Awaiting quote',
  in_production: 'In production',
  decorating: 'Decorating',
  new: 'New',
  ready: 'Ready',
  out_for_delivery: 'Out for delivery',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export type Tone = 'neutral' | 'attention' | 'ready' | 'done' | 'muted' | 'danger';

export const STATUS_TONE: Record<OrderStatus, Tone> = {
  empty: 'muted',
  draft: 'muted',
  awaiting_quote: 'attention',
  in_production: 'attention',
  decorating: 'attention',
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
