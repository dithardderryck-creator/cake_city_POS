import type { UnitCode } from './units';
import type { AlertKind, MessageLevel, REQUEST_CATEGORIES } from './domain';
import type { Device, CakeSpecInput, Id, IngredientUnit, LineStatus, PaymentMethod, PaymentStatus, OrderStatus, Role, RuleScaling, Session } from './domain';
import type { Clock, Ids, PinHasher, Secrets, Store, Terminals } from './ports';

/**
 * Every instruction the UI can send. This is the complete list of "wires" going into the panel.
 * Keep it in step with blueprint section 7.4.
 */
export interface IntentMap {
  'auth/sign_in': { userId: Id; pin: string };
  'auth/sign_out': Record<string, never>;
  'offline/get_pass': Record<string, never>;
  'offline/review': { heldId: Id; action: 'approve' | 'dismiss'; note?: string };
  'auth/change_pin': { currentPin: string; newPin: string };

  /** Owner or IT: make a one-time code (valid about 10 minutes) that registers one device under the given name. */
  'devices/create_code': { name: string };
  'devices/cancel_code': { codeId: string };
  /** Public on purpose: a device that is not registered yet has nothing else to prove itself with. Uses up the code. */
  'devices/pair': { code: string };
  'devices/rename': { deviceId: Id; name: string };
  /** The device can no longer reach sign-in, and everyone signed in on it is signed out. */
  'devices/revoke': { deviceId: Id };

  'staff/create': { name: string; role: Role; pin: string };
  'staff/set_pin': { userId: Id; pin: string };
  'staff/set_active': { userId: Id; active: boolean };
  'staff/delete': { userId: Id };
  /** Change what someone does in the shop. Not for the owner, and nobody can be made owner this way. Ends their sign-ins. */
  'staff/set_role': { userId: Id; role: Exclude<Role, 'owner'> };

  'catalogue/create_option_group': { name: string; values: { label: string; allergens?: string[] }[] };
  'catalogue/create_product': { name: string; category?: string; description?: string; allergens?: string[] };
  'catalogue/set_product_options': { productId: Id; valueIds: Id[] };
  'catalogue/generate_combinations': { productId: Id };
  'catalogue/set_price': { combinationId: Id; price: number };
  'catalogue/fill_price': { productId: Id; valueId: Id; price: number };
  'catalogue/mark_unavailable': { combinationId: Id; unavailable: boolean };
  'catalogue/archive_product': { productId: Id };
  /** Hide a product from the counter without losing it, or bring it back. */
  'catalogue/set_hidden': { productId: Id; hidden: boolean };
  'catalogue/toggle_available_today': { productId: Id; available: boolean };

  'stock/set_count': { combinationId: Id; count: number };
  /** The baker made `qty` finished items. Adds to the counter stock of that version of the product. */
  'batches/log': { combinationId: Id; qty: number; note?: string };
  /** Take back a batch logged by mistake. The baker who logged it has 30 minutes; the owner any time. Refused if some of it has been sold. */
  'batches/undo': { batchId: Id };

  'orders/create_order': {
    customerName?: string;
    source: 'walk_in' | 'phone';
    fulfilment: 'pickup' | 'delivery';
    deliveryDate?: string;
    deliveryAddress?: string;
    /** With the country code, such as +255712345678. */
    customerPhone?: string;
  };
  /** A ready-made sale handed over now: creates the order, completes its lines, drops stock and records full payment in one step. No ticket. Custom cakes still use orders. */
  'orders/quick_sale': { items: Array<{ combinationId: Id; qty: number }>; method: PaymentMethod; reference?: string; customerName?: string; expectedTotal?: number };
  'orders/set_delivery': { orderId: Id; fulfilment?: 'pickup' | 'delivery'; deliveryDate?: string; deliveryAddress?: string; customerPhone?: string | null };
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

