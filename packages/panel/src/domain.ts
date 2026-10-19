/**
 * Domain types. See docs/blueprint.md section 4 for the source of truth.
 * Only the slice built so far is here: staff, catalogue, orders, payments, stock, audit, outbox.
 */
export type Id = string;
export type Role = 'owner' | 'cashier' | 'baker' | 'inventory' | 'it';
export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'mobile_money';
/**
 * Where one line of an order is. Catalogue lines use new, ready, out_for_delivery, completed, cancelled.
 * Custom cake lines also use draft, awaiting_quote, in_production and decorating (blueprint 5.1).
 */
export type LineStatus =
  | 'draft'
  | 'awaiting_quote'
  | 'new'
  | 'in_production'
  | 'decorating'
  | 'ready'
  | 'out_for_delivery'
  | 'completed'
  | 'cancelled';
export type OrderStatus = LineStatus | 'empty';
export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'refunded';

/** A phone, tablet or computer the owner or IT has allowed to use the system. Only a hash of its secret is kept. */
export interface Device {
  id: Id;
  name: string;
  tokenHash: string;
  createdAt: string;
  createdByName: string;
  lastSeenAt?: string;
  revokedAt?: string;
  revokedByName?: string;
}

/** A one-time code that lets one device register itself. Only a hash of the code is kept. */
export interface PairingCode {
  id: string;
  /** The name the device will get, such as "Counter tablet". */
  name: string;
  createdAt: string;
  expiresAt: string;
  createdByName: string;
  usedAt?: string;
  cancelledAt?: string;
  /** Set when this code re-registers a device whose browser lost its secret. Using the code retires that old device. */
  replacesDeviceId?: string;
}

export interface Session {
  userId: Id;
  name: string;
  role: Role;
}

/** How much a person wants by text message: nothing, only critical alerts, or every alert for them. */
export type MessageLevel = 'off' | 'critical' | 'all';

export interface StaffContact {
  /** International format, such as +255712345678. */
  phone?: string;
  sms: MessageLevel;
  whatsapp: MessageLevel;
}

export interface Staff {
  id: Id;
  name: string;
  role: Role;
  pinHash: string;
  active: boolean;
  /** Set when the owner removed this person. The record stays only so past orders, payments and audit entries still show who did them; they cannot sign in and are hidden from every list. */
  removedAt?: string;
  /** Where alerts reach this person outside the app. Absent until set. */
  contact?: StaffContact;
}

/** A phone or browser that has agreed to receive notifications from this shop. Only that person's own devices. */
export interface PushSubscriptionRecord {
  /** Hash of the endpoint, so the same device is never stored twice. */
  id: Id;
  userId: Id;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
  createdAt: string;
}

export type DeliveryChannel = 'push' | 'sms' | 'whatsapp';

/** One message to one person on one channel, with its own retries. Lives inside a notify outbox item. */
export interface Delivery {
  id: Id;
  userId: Id;
  userName: string;
  channel: DeliveryChannel;
  /** The phone number, or the subscription id for push. */
  target: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  /** Earliest time for the next try. */
  nextAt?: string;
  /** Set while a send is under way, so two runs never send the same message at once. */
  inFlightAt?: string;
  lastError?: string;
  doneAt?: string;
}

