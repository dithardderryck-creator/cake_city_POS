/**
 * Domain types. See docs/blueprint.md section 4 for the source of truth.
 * Only the slice built so far is here: staff, catalogue, orders, payments, stock, audit, outbox.
 */
export type Id = string;
export type Role = 'owner' | 'cashier' | 'baker' | 'inventory' | 'it';
export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'mobile_money';
export type LineStatus = 'new' | 'ready' | 'out_for_delivery' | 'completed' | 'cancelled';
export type OrderStatus = LineStatus | 'empty';
export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded';

export interface Session {
  userId: Id;
  name: string;
  role: Role;
}

export interface Staff {
  id: Id;
  name: string;
  role: Role;
  pinHash: string;
  active: boolean;
}

export interface OptionGroup {
  id: Id;
  name: string;
  order: number;
}

export interface OptionValue {
  id: Id;
  groupId: Id;
  label: string;
  allergens: string[];
  order: number;
}

export interface Product {
  id: Id;
  name: string;
  category: string;
  description: string;
  status: 'active' | 'archived';
  availableToday: boolean;
  selectedValueIds: Id[];
  allergens: string[];
  createdAt: string;
}

/** One specific version of a product. Price is set manually by the owner (D-27). */
export interface Combination {
  id: Id;
  productId: Id;
  valueIds: Id[];
  price: number | null;
  stockCount: number;
  status: 'available' | 'unavailable';
  createdAt: string;
}

export interface Order {
  id: Id;
  number: string;
  customerName: string;
  source: 'walk_in' | 'phone';
  fulfilment: 'pickup' | 'delivery';
  deliveryDate?: string;
  deliveryAddress?: string;
  partialAllowed: boolean;
  createdBy: Id;
  createdAt: string;
}

/** Frozen at entry so later catalogue edits never rewrite history (BR-11). */
export interface LineSnapshot {
  productName: string;
  options: Record<string, string>;
  unitPrice: number;
  allergens: string[];
}

export interface OrderLine {
  id: Id;
  orderId: Id;
  type: 'catalogue';
  combinationId: Id;
  qty: number;
  snapshot: LineSnapshot;
  status: LineStatus;
}

export interface Payment {
  id: Id;
  orderId: Id;
  method: PaymentMethod;
  amount: number;
  reference?: string;
  receivedBy: Id;
  receivedAt: string;
}

export interface Refund {
  id: Id;
  orderId: Id;
  amount: number;
  reason: string;
  method: PaymentMethod;
  approvedBy: Id;
  at: string;
}

export interface StockMovement {
  id: Id;
  combinationId: Id;
  qty: number;
  reason: 'sale' | 'adjustment' | 'batch';
  orderId?: Id;
  by: Id;
  at: string;
}

export interface CountDifference {
  id: Id;
  combinationId: Id;
  expected: number;
  counted: number;
  difference: number;
  reason: 'shortfall_at_completion' | 'daily_count';
  orderId?: Id;
  at: string;
}

export interface AuditEntry {
  id: Id;
  at: string;
  actorId?: Id;
  actorName?: string;
  role?: Role;
  intent: string;
  target?: string;
  summary: string;
  outcome: 'ok' | 'denied' | 'invalid' | 'error';
}

export interface OutboxItem {
  id: Id;
  kind: 'sync' | 'whatsapp' | 'sms' | 'print' | 'recipe';
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  status: 'pending' | 'sent' | 'failed';
}

export interface PanelEvent {
  type: string;
  at: string;
  actorId?: Id;
  payload: Record<string, unknown>;
}