  'settings/update': {
    decoratingStage?: boolean;
    shopName?: string;
    shopAddress?: string | null;
    shopPhone?: string | null;
    receiptFooter?: string | null;
    paymentMethods?: PaymentMethod[];
    lowStockUnits?: number;
    bigDifferencePercent?: number;
    refundCooldownMinutes?: number;
    offlineEnabled?: boolean;
    offlinePassHours?: number;
    offlineMaxSales?: number;
    offlineMaxTotal?: number;
  };

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
    /** Packaging (boxes, boards, ribbon) has no baker usage amounts and no recipes. Default: ingredient. */
    kind?: 'ingredient' | 'packaging';
  };
  'inventory/update_ingredient': {
    ingredientId: Id;
    name?: string;
    reorderLevel?: number | null;
    allergens?: string[];
    /** Replaces the whole list. Keep an `id` to keep that amount's identity. */
    ranges?: { id?: Id; label: string; min: number; max: number }[];
    active?: boolean;
    kind?: 'ingredient' | 'packaging';
    /** The unit `reorderLevel` and `ranges` are written in. */
    unit?: UnitCode;
  };
  'inventory/receive': { ingredientId: Id; qty: number; unit?: UnitCode; note?: string };
  'inventory/count': { ingredientId: Id; counted: number; unit?: UnitCode; note?: string };
  'inventory/write_off': { ingredientId: Id; qty: number; unit?: UnitCode; note?: string };

  /** Start the daily count, or pick up the one already in progress (then `resumed` is true in the result). */
  'count/start': Record<string, never>;
  /** Write down one item's count. `counted: null` skips it (clears a count already written). Stock does not change yet. */
  'count/record': { sessionId: Id; ingredientId: Id; counted: number | null; unit?: UnitCode };
  /** Apply everything counted. Skipped items are left alone. Big differences (10% or more) go to the owner as a request. */
  'count/submit': { sessionId: Id };
  /** Throw the count away without changing stock. */
  'count/discard': { sessionId: Id };

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

  'alerts/mark_seen': { alertIds: Id[] };
  /** "I'm on it." Silences the alert for everyone's notifications; it stays open until the problem clears. */
  'alerts/acknowledge': { alertId: Id };
  /** Hides the alert from your own list for 1 to 72 hours. */
  'alerts/snooze': { alertId: Id; hours: number };
  'alerts/configure': {
    stockoutDays?: number;
    reorderDays?: number;
    usageWaitHours?: number;
    quoteWaitHours?: number;
    dueSoonDays?: number;
    countDifference?: number;
    urgentRequestMinutes?: number;
    requestWaitHours?: number;
    critical?: Partial<Record<AlertKind, boolean>>;
  };

  /** Change where alerts reach a person. The owner can change anyone; everyone else only themselves. `phone: null` removes it. */
  'staff/set_contact': { userId: Id; phone?: string | null; sms?: MessageLevel; whatsapp?: MessageLevel };
  /** Register this phone or browser for notifications (the values come from the browser's push subscription). */
  'push/subscribe': { endpoint: string; p256dh: string; auth: string; userAgent?: string };
  'push/unsubscribe': { endpoint: string };
  /** Send yourself a test on every channel you have set up. Once a minute at most. */
  'notify/send_test': Record<string, never>;

  /**
   * Message a role (anyone with it may act) or one person. Give `choices` (2 to 4) to ask a question instead:
   * the answer closes it. `urgent` puts it at the top and escalates to the owner sooner if nobody takes it.
   */
  'requests/send': {
    toRole?: Role;
    toUserId?: Id;
    category: (typeof REQUEST_CATEGORIES)[number];
    tag?: string;
    title: string;
    body?: string;
    urgent?: boolean;
    link?: string;
    orderId?: Id;
    choices?: string[];
  };
  /** Records that you have read a request addressed to you. Safe to send more than once. */
  'requests/mark_seen': { requestId: Id };
  /** "I'll take it." Shows who owns the request. */
  'requests/acknowledge': { requestId: Id };
  'requests/done': { requestId: Id; note?: string };
  /** Answer a question (a request with choices). Closes it. */
  'requests/decide': { requestId: Id; choice: string; note?: string };
  /** The sender agrees it is fixed. Closes it. */
  'requests/confirm': { requestId: Id };
  /** The sender says it is not fixed. Back to Acknowledged. */
  'requests/reopen': { requestId: Id; reason?: string };
  /** The sender takes it back before anyone has taken it. */
  'requests/withdraw': { requestId: Id };

  /** Owner only. Staff see it on their screen; with `requiresAck` they are asked to confirm they read it. */
  'announcements/post': { text: string; requiresAck?: boolean };
  /** Records that you have read an announcement. Safe to send more than once. */
  'announcements/mark_seen': { announcementId: Id };
  /** "I have read this." Only for announcements that ask for it. */
  'announcements/acknowledge': { announcementId: Id };
  /** Owner only. Takes an announcement down for everyone. */
  'announcements/retire': { announcementId: Id };

  'sync/flush': Record<string, never>;
  /** Queue every record for the online database. For connecting a new one or recovering a lost one. */
  'sync/full_copy': Record<string, never>;
}
export type IntentName = keyof IntentMap;

export type CircuitName = 'Auth' | 'Devices' | 'Staff' | 'Catalogue' | 'Stock' | 'Orders' | 'Quotes' | 'Settings' | 'Inventory' | 'Recipes' | 'Usage' | 'Alerts' | 'Notify' | 'Payments' | 'Messages' | 'Sync' | 'Offline';

/** Circuits from the blueprint that are planned but not built yet. Shown honestly on the panel map. */
export const PLANNED_CIRCUITS = [
  'Delivery',
  'Production',
  'Reports',
  'Comms',
] as const;

export interface PanelConfig {
  devicePrefix: string;
  formatMoney: (n: number) => string;
  /** The word in front of amounts, such as "TSh". */
  currencyLabel: string;
  /** Wrong PINs allowed before a lock. */
  lockoutMaxFailures: number;
  /** Lock length in minutes for the 1st, 2nd, 3rd... lock. The last value repeats. */
  lockoutMinutes: number[];
  /** A session ends after this long without use. */
  sessionIdleMs: number;
  /** A session ends this long after sign-in, however busy. */
  sessionMaxMs: number;
  /** Only registered devices may sign in or see the staff names. */
  requireDevice: boolean;
  /** How long a pairing code works. */
  pairingCodeMs: number;
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
  /** The registered device this request came from, if it sent a valid secret and was not revoked. */
  device: Device | null;
  /** The secret the device sent, so a handler can tell "none" from "unknown". */
  deviceToken: string | undefined;
  now(): string;
  /** Returns the bearer token. Only its hash is stored. */
  issueSession(s: Session, deviceId?: string): Promise<string>;
  endSession(token: string | undefined): Promise<void>;
  /** End every sign-in made on one device. */
  revokeDeviceSessions(deviceId: string): Promise<void>;
  /** End every session of a person, optionally keeping the one they are using now. */
  revokeSessions(userId: string, exceptToken?: string): Promise<void>;
  /** The bearer token of the current request, if any. */
  sessionId: string | undefined;
  /** The secret for one offline pass, worked out from the server's master key. Never stored. */
  passKey(passId: string, userId: string, deviceId: string): Promise<string>;
  /** Runs another instruction as someone else, at a given time, inside the current step. Used to approve a held offline sale. */
  runAs(session: Session, at: string, type: IntentName, payload: unknown): Promise<HandlerResult>;
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
  /** The answer holds a secret, so it is never remembered for retries. */
  skipRequestMemo?: boolean;
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
