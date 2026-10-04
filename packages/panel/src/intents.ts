import type { UnitCode } from './units';
import type { CakeSpecInput, Id, IngredientUnit, LineStatus, PaymentMethod, PaymentStatus, OrderStatus, Role, RuleScaling, Session } from './domain';
import type { Clock, Ids, PinHasher, Secrets, Store, Terminals } from './ports';

/**
 * Every instruction the UI can send. This is the complete list of "wires" going into the panel.
 * Keep it in step with blueprint section 7.4.
 */
export interface IntentMap {
  'auth/sign_in': { userId: Id; pin: string };
  'auth/sign_out': Record<string, never>;
  'auth/change_pin': { currentPin: string; newPin: string };

  'staff/create': { name: string; role: Role; pin: string };
  'staff/set_pin': { userId: Id; pin: string };
  'staff/set_active': { userId: Id; active: boolean };

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
  'orders/set_delivery': { orderId: Id; fulfilment?: 'pickup' | 'delivery'; deliveryDate?: string; deliveryAddress?: string };
  'orders/add_catalogue_line': { orderId: Id; combinationId: Id; qty: number };
  'orders/add_custom_line': { orderId: Id; spec: CakeSpecInput };
  'orders/update_custom_line': { orderId: Id; lineId: Id; spec: CakeSpecInput };
  'orders/attach_reference_photo': { orderId: Id; lineId: Id; photoId: Id };
  'orders/remove_reference_photo': { orderId: Id; lineId: Id; photoId: Id };
  'orders/cancel_line': { orderId: Id; lineId: Id };
  'orders/advance_line': { orderId: Id; lineId: Id; to: LineStatus };
  'orders/cancel_order': { orderId: Id };

  'quotes/request': { orderId: Id; lineId: Id; note?: string };
  'quotes/mark_seen': { quoteId: Id };
  'quotes/provide': { quoteId: Id; price: number; note?: string };
  'quotes/decline': { quoteId: Id; reason: string };
  'quotes/withdraw': { quoteId: Id };
  'quotes/revise': { quoteId: Id; price: number; reason: string };

  'settings/update': { decoratingStage?: boolean };

  'payments/record_payment': {
    orderId: Id;
    method: PaymentMethod;
    amount: number;
    reference?: string;
    allowPartial?: boolean;
  };
  'payments/approve_refund': { orderId: Id; amount: number; reason: string; method: PaymentMethod };

  /**
   * `unit` on these intents is the unit the numbers are written in. Leave it out and they are in the ingredient's
   * base unit (kg, l or pcs). Stock is always stored in the base unit, whatever was typed.
   */
  'inventory/create_ingredient': {
    name: string;
    /** Any unit. Its kind (weight, volume, count) decides the ingredient's base unit; the numbers below are in this unit. */
    unit: UnitCode;
    reorderLevel?: number;
    allergens?: string[];
    ranges?: { label: string; min: number; max: number }[];
    openingStock?: number;
  };
  'inventory/update_ingredient': {
    ingredientId: Id;
    name?: string;
    reorderLevel?: number | null;
    allergens?: string[];
    /** Replaces the whole list. Keep an `id` to keep that amount's identity. */
    ranges?: { id?: Id; label: string; min: number; max: number }[];
    active?: boolean;
    /** The unit `reorderLevel` and `ranges` are written in. */
    unit?: UnitCode;
  };
  'inventory/receive': { ingredientId: Id; qty: number; unit?: UnitCode; note?: string };
  'inventory/count': { ingredientId: Id; counted: number; unit?: UnitCode; note?: string };
  'inventory/write_off': { ingredientId: Id; qty: number; unit?: UnitCode; note?: string };

  'recipes/save_rule': {
    ruleId?: Id;
    ingredientId: Id;
    quantity: number;
    /** The unit `quantity` is written in. */
    unit?: UnitCode;
    scaling: RuleScaling;
    flavors?: string[];
    fillings?: string[];
    needsDietary?: string[];
    excludedByDietary?: string[];
    note?: string;
  };
  'recipes/remove_rule': { ruleId: Id };

  'usage/report': { orderId: Id; lineId: Id; items: { ingredientId: Id; rangeId: Id }[]; note?: string };
  'usage/confirm': { reportId: Id; items: { ingredientId: Id; qty: number; unit?: UnitCode }[] };
  'usage/send_back': { reportId: Id; reason: string };

  'sync/flush': Record<string, never>;
}
export type IntentName = keyof IntentMap;

export type CircuitName = 'Auth' | 'Staff' | 'Catalogue' | 'Stock' | 'Orders' | 'Quotes' | 'Settings' | 'Inventory' | 'Recipes' | 'Usage' | 'Payments' | 'Sync';

/** Circuits from the blueprint that are planned but not built yet. Shown honestly on the panel map. */
export const PLANNED_CIRCUITS = [
  'Delivery',
  'Production',
  'Messages',
  'Alerts',
  'Reports',
  'Comms',
] as const;

export interface PanelConfig {
  devicePrefix: string;
  formatMoney: (n: number) => string;
  /** Wrong PINs allowed before a lock. */
  lockoutMaxFailures: number;
  /** Lock length in minutes for the 1st, 2nd, 3rd... lock. The last value repeats. */
  lockoutMinutes: number[];
  /** A session ends after this long without use. */
  sessionIdleMs: number;
  /** A session ends this long after sign-in, however busy. */
  sessionMaxMs: number;
}

export interface HandlerCtx {
  store: Store;
  clock: Clock;
  ids: Ids;
  config: PanelConfig;
  terminals: Terminals;
  hasher: PinHasher;
  secrets: Secrets;
  session: Session | null;
  now(): string;
  /** Returns the bearer token. Only its hash is stored. */
  issueSession(s: Session): Promise<string>;
  endSession(token: string | undefined): Promise<void>;
  /** End every session of a person, optionally keeping the one they are using now. */
  revokeSessions(userId: string, exceptToken?: string): Promise<void>;
  /** The bearer token of the current request, if any. */
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
  /**
   * The instruction is refused, but what the circuit wrote is still saved.
   * Used where the refusal itself must be recorded, such as counting wrong PINs.
   */
  failure?: { code: 'forbidden' | 'invalid'; messages: string[] };
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