export interface NotifyPayload {
  alertId?: Id;
  /** A test message to one person (nobody is woken for it but them). */
  test?: { userId: Id };
  deliveries?: Delivery[];
  note?: string;
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
  /** Kept in the catalogue but not shown to the counter or sold. The owner can bring it back (not the same as archived). */
  hidden?: boolean;
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
  /** Digits with country code, for sending a receipt. Optional. */
  customerPhone?: string;
  partialAllowed: boolean;
  /** Rung up at the counter in one step (quick sale). Finished ones stay off the boards. */
  instant?: boolean;
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

/** What a customer asked for in a one-off cake. Attributes are the set in blueprint 4.4 (Q-04 may refine them). */
export interface CakeSpec {
  /** How many people it should serve. */
  servings: number;
  /** Optional wording for the size, such as "8 inch round". */
  sizeNote?: string;
  flavor: string;
  filling?: string;
  layers: number;
  /** For example eggless, gluten-free, sugar-free. */
  dietary: string[];
  decorationNotes?: string;
  /** Text to pipe on the cake. */
  inscription?: string;
  /** Allergies the customer mentioned. Shown to the baker. */
  allergyNotes?: string;
  /** Photos of the customer's idea. See the photos collection. */
  photoIds: Id[];
}

/** The fields a person types. The panel fills in photoIds itself. */
export type CakeSpecInput = Omit<CakeSpec, 'photoIds' | 'layers' | 'dietary'> & { layers?: number; dietary?: string[] };

export interface CustomLineData {
  spec: CakeSpec;
  /** The latest quote request for this line. Older ones stay in the quotes collection. */
  quoteId?: Id;
  quotedBy?: Id;
  quotedAt?: string;
}

export interface OrderLine {
  id: Id;
  orderId: Id;
  type: 'catalogue' | 'custom';
  /** Catalogue lines only. */
  combinationId?: Id;
  /** Always 1 for a custom cake. */
  qty: number;
  snapshot: LineSnapshot;
  status: LineStatus;
  /** Custom cake lines only. */
  custom?: CustomLineData;
}

export type QuoteStatus = 'sent' | 'seen' | 'quoted' | 'declined' | 'withdrawn';

export interface QuoteEvent {
  at: string;
  by: Id;
  byName: string;
  event: 'sent' | 'seen' | 'quoted' | 'declined' | 'withdrawn' | 'revised';
  note?: string;
  price?: number;
}

/**
 * A request to the owner to price one custom cake (BR-05). Follows the request lifecycle in
 * blueprint 5.4: sent, seen, then closed by the owner's answer or by the sender withdrawing it.
 */
export interface Quote {
  id: Id;
  orderId: Id;
  lineId: Id;
  status: QuoteStatus;
  requestedBy: Id;
  requestedByName: string;
  requestedAt: string;
  note?: string;
  price?: number;
  /** The owner's note with a quote, or the reason for declining. */
  answer?: string;
  resolvedAt?: string;
  timeline: QuoteEvent[];
}

/** Stored metadata for an uploaded picture. The bytes live in photoData. */
export interface Photo {
  id: Id;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  size: number;
  uploadedBy: Id;
  uploadedAt: string;
  /** Set when the photo is attached to a custom cake line. Unattached photos are cleaned up after a day. */
  attachedTo?: Id;
  orderId?: Id;
}

export interface PhotoData {
  id: Id;
  /** Base64 of the image bytes. Stored in the database so backups include it. */
  data: string;
}

/** Stored quantities are always in the metric base unit: kg, l or pcs (D-62). Other units are converted on the way in. */
export type IngredientUnit = 'kg' | 'l' | 'pcs';

/** A preset amount the baker taps instead of typing (D-14), such as "Light, 100 to 200 g". */
export interface IngredientRange {
  id: Id;
  label: string;
  min: number;
  max: number;
}

export interface Ingredient {
  id: Id;
  name: string;
  unit: IngredientUnit;
  onHand: number;
  reorderLevel?: number;
  allergens: string[];
  ranges: IngredientRange[];
  /** Switched off instead of deleted, like products (BR-10). */
  active: boolean;
  /** Boxes, boards and ribbon are packaging. They are counted and reordered like ingredients but never appear in recipes. Missing means ingredient. */
  kind?: 'ingredient' | 'packaging';
  /** When it was last counted (a single count or the daily count). */
  countedAt?: string;
  createdAt: string;
}

/**
 * A daily count. Counts are kept on the server while the person works through the list, so it can be put down and
 * picked up again (even on another device). Nothing changes in stock until it is submitted.
 */
export interface CountSession {
  id: Id;
  status: 'open' | 'submitted' | 'discarded';
  startedById: Id;
  startedByName: string;
  startedAt: string;
  /** Amounts counted so far, in each item's base unit. An item not in here is skipped. */
  counts: Record<Id, number>;
  submittedAt?: string;
  /** Filled in when submitted. What was expected, what was counted, and whether the difference was big. */
  results?: CountResult[];
}
export interface CountResult {
  ingredientId: Id;
  name: string;
  unit: IngredientUnit;
  expected: number;
  counted: number;
  difference: number;
  /** At least 10% away from what was expected. */
  big: boolean;
}

export interface IngredientMovement {
  id: Id;
  ingredientId: Id;
  /** Positive adds stock, negative removes it. */
  qty: number;
  reason: 'opening' | 'delivery' | 'correction' | 'waste' | 'usage';
  /** For usage that could not come out of stock because there was not enough on hand. */
  shortfall?: number;
  reportId?: Id;
  orderId?: Id;
  note?: string;
  by: Id;
  at: string;
}

/** How a recipe line grows with the cake. */
export type RuleScaling =
  /** quantity x servings */
  | 'per_serving'
  /** quantity x servings x (layers - 1): filling and frosting between layers */
  | 'per_layer_gap'
  /** the same for every cake */
  | 'fixed';

/**
 * One line of the shop's recipe knowledge: "use this much of this ingredient, for cakes like this".
 * Empty flavor/filling lists mean "any". The generator adds up every line that fits a cake (D-13).
 */
export interface RecipeRule {
  id: Id;
  ingredientId: Id;
  quantity: number;
  scaling: RuleScaling;
  flavors: string[];
  fillings: string[];
  /** Only for cakes that have all of these dietary tags (for example a substitute for eggs). */
  needsDietary: string[];
  /** Left out of cakes that have any of these dietary tags (for example eggs in an eggless cake). */
  excludedByDietary: string[];
  note?: string;
}

export interface UsageSuggestionLine {
  ingredientId: Id;
  name: string;
  unit: IngredientUnit;
  qty: number;
}

/** What the system thinks a custom cake needs. One per cake line; the id is the line's id. */
export interface UsageSuggestion {
  id: Id;
  orderId: Id;
  lineId: Id;
  lines: UsageSuggestionLine[];
  generatedAt: string;
  generator: 'rules';
}

export interface UsageReportItem {
  ingredientId: Id;
  name: string;
  unit: IngredientUnit;
  rangeId: Id;
  rangeLabel: string;
  min: number;
  max: number;
  /** Not on the suggestion: the baker added it. */
  extra: boolean;
}

export type UsageReportStatus = 'reported' | 'confirmed' | 'sent_back';

export interface UsageReport {
  id: Id;
  orderId: Id;
  lineId: Id;
  status: UsageReportStatus;
  items: UsageReportItem[];
  reportedBy: Id;
  reportedByName: string;
  reportedAt: string;
  note?: string;
  confirmedBy?: Id;
  confirmedByName?: string;
  confirmedAt?: string;
  confirmed?: Array<{ ingredientId: Id; qty: number }>;
  sentBackReason?: string;
}

/* ---------- Alerts (BR-23, BR-24) ---------- */

export type AlertKind = 'low_stock' | 'stockout' | 'usage_waiting' | 'order_not_started' | 'quote_waiting' | 'overdue_delivery' | 'count_difference' | 'request_waiting' | 'offline_held';
export type AlertSeverity = 'warning' | 'critical';

/**
 * Something that needs a person. Raised by the system when a condition becomes true and resolved by the system when
 * it stops being true. One open alert per `dedupeKey` (BR-23). People can see, acknowledge and snooze it.
 */
export interface Alert {
  id: Id;
  dedupeKey: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  body: string;
  /** Who it is for. Critical alerts always include the owner (BR-24). */
  to: Role[];
  /** The screen to open and the record on it. */
  screen: string;
  targetId?: string;
  status: 'open' | 'resolved';
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: 'system' | 'acknowledged';
  /** Per person: when they first saw it. */
  seen: Record<Id, string>;
  acknowledgedBy?: { userId: Id; name: string; at: string };
  /** Per person: hidden from their list until then. */
  snoozed: Record<Id, string>;
}

/** The owner's thresholds and which alerts are critical (A-11). One record, id "alerts". */
export interface AlertSettings {
  id: 'alerts';
  /** Stock expected to run out within this many days raises "stockout". */
  stockoutDays: number;
  /** Stock expected to reach its reorder level within this many days raises "low stock". */
  reorderDays: number;
  /** Usage waiting for Inventory longer than this many hours. Twice as long also alerts the owner. */
  usageWaitHours: number;
  /** A price request waiting for the owner longer than this many hours. */
  quoteWaitHours: number;
  /** A cake not started this many days before its date (or later) raises an alert. */
  dueSoonDays: number;
  /** A count differing by this many items or more at hand-over. */
  countDifference: number;
  /** An urgent staff request nobody has taken after this many minutes is escalated to the owner. */
  urgentRequestMinutes: number;
  /** An ordinary staff request nobody has taken after this many hours alerts the people it is for; twice as long also alerts the owner. */
  requestWaitHours: number;
  /** Critical alerts also go to the owner by SMS/WhatsApp. */
  critical: Record<AlertKind, boolean>;
}

export type RequestStatus = 'sent' | 'seen' | 'acknowledged' | 'done' | 'confirmed' | 'withdrawn';
export const REQUEST_CATEGORIES = ['Maintenance', 'System error', 'Stock and supplies', 'Order issue', 'Money', 'Approval', 'Staffing', 'Safety and hygiene', 'Other'] as const;

/**
 * A message from one member of staff to a role or a person, with a lifecycle: Sent, Seen, Acknowledged (someone takes it),
 * Done (they say it is dealt with), Confirmed (the sender agrees). A request with `choices` is a question: the answer closes it.
 */
export interface StaffRequest {
  id: Id;
  category: (typeof REQUEST_CATEGORIES)[number];
  /** For category "Other": a short word the sender chose. */
  tag?: string;
  urgent: boolean;
  title: string;
  body?: string;
  /** Plain words about what this is about, for example "Order A-0076". */
  link?: string;
  orderId?: Id;
  fromId: Id;
  fromName: string;
  fromRole: Role;
  /** Exactly one of these is set. A role means anyone with that role may act. */
  toRole?: Role;
  toUserId?: Id;
  toName?: string;
  /** The role the request is for (for a person, their role). Used for alerts. */
  audience: Role;
  /** Answers the person it is for may choose from. Choosing one closes the request. */
  choices?: string[];
  outcome?: string;
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  seenBy: Record<Id, { name: string; at: string }>;
  takenBy?: { userId: Id; name: string; at: string };
  timeline: { at: string; text: string }[];
}

/**
 * A message from the owner to all staff. Not a conversation: staff can only see it and, when asked, acknowledge it.
 */
export interface Announcement {
  id: Id;
  text: string;
  /** Staff are asked to confirm they have read it. */
  requiresAck: boolean;
  postedById: Id;
  postedByName: string;
  createdAt: string;
  /** Taken down by the owner. Kept for the record, shown to nobody. */
  retiredAt?: string;
  seenBy: Record<Id, { name: string; at: string }>;
  ackedBy: Record<Id, { name: string; at: string }>;
}

/** Shop-wide switches the owner controls. One record, id "shop". */
export interface ShopSettings {
  id: 'shop';
  /** Custom cakes pass through a Decorating stage between In production and Ready (D-11). */
  decoratingStage: boolean;
  /** Printed at the top of every receipt. */
  shopName: string;
  shopAddress?: string;
  shopPhone?: string;
  /** A line at the bottom of every receipt, such as "Thank you!". */
  receiptFooter?: string;
  /** Payment methods the counter takes. Loaded with every method when the owner has not chosen. */
  paymentMethods: PaymentMethod[];
  /** At the counter a size with this many or fewer left is shown as running low. */
  lowStockUnits: number;
  /** A stock count off by this percent or more is flagged as a big difference. */
  bigDifferencePercent: number;
  /** Minutes after the latest payment on an order before any refund on it is allowed. 0 switches the wait off. */
  refundCooldownMinutes: number;
  /** Tills may keep selling when the connection is gone, and send the sales later. Off until the owner switches it on. */
  offlineEnabled: boolean;
  /** How long an offline pass lasts. */
  offlinePassHours: number;
  /** Most sales one pass may carry. */
  offlineMaxSales: number;
  /** Most money one pass may carry, in shillings. */
  offlineMaxTotal: number;
  /** Who may count the cash and close the day. */
  dayCloseBy: 'owner' | 'cashier_and_owner';
  /** The language the screens are shown in. The server and its records stay in English; only the screens are translated. */
  language: 'en' | 'sw';
}

/**
 * Permission for one registered device and one person to sell offline for a while. The pass key itself is never stored:
 * it is worked out from the server's master key. Sending a queue also needs the device's own secret, which is only kept as a hash.
 */
export interface OfflinePass {
  id: Id;
  userId: Id;
  userName: string;
  deviceId: Id;
  deviceName: string;
  issuedAt: string;
  expiresAt: string;
  maxSales: number;
  maxTotal: number;
  /** A newer pass replaced this one: only sales made before this moment still count. */
  closedAt?: string;
  /** The next sequence number the server will accept. */
  nextSeq: number;
  /** The tag of the last accepted sale, which the next one must be chained to. */
  lastTag: string;
  /** Device time of the last accepted sale. Time never goes backwards along the chain. */
  lastAt?: string;
  /** Sales that went through, and their total. */
  sales: number;
  total: number;
}

/** A queued sale that arrived but could not be replayed honestly. It waits for the owner. */
export interface HeldAction {
  id: Id;
  passId: Id;
  userId: Id;
  userName: string;
  deviceId: Id;
  deviceName: string;
  requestId: string;
  type: string;
  payload: unknown;
  /** When the sale was made, by the device's clock. */
  queuedAt: string;
  receivedAt: string;
  reasons: string[];
  status: 'held' | 'approved' | 'dismissed';
  resolvedAt?: string;
  resolvedByName?: string;
  note?: string;
  /** The order made when the owner approved it. */
  orderId?: Id;
}

/** The cash count that closes one day. Closing locks nothing: sales after it simply count in the next report. */
export interface DayClose {
  id: Id; // the day, YYYY-MM-DD
  day: string;
  closedAt: string;
  closedById: Id;
  closedByName: string;
  /** Cash in the drawer at the start of the day: what was left in it when the previous day was closed. */
  openingFloat: number;
  cashIn: number;
  cashRefunded: number;
  /** openingFloat + cashIn - cashRefunded, worked out at the moment of closing. */
  expectedCash: number;
  countedCash: number;
  difference: number;
  /** Cash left in the drawer for tomorrow. */
  floatKept: number;
  note?: string;
  /** Sales taken and refunds paid, by method, as they stood when the day was closed. */
  netTotal: number;
}

/** What happened to one queued sale when it arrived. Lets a repeated send be answered without running anything twice. */
export interface OfflineSeen {
  id: Id; // `${passId}:${seq}`
  passId: Id;
  seq: number;
  tag: string;
  requestId: string;
  status: 'done' | 'held';
  receivedAt: string;
  /** Plain-language line shown to the till. */
  message: string;
  orderId?: Id;
  number?: string;
  total?: number;
  heldId?: Id;
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

/** A batch of finished, ready-to-sell items the baker made. It adds to the counter stock of one version of a product. */
export interface Batch {
  id: Id;
  combinationId: Id;
  productId: Id;
  /** For example "Brownie" or "Chocolate cake, 8-inch". */
  label: string;
  qty: number;
  note?: string;
  byId: Id;
  byName: string;
  at: string;
  /** Taken back after a mistake. The stock it added is taken off again. */
  undoneAt?: string;
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
  kind: 'sync' | 'whatsapp' | 'sms' | 'print' | 'recipe' | 'notify';
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
