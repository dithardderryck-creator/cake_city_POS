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

export type IngredientUnit = 'g' | 'kg' | 'ml' | 'l' | 'pcs';

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
  createdAt: string;
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

/** Shop-wide switches the owner controls. One record, id "shop". */
export interface ShopSettings {
  id: 'shop';
  /** Custom cakes pass through a Decorating stage between In production and Ready (D-11). */
  decoratingStage: boolean;
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
