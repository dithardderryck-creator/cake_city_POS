import type { Id, LineStatus, PaymentMethod, PaymentStatus, OrderStatus, Role, Session } from './domain';
import type { Clock, Ids, Store, Terminals } from './ports';

/**
 * Every instruction the UI can send. This is the complete list of "wires" going into the panel.
 * Keep it in step with blueprint section 7.4.
 */
export interface IntentMap {
  'auth/sign_in': { userId: Id; pin: string };
  'auth/sign_out': Record<string, never>;

  'catalogue/create_option_group': { name: string; values: { label: string; allergens?: string[] }[] };
  'catalogue/create_product': { name: string; category?: string; description?: string; allergens?: string[] };
  'catalogue/set_product_options': { productId: Id; valueIds: Id[] };
  'catalogue/generate_combinations': { productId: Id };
  'catalogue/set_price': { combinationId: Id; price: number };
  'catalogue/fill_price': { productId: Id; valueId: Id; price: number };
  'catalogue/mark_unavailable': { combinationId: Id; unavailable: boolean };
  'catalogue/archive_product': { productId: Id };
  'catalogue/toggle_available_today': { productId: Id; available: boolean };

  'stock/set_count': { combinationId: Id; count: number };

  'orders/create_order': {
    customerName?: string;
    source: 'walk_in' | 'phone';
    fulfilment: 'pickup' | 'delivery';
    deliveryDate?: string;
    deliveryAddress?: string;
  };
  'orders/add_catalogue_line': { orderId: Id; combinationId: Id; qty: number };
  'orders/cancel_line': { orderId: Id; lineId: Id };
  'orders/advance_line': { orderId: Id; lineId: Id; to: LineStatus };
  'orders/cancel_order': { orderId: Id };

  'payments/record_payment': {
    orderId: Id;
    method: PaymentMethod;
    amount: number;
    reference?: string;
    allowPartial?: boolean;
  };
  'payments/approve_refund': { orderId: Id; amount: number; reason: string; method: PaymentMethod };

  'sync/flush': Record<string, never>;
}
export type IntentName = keyof IntentMap;

export type CircuitName = 'Auth' | 'Catalogue' | 'Stock' | 'Orders' | 'Payments' | 'Sync';

/** Circuits from the blueprint that are planned but not built yet. Shown honestly on the panel map. */
export const PLANNED_CIRCUITS = [
  'Delivery',
  'Production',
  'Usage',
  'Messages',
  'Alerts',
  'Reports',
  'Comms',
] as const;

export interface PanelConfig {
  devicePrefix: string;
  formatMoney: (n: number) => string;
}

export interface HandlerCtx {
  store: Store;
  clock: Clock;
  ids: Ids;
  config: PanelConfig;
  terminals: Terminals;
  session: Session | null;
  now(): string;
  issueSession(s: Session): string;
  endSession(sessionId: string | undefined): void;
  sessionId: string | undefined;
}

export interface HandlerResult {
  summary: string;
  target?: string;
  /** Used by sign-in, where the actor is only known after the circuit runs. */
  actor?: Session;
  events?: Array<{ type: string; payload?: Record<string, unknown> }>;
  data?: unknown;
  warnings?: string[];
  /** Skip queuing a sync item (sign-in, sign-out, and sync itself). */
  skipSync?: boolean;
}

export interface IntentDef<P> {
  circuit: CircuitName;
  roles: Role[] | 'public';
  validate?: (payload: P, ctx: HandlerCtx) => Promise<string[]> | string[];
  handle: (payload: P, ctx: HandlerCtx) => Promise<HandlerResult>;
}
export type Registry = { [K in IntentName]: IntentDef<IntentMap[K]> };

/** Thrown by a circuit when a rule is broken after validation (for example a state change race). */
export class DomainError extends Error {
  constructor(
    public code: 'invalid' | 'forbidden',
    public messages: string[],
  ) {
    super(messages.join(' '));
  }
}

export type DispatchResult<D = unknown> =
  | { ok: true; data?: D; warnings: string[]; summary: string }
  | {
      ok: false;
      error: { code: 'unauthenticated' | 'forbidden' | 'invalid' | 'error'; messages: string[] };
    };

export type { PaymentStatus, OrderStatus };
