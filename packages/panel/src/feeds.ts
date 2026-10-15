import type {
  PaymentMethod,
  Device,
  HeldAction,
  OfflinePass,
  PairingCode,
  Alert,
  AlertKind,
  AuditEntry,
  CakeSpec,
  DeliveryChannel,
  MessageLevel,
  NotifyPayload,
  Ingredient,
  IngredientMovement,
  IngredientUnit,
  Quote,
  RecipeRule,
  RuleScaling,
  UsageReport,
  UsageSuggestion,
  QuoteStatus,
  Combination,
  Order,
  OrderLine,
  OrderStatus,
  OptionGroup,
  OptionValue,
  OutboxItem,
  Payment,
  PaymentStatus,
  Product,
  Refund,
  Role,
  Session,
  PushSubscriptionRecord,
  Staff,
  StaffRequest,
} from './domain';
import { REQUEST_CATEGORIES } from './domain';
import { daysBetween, todayLocal } from './circuits/dates';
import { ALL_PAYMENT_METHODS, loadSettings } from './circuits/settings';
import { quickSaleTotal } from './circuits/orders';
import { DomainError } from './intents';
import { BASE_UNIT_FOR, formatQty, unitTable } from './units';
import { ALERT_KINDS, ALERT_KIND_LABEL, canSeeAlert, loadAlertSettings } from './circuits/alerts';
import { ROLE_LABEL, canSeeRequest, isFinal, isTarget, needsPerson, requestActions, type RequestAction } from './circuits/requests';
import { buildForecasts, type ForecastRow } from './forecast';
import { MAX_PHOTOS_PER_CAKE } from './circuits/custom';
import type { LoginState } from './circuits/pin';
import { PLANNED_CIRCUITS, type CircuitName, type PanelConfig } from './intents';
import type { BackupStatus, Clock, Store, Terminals } from './ports';
import {
  PAYMENT_LABEL,
  PAYMENT_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  canRemoveLine,
  deriveOrderStatus,
  isCustom,
  lineTotal,
  moneySummary,
  nextActions,
  type LineAction,
  type Tone,
} from './circuits/order-logic';
import { loadOrderBundle } from './circuits/orders';
import { batchFeeds, type BatchLogData } from './circuits/batches';
import { daysLeftInfo } from './days-left';
import { reportFeeds, type ReportsData, type ReportsParams } from './circuits/reports';
import { countFeeds, type CountSessionData } from './circuits/count';
import { announcementFeeds, type AnnouncementsData } from './circuits/announcements';
import { moneyFeeds, type PaymentsLedgerData, type ReceiptData } from './circuits/money-feeds';
import { dayCloseFeeds, type DayReportData } from './circuits/day-close';

/* ---------- Feed data shapes (what the UI receives) ---------- */

export interface CatalogueCombination {
  combinationId: string;
  label: string;
  valueIds: string[];
  price: number | null;
  priceLabel: string | null;
  onHand: number;
  committed: number;
  sellable: boolean;
  reason: string | null;
  markedUnavailable: boolean;
  warning: string | null;
}
export interface CatalogueGridItem {
  productId: string;
  name: string;
  category: string;
  description: string;
  archived: boolean;
  /** Hidden from the counter by the owner. Only the owner's list includes hidden items. */
  hidden: boolean;
  availableToday: boolean;
  allergens: string[];
  groups: { groupId: string; name: string; values: { valueId: string; label: string }[] }[];
  combinations: CatalogueCombination[];
  priceFromLabel: string | null;
  sellable: boolean;
  /** What the signed-in person may change here. The UI shows or hides controls from this. */
  can: { price: boolean; stock: boolean; manage: boolean };
}

export interface OrderListItem {
  orderId: string;
  number: string;
  customerName: string;
  fulfilment: 'pickup' | 'delivery';
  deliveryDate?: string;
  status: OrderStatus;
  statusLabel: string;
  statusTone: Tone;
  paymentStatus: PaymentStatus;
  paymentLabel: string;
  paymentTone: Tone;
  totalLabel: string;
  balanceLabel: string;
  itemCount: number;
  /** A custom cake is waiting for the owner to price it. */
  needsQuote: boolean;
  /** The total is not final yet because a custom cake has no price. */
  quotePending: boolean;
  hasCustomCake: boolean;
  /** Sold at the counter in one step. */
  instant: boolean;
}

/** What the customer asked for in a custom cake, ready to display. */
export interface CakeDetails {
  servings: number;
  sizeNote?: string;
  flavor: string;
  filling?: string;
  layers: number;
  dietary: string[];
  decorationNotes?: string;
  inscription?: string;
  allergyNotes?: string;
  /** Fetch each picture with the client's photo() call. */
  photoIds: string[];
}

export interface QuoteState {
  quoteId: string;
  status: QuoteStatus;
  statusLabel: string;
  priceLabel?: string;
  /** The cashier's note to the owner. */
  note?: string;
  /** The owner's note with the price, or the reason for declining. */
  answer?: string;
  requestedByName: string;
  requestedAt: string;
  resolvedAt?: string;
}

export interface OrderCardLine {
  lineId: string;
  title: string;
  options: string;
  allergens: string[];
  qty: number;
  unitPriceLabel: string;
  totalLabel: string;
  status: string;
  statusLabel: string;
  statusTone: Tone;
  cancelled: boolean;
  actions: LineAction[];
  canRemove: boolean;
  kind: 'catalogue' | 'custom';
  /** Custom cakes only. */
  cake?: CakeDetails;
  quote?: QuoteState;
  /** Details and photos can be changed (draft, or quoted but not yet started). */
  canEdit: boolean;
  canRequestQuote: boolean;
  /** Why the quote cannot be requested yet, in plain words. */
  quoteBlockedReason: string | null;
  canWithdrawQuote: boolean;
  maxPhotos: number;
}
export interface OrderCardData extends OrderListItem {
  source: 'walk_in' | 'phone';
  deliveryAddress?: string;
  customerPhone?: string;
  lines: OrderCardLine[];
  paidLabel: string;
  refundedLabel: string | null;
  balance: number;
  total: number;
  canRecordPayment: boolean;
  canCancel: boolean;
  canEditDelivery: boolean;
  canRefund: boolean;
  refundableLabel: string;
  payments: { id: string; methodLabel: string; amountLabel: string; at: string; reference?: string }[];
  warnings: string[];
}

export interface AuditRow {
  id: string;
  at: string;
  who: string;
  role?: Role;
  intent: string;
  summary: string;
  outcome: AuditEntry['outcome'];
}

export interface DeviceRow {
  id: string;
  name: string;
  createdAt: string;
  createdByName: string;
  lastSeenAt: string | null;
  /** True for the device this person is using right now. */
  isThis: boolean;
}
export interface DeviceCodeRow {
  id: string;
  name: string;
  createdByName: string;
  expiresAt: string;
}
export interface DeviceListData {
  /** False when the host runs without the device check (a local demo). Then every device can sign in. */
  required: boolean;
  devices: DeviceRow[];
  revoked: { id: string; name: string; revokedAt: string; revokedByName: string }[];
  /** Codes that were made and not used yet. The code itself is never shown again. */
  openCodes: DeviceCodeRow[];
}

export interface StaffListRow {
  id: string;
  name: string;
  role: Role;
  active: boolean;
  locked: boolean;
  /** Where alerts reach this person outside the app. */
  contact: { phone: string | null; sms: MessageLevel; whatsapp: MessageLevel };
}

export interface PanelMapData {
  circuits: {
    name: string;
    status: 'live' | 'planned';
    handled: number;
    denied: number;
    invalid: number;
    errors: number;
    lastActivityAt: string | null;
  }[];
  outbox: { pending: number; sent: number; failed: number };
  terminals: { name: string; state: string }[];
  activeSessions: number;
  backup: BackupStatus | null;
  system: { label: string; value: string }[];
}

export interface StaffSigninRow {
  id: string;
  name: string;
  role: Role;
}

export type ScreenId =
  | 'sell'
  | 'orders'
  | 'quotes'
  | 'bake_queue'
  | 'ingredients'
  | 'usage_inbox'
  | 'alerts'
  | 'forecast'
  | 'recipes'
  | 'catalogue'
  | 'staff'
  | 'settings'
  | 'audit'
  | 'requests'
  | 'panel_map';
export interface NavItem {
  id: ScreenId;
  label: string;
  /** A number to show on the menu item, such as alerts nobody has seen yet. Absent when there is nothing to show. */
  badge?: number;
}

export interface RequestRow {
  requestId: string;
  title: string;
  body?: string;
  category: string;
  urgent: boolean;
  link?: string;
  orderId?: string;
  from: { userId: string; name: string; role: Role };
  to: { label: string; role: Role; userId?: string };
  status: StaffRequest['status'];
  statusLabel: string;
  /** The step labels for the progress bar, and which one this request is on. */
  steps: string[];
  step: number;
  seenBy: string[];
  takenByName: string | null;
  choices?: string[];
  outcome?: string;
  createdAt: string;
  updatedAt: string;
  /** When an unanswered request will be sent up to the owner. Absent once someone has taken it, or if it is for the owner. */
  escalatesAt?: string;
  escalated: boolean;
  /** The person asking is you. */
  mine: boolean;
  /** It is addressed to you (directly or through your role). */
  forMe: boolean;
  /** Waiting for you to do something. */
  needsYou: boolean;
  actions: RequestAction[];
  final: boolean;
  timeline: { at: string; text: string }[];
}
export interface RequestInboxData {
  /** Open ones first (urgent, then newest), then the most recently closed. */
  rows: RequestRow[];
  counts: { needsYou: number; open: number };
  /** Who can be asked, for the "new request" form. */
  targets: { roles: { role: Role; label: string }[]; people: { userId: string; name: string; role: Role }[] };
  categories: string[];
  can: { send: boolean };
}

export interface QuoteRow {
  quoteId: string;
  orderId: string;
  orderNumber: string;
  lineId: string;
  customerName: string;
  deliveryDate?: string;
  fulfilment: 'pickup' | 'delivery';
  status: QuoteStatus;
  statusLabel: string;
  requestedByName: string;
  requestedAt: string;
  note?: string;
  priceLabel?: string;
  answer?: string;
  resolvedAt?: string;
  cake: CakeDetails;
}
export interface QuoteInboxData {
  /** Waiting for the owner. Soonest delivery date first. */
  open: QuoteRow[];
  /** The most recent answered or withdrawn requests. */
  recent: QuoteRow[];
  can: { provide: boolean; withdraw: boolean };
}

export type Urgency = 'late' | 'today' | 'soon' | 'later' | 'undated';
export interface BakeRow {
  lineId: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  deliveryDate?: string;
  fulfilment: 'pickup' | 'delivery';
  /** For example "Today", "Tomorrow", "In 3 days", "2 days late". */
  dueLabel: string;
  urgency: Urgency;
  status: string;
  statusLabel: string;
  statusTone: Tone;
  actions: LineAction[];
  cake: CakeDetails;
  usage: { state: 'not_started' | 'suggested' | 'reported' | 'confirmed' | 'sent_back'; canReport: boolean };
}
export interface BakeQueueData {
  rows: BakeRow[];
  counts: { late: number; today: number; toStart: number; inProduction: number; ready: number };
  decoratingStage: boolean;
}

export interface RangeRow {
  rangeId: string;
  label: string;
  min: number;
  max: number;
  /** "100 g to 200 g" */
  text: string;
}

export interface IngredientRow {
  ingredientId: string;
  name: string;
  unit: IngredientUnit;
  onHand: number;
  /** Reads well to a person: "250 g", "1.5 kg", "12 pcs". The numbers above are always in the base unit (kg, l, pcs). */
  onHandText: string;
  reorderLevel: number | null;
  reorderLevelText: string | null;
  /** On hand is at or below the reorder level. */
  low: boolean;
  allergens: string[];
  ranges: RangeRow[];
  active: boolean;
  kind: 'ingredient' | 'packaging';
  /** When it was last counted, or null. */
  countedAt: string | null;
  /** Reported by bakers but not yet confirmed by Inventory (BR-12). Stock has not moved yet. */
  pending: { min: number; max: number; text: string; reports: number } | null;
  /** From confirmed usage over the last 14 days (BR-14). Null when there is not enough history. */
  daysLeft: number | null;
  daysLeftLabel: string;
  can: { edit: boolean };
}

export interface RecipeRuleRow {
  ruleId: string;
  ingredientId: string;
  ingredientName: string;
  unit: IngredientUnit;
  quantity: number;
  quantityText: string;
  scaling: RuleScaling;
  scalingLabel: string;
  flavors: string[];
  fillings: string[];
  needsDietary: string[];
  excludedByDietary: string[];
  note?: string;
  /** One plain sentence describing when this line applies. */
  summary: string;
}

export interface UsageFormItem {
  ingredientId: string;
  name: string;
  unit: IngredientUnit;
  /** What the system expects for this cake. Null for ingredients that are not on the suggestion. */
  suggestedQty: number | null;
  suggestedText: string | null;
  ranges: RangeRow[];
  /** The amount that fits the suggestion best, so the baker can tap to accept. */
  suggestedRangeId: string | null;
}
export interface UsageFormData {
  lineId: string;
  orderId: string;
  orderNumber: string;
  cake: CakeDetails;
  suggested: UsageFormItem[];
  /** Every other ingredient the baker could add. */
  extras: UsageFormItem[];
  report: { reportId: string; status: 'reported' | 'confirmed' | 'sent_back'; reportedAt: string; sentBackReason?: string } | null;
  canReport: boolean;
  blockedReason: string | null;
}

export interface UsageReportRow {
  reportId: string;
  orderId: string;
  orderNumber: string;
  lineId: string;
  cake: CakeDetails;
  status: 'reported' | 'confirmed' | 'sent_back';
  statusLabel: string;
  reportedByName: string;
  reportedAt: string;
  note?: string;
  items: {
    ingredientId: string;
    name: string;
    unit: IngredientUnit;
    rangeLabel: string;
    min: number;
    max: number;
    extra: boolean;
    rangeText: string;
    suggestedQty: number | null;
    suggestedText: string | null;
    onHand: number;
    onHandText: string;
    confirmedQty?: number;
    confirmedText?: string;
  }[];
  confirmedByName?: string;
  confirmedAt?: string;
  sentBackReason?: string;
}
export interface AlertRow {
  alertId: string;
  kind: AlertKind;
  kindLabel: string;
  severity: 'warning' | 'critical';
  title: string;
  body: string;
  /** The screen to open and the record on it. */
  screen: string;
  targetId?: string;
  createdAt: string;
  /** You have already seen it. */
  seen: boolean;
  acknowledgedByName: string | null;
  acknowledgedAt?: string;
  snoozedUntil?: string;
  resolvedAt?: string;
  /** Who it was sent to. */
  to: Role[];
  can: { acknowledge: boolean; snooze: boolean };
}
export interface AlertInboxData {
  /** Critical first, then newest. Leaves out what you have snoozed. */
  open: AlertRow[];
  snoozed: AlertRow[];
  /** Recently cleared. */
  recent: AlertRow[];
  unseen: number;
  critical: number;
}
export interface NotificationSetupData {
  me: { userId: string; name: string; phone: string | null; sms: MessageLevel; whatsapp: MessageLevel };
  /** What this server can send. A channel that is off here cannot be chosen by anyone. */
  channels: { push: boolean; sms: boolean; whatsapp: boolean };
  push: {
    /** What the browser needs to subscribe. Null when push is not set up on the server. */
    publicKey: string | null;
    /** The addresses of this person's subscribed devices, so a browser can tell whether it is one of them. */
    endpoints: string[];
  };
  /** Plain-language reminders about things that stop messages arriving. */
  notes: string[];
}
export interface NotificationLogRow {
  itemId: string;
  at: string;
  /** The alert title, or "Test message". */
  title: string;
  kind: 'alert' | 'test';
  severity: 'warning' | 'critical' | 'test';
  status: 'pending' | 'sent' | 'failed';
  note?: string;
  deliveries: { who: string; channel: DeliveryChannel; status: 'pending' | 'sent' | 'failed' | 'skipped'; attempts: number; error?: string; nextAt?: string }[];
}
export interface AlertSettingsData {
  stockoutDays: number;
  reorderDays: number;
  usageWaitHours: number;
  quoteWaitHours: number;
  dueSoonDays: number;
  countDifference: number;
  urgentRequestMinutes: number;
  requestWaitHours: number;
  kinds: { kind: AlertKind; label: string; critical: boolean }[];
  can: { edit: boolean };
}
export interface StockForecastData {
  /** Most urgent first. Each row carries its own stock line (`series`): real up to today, projected after. */
  rows: ForecastRow[];
  generatedAt: string;
  horizonDays: number;
  /** In plain words, so the screen can show how the lines are worked out. */
  method: string;
}

export interface UnitListData {
  /** What stock is stored in: kg for weight, l for liquids, pcs for things you count. */
  baseUnits: { code: 'kg' | 'l' | 'pcs'; kind: 'mass' | 'volume' | 'count'; label: string }[];
  /** Every unit the shop can type a quantity in, with how many base units it is. For unit pickers and conversion. */
  units: ReturnType<typeof unitTable>;
}

export interface UsageInboxData {
  /** Waiting for Inventory, oldest first. */
  pending: UsageReportRow[];
  recent: UsageReportRow[];
  can: { confirm: boolean };
}

export interface ShopSettingsData {
  decoratingStage: boolean;
  shopName: string;
  shopAddress: string | null;
  shopPhone: string | null;
  receiptFooter: string | null;
  /** What amounts are written in, such as "TSh". Set on the server. */
  currencyLabel: string;
  /** The payment methods the counter takes now. */
  paymentMethods: { key: PaymentMethod; label: string }[];
  /** Every method the system knows, so the owner can switch each on or off. */
  allPaymentMethods: { key: PaymentMethod; label: string; on: boolean }[];
  lowStockUnits: number;
  bigDifferencePercent: number;
  refundCooldownMinutes: number;
  offlineEnabled: boolean;
  offlinePassHours: number;
  offlineMaxSales: number;
  offlineMaxTotal: number;
  dayCloseBy: 'owner' | 'cashier_and_owner';
  can: { edit: boolean };
}

export interface HeldSaleRow {
  id: string;
  userName: string;
  deviceName: string;
  /** When the sale was made, by the till's clock. */
  queuedAt: string;
  receivedAt: string;
  reasons: string[];
  /** What was being sold, in words. */
  items: string[];
  method: string | null;
  /** The total the customer was shown. */
  expectedTotal: number | null;
  /** The total at today's prices, when it can be worked out. */
  totalNow: number | null;
  canApprove: boolean;
}

export interface OfflineReviewData {
  /** Waiting for the owner, oldest first. */
  held: HeldSaleRow[];
  recent: Array<{ id: string; userName: string; deviceName: string; queuedAt: string; status: 'approved' | 'dismissed'; resolvedByName: string; resolvedAt: string; note: string | null; orderId: string | null }>;
  /** Offline permissions that are open now: who holds them and how much has been sold under each. */
  passes: Array<{ id: string; userName: string; deviceName: string; issuedAt: string; expiresAt: string; sales: number; total: number; maxSales: number; maxTotal: number }>;
  can: { review: boolean };
}

export interface FeedMap {
  me: { params: Record<string, never>; data: Session };
  navigation: { params: Record<string, never>; data: NavItem[] };
  staff_signin: { params: Record<string, never>; data: StaffSigninRow[] };
  staff_list: { params: Record<string, never>; data: StaffListRow[] };
  device_list: { params: Record<string, never>; data: DeviceListData };
  catalogue_grid: { params: { includeArchived?: boolean }; data: CatalogueGridItem[] };
  order_list: { params: Record<string, never>; data: OrderListItem[] };
  order_card: { params: { orderId: string }; data: OrderCardData };
  quote_inbox: { params: Record<string, never>; data: QuoteInboxData };
  bake_queue: { params: Record<string, never>; data: BakeQueueData };
  shop_settings: { params: Record<string, never>; data: ShopSettingsData };
  offline_review: { params: Record<string, never>; data: OfflineReviewData };
  ingredient_list: { params: { includeInactive?: boolean }; data: IngredientRow[] };
  recipe_rules: { params: Record<string, never>; data: RecipeRuleRow[] };
  usage_form: { params: { orderId: string; lineId: string }; data: UsageFormData };
  usage_inbox: { params: Record<string, never>; data: UsageInboxData };
  unit_list: { params: Record<string, never>; data: UnitListData };
  alert_inbox: { params: Record<string, never>; data: AlertInboxData };
  request_inbox: { params: Record<string, never>; data: RequestInboxData };
  payments_ledger: { params: { day?: string }; data: PaymentsLedgerData };
  day_report: { params: { day?: string }; data: DayReportData };
  announcements: { params: Record<string, never>; data: AnnouncementsData };
  count_session: { params: Record<string, never>; data: CountSessionData };
  batch_log: { params: Record<string, never>; data: BatchLogData };
  reports: { params: ReportsParams; data: ReportsData };
  receipt: { params: { orderId: string }; data: ReceiptData };
  notification_setup: { params: Record<string, never>; data: NotificationSetupData };
  notification_log: { params: Record<string, never>; data: NotificationLogRow[] };
  alert_settings: { params: Record<string, never>; data: AlertSettingsData };
  stock_forecast: { params: { ingredientId?: string; horizonDays?: number }; data: StockForecastData };
  audit_view: { params: Record<string, never>; data: AuditRow[] };
  panel_map: { params: Record<string, never>; data: PanelMapData };
}
export type FeedName = keyof FeedMap;

export interface CircuitStat {
  handled: number;
  denied: number;
  invalid: number;
  errors: number;
  lastActivityAt: string | null;
}

export interface FeedCtx {
  store: Store;
  config: PanelConfig;
  clock: Clock;
  terminals: Terminals;
  session: Session | null;
  device: Device | null;
  stats: () => Map<CircuitName, CircuitStat>;
}

export interface FeedDef<K extends FeedName> {
  roles: Role[] | 'public';
  /** Only answer devices that were registered (when the host requires it). */
  device?: 'required';
  build: (ctx: FeedCtx, params: FeedMap[K]['params']) => Promise<FeedMap[K]['data']>;
}
export type FeedRegistry = { [K in FeedName]: FeedDef<K> };

/* ---------- Helpers ---------- */

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  mobile_money: 'Mobile money',
};

const needsPrice = (status: string) => status === 'draft' || status === 'awaiting_quote';
const OPEN_LINE_STATUSES = ['new', 'ready', 'out_for_delivery'];

const QUOTE_LABEL: Record<QuoteStatus, string> = {
  sent: 'Sent to the owner',
  seen: 'Seen by the owner',
  quoted: 'Priced',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

const cakeDetails = (spec: CakeSpec): CakeDetails => ({
  servings: spec.servings,
  sizeNote: spec.sizeNote,
  flavor: spec.flavor,
  filling: spec.filling,
  layers: spec.layers,
  dietary: spec.dietary,
  decorationNotes: spec.decorationNotes,
  inscription: spec.inscription,
  allergyNotes: spec.allergyNotes,
  photoIds: spec.photoIds,
});

const quoteState = (q: Quote, fmt: (n: number) => string): QuoteState => ({
  quoteId: q.id,
  status: q.status,
  statusLabel: QUOTE_LABEL[q.status],
  priceLabel: q.price !== undefined ? fmt(q.price) : undefined,
  note: q.note,
  answer: q.answer,
  requestedByName: q.requestedByName,
  requestedAt: q.requestedAt,
  resolvedAt: q.resolvedAt,
});

const SCALING_LABEL: Record<RuleScaling, string> = {
  per_serving: 'per serving',
  per_layer_gap: 'per serving for each gap between layers',
  fixed: 'for every cake',
};

const REPORT_LABEL: Record<UsageReport['status'], string> = { reported: 'Waiting for Inventory', confirmed: 'Confirmed', sent_back: 'Sent back' };

function bestRange(ranges: Ingredient['ranges'], qty: number | null): string | null {
  if (qty === null || ranges.length === 0) return null;
  const inside = ranges.find((r) => qty >= r.min && qty <= r.max);
  if (inside) return inside.id;
  return [...ranges].sort((a, b) => Math.abs((a.min + a.max) / 2 - qty) - Math.abs((b.min + b.max) / 2 - qty))[0]!.id;
}

const rangeText = (min: number, max: number, unit: Ingredient['unit']) => (min === max ? formatQty(min, unit) : `${formatQty(min, unit)} to ${formatQty(max, unit)}`);
const rangeRows = (i: Ingredient): RangeRow[] => i.ranges.map((r) => ({ rangeId: r.id, label: r.label, min: r.min, max: r.max, text: rangeText(r.min, r.max, i.unit) }));

function usageStateFor(lineStatus: string, hasSuggestion: boolean, reports: UsageReport[]): BakeRow['usage'] {
  const latest = [...reports].sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))[0];
  const started = lineStatus !== 'new';
  const open = reports.some((r) => r.status === 'reported');
  return {
    state: latest ? latest.status : hasSuggestion ? 'suggested' : 'not_started',
    canReport: started && !open,
  };
}

function dueInfo(deliveryDate: string | undefined, today: string): { label: string; urgency: Urgency } {
  if (!deliveryDate) return { label: 'No date set', urgency: 'undated' };
  const d = daysBetween(today, deliveryDate);
  if (d < 0) return { label: d === -1 ? '1 day late' : `${-d} days late`, urgency: 'late' };
  if (d === 0) return { label: 'Today', urgency: 'today' };
  if (d === 1) return { label: 'Tomorrow', urgency: 'soon' };
  return { label: `In ${d} days`, urgency: d <= 2 ? 'soon' : 'later' };
}

function listItem(
  order: Order,
  lines: OrderLine[],
  payments: Payment[],
  refunds: Refund[],
  fmt: (n: number) => string,
): OrderListItem {
  const status = deriveOrderStatus(lines);
  const money = moneySummary(lines, payments, refunds);
  return {
    orderId: order.id,
    number: order.number,
    customerName: order.customerName,
    fulfilment: order.fulfilment,
    deliveryDate: order.deliveryDate,
    status,
    statusLabel: STATUS_LABEL[status],
    statusTone: STATUS_TONE[status],
    paymentStatus: money.status,
    paymentLabel: PAYMENT_LABEL[money.status],
    paymentTone: PAYMENT_TONE[money.status],
    totalLabel: fmt(money.total),
    balanceLabel: fmt(money.balance),
    itemCount: lines.filter((l) => l.status !== 'cancelled').reduce((s, l) => s + l.qty, 0),
    needsQuote: lines.some((l) => l.status === 'awaiting_quote'),
    quotePending: money.quotePending,
    hasCustomCake: lines.some((l) => isCustom(l) && l.status !== 'cancelled'),
    instant: !!order.instant,
  };
}

/* ---------- Feeds ---------- */

const NAV: Record<Role, NavItem[]> = {
  owner: [
    { id: 'sell', label: 'Sell' },
    { id: 'orders', label: 'Orders' },
    { id: 'quotes', label: 'Quotes' },
    { id: 'bake_queue', label: 'Cakes to bake' },
    { id: 'alerts', label: 'Alerts' },
    { id: 'requests', label: 'Requests' },
    { id: 'usage_inbox', label: 'Usage to confirm' },
    { id: 'ingredients', label: 'Ingredients' },
    { id: 'forecast', label: 'Stock forecast' },
    { id: 'recipes', label: 'Recipes' },
    { id: 'catalogue', label: 'Catalogue' },
    { id: 'staff', label: 'Staff' },
    { id: 'settings', label: 'Settings' },
    { id: 'audit', label: 'Activity' },
  ],
  cashier: [
    { id: 'sell', label: 'Sell' },
    { id: 'orders', label: 'Orders' },
    { id: 'quotes', label: 'Quotes' },
    { id: 'alerts', label: 'Alerts' },
    { id: 'requests', label: 'Requests' },
    { id: 'catalogue', label: 'Catalogue' },
  ],
  baker: [
    { id: 'bake_queue', label: 'Cakes to bake' },
    { id: 'alerts', label: 'Alerts' },
    { id: 'requests', label: 'Requests' },
    { id: 'recipes', label: 'Recipes' },
    { id: 'ingredients', label: 'Ingredients' },
    { id: 'forecast', label: 'Stock forecast' },
    { id: 'catalogue', label: 'Catalogue' },
  ],
  inventory: [
    { id: 'usage_inbox', label: 'Usage to confirm' },
    { id: 'alerts', label: 'Alerts' },
    { id: 'requests', label: 'Requests' },
    { id: 'ingredients', label: 'Ingredients' },
    { id: 'forecast', label: 'Stock forecast' },
    { id: 'catalogue', label: 'Catalogue' },
  ],
  it: [
    { id: 'requests', label: 'Requests' },
    { id: 'panel_map', label: 'Panel map' },
  ],
};

export const feeds: FeedRegistry = {
  ...moneyFeeds,
  ...dayCloseFeeds,
  ...announcementFeeds,
  ...countFeeds,
  ...batchFeeds,
  ...reportFeeds,
  me: {
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    build: async ({ session }) => session!,
  },

  navigation: {
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    build: async ({ store, session, clock }) => {
      const items = NAV[session!.role];
      const nowIso = clock.now().toISOString();
      const unseen = items.some((i) => i.id === 'alerts')
        ? (await store.find<Alert>('alerts', { where: { status: 'open' } })).filter(
            (a) => canSeeAlert(a, session!.role) && !a.seen[session!.userId] && !((a.snoozed[session!.userId] ?? '') > nowIso),
          ).length
        : 0;
      const waiting = (await store.find<StaffRequest>('staffRequests', { where: { status: ['sent', 'seen', 'acknowledged', 'done'] } })).filter((r) => needsPerson(r, session!)).length;
      return items.map((i) => (i.id === 'alerts' && unseen > 0 ? { ...i, badge: unseen } : i.id === 'requests' && waiting > 0 ? { ...i, badge: waiting } : i));
    },
  },

  staff_signin: {
    roles: 'public',
    device: 'required',
    build: async ({ store }) =>
      (await store.list<Staff>('staff'))
        .filter((s) => s.active)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({ id: s.id, name: s.name, role: s.role })),
  },

  device_list: {
    roles: ['owner', 'it'],
    build: async ({ store, clock, config, device }) => {
      const nowMs = clock.now().getTime();
      const [devices, codes] = await Promise.all([store.list<Device>('devices'), store.list<PairingCode>('pairingCodes')]);
      return {
        required: config.requireDevice,
        devices: devices
          .filter((d) => !d.revokedAt)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, createdByName: d.createdByName, lastSeenAt: d.lastSeenAt ?? null, isThis: device?.id === d.id })),
        revoked: devices
          .filter((d) => d.revokedAt)
          .sort((a, b) => b.revokedAt!.localeCompare(a.revokedAt!))
          .slice(0, 20)
          .map((d) => ({ id: d.id, name: d.name, revokedAt: d.revokedAt!, revokedByName: d.revokedByName ?? '' })),
        openCodes: codes
          .filter((c) => !c.usedAt && !c.cancelledAt && Date.parse(c.expiresAt) > nowMs)
          .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
          .map((c) => ({ id: c.id, name: c.name, createdByName: c.createdByName, expiresAt: c.expiresAt })),
      };
    },
  },

  staff_list: {
    roles: ['owner'],
    build: async ({ store, clock }) => {
      const [staff, states] = await Promise.all([store.list<Staff>('staff'), store.list<LoginState>('loginState')]);
      const nowMs = clock.now().getTime();
      const locked = new Set(states.filter((s) => s.lockedUntil && Date.parse(s.lockedUntil) > nowMs).map((s) => s.id));
      return staff
        .filter((s) => !s.removedAt)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({
          id: s.id,
          name: s.name,
          role: s.role,
          active: s.active,
          locked: locked.has(s.id),
          contact: { phone: s.contact?.phone ?? null, sms: s.contact?.sms ?? 'off', whatsapp: s.contact?.whatsapp ?? 'off' },
        }));
    },
  },

  catalogue_grid: {
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    build: async ({ store, config, session }, params) => {
      const can = {
        price: session?.role === 'owner',
        stock: session?.role === 'owner' || session?.role === 'inventory',
        manage: session?.role === 'owner',
      };
      const [products, groups, values, combos, lines] = await Promise.all([
        store.list<Product>('products'),
        store.list<OptionGroup>('optionGroups'),
        store.list<OptionValue>('optionValues'),
        store.list<Combination>('combinations'),
        store.find<OrderLine>('orderLines', { where: { status: OPEN_LINE_STATUSES } }),
      ]);
      const committed = new Map<string, number>();
      for (const l of lines) {
        if (l.type !== 'catalogue' || !l.combinationId) continue; // custom cakes do not use counter stock
        committed.set(l.combinationId, (committed.get(l.combinationId) ?? 0) + l.qty);
      }
      const groupById = new Map(groups.map((g) => [g.id, g]));
      const valueById = new Map(values.map((v) => [v.id, v]));

      return products
        .filter((p) => (params.includeArchived || p.status === 'active') && (!p.hidden || session?.role === 'owner'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p): CatalogueGridItem => {
          const chosen = values.filter((v) => p.selectedValueIds.includes(v.id));
          const productGroups = groups
            .filter((g) => chosen.some((v) => v.groupId === g.id))
            .sort((a, b) => a.order - b.order)
            .map((g) => ({
              groupId: g.id,
              name: g.name,
              values: chosen
                .filter((v) => v.groupId === g.id)
                .sort((a, b) => a.order - b.order)
                .map((v) => ({ valueId: v.id, label: v.label })),
            }));

          const sortKey = (c: Combination) =>
            c.valueIds
              .map((id) => valueById.get(id))
              .filter((v): v is OptionValue => !!v)
              .sort((a, b) => (groupById.get(a.groupId)?.order ?? 0) - (groupById.get(b.groupId)?.order ?? 0));

          const combinations = combos
            .filter((c) => c.productId === p.id)
            .map((c): CatalogueCombination => {
              const ordered = sortKey(c);
              const onHand = c.stockCount;
              const open = committed.get(c.id) ?? 0;
              let reason: string | null = null;
              if (p.status === 'archived') reason = 'Archived';
              else if (p.hidden) reason = 'Hidden';
              else if (!p.availableToday) reason = 'Off the menu today';
              else if (c.status !== 'available') reason = 'Not available';
              else if (c.price === null) reason = 'No price yet';
              return {
                combinationId: c.id,
                label: ordered.map((v) => v.label).join(', '),
                valueIds: c.valueIds,
                price: c.price,
                priceLabel: c.price === null ? null : config.formatMoney(c.price),
                onHand,
                committed: open,
                sellable: reason === null,
                reason,
                markedUnavailable: c.status !== 'available',
                warning: open > onHand ? `Open orders need ${open} but ${onHand} on hand` : null,
              };
            })
            .sort((a, b) => {
              const ka = sortKey(combos.find((c) => c.id === a.combinationId)!).map((v) => v.order);
              const kb = sortKey(combos.find((c) => c.id === b.combinationId)!).map((v) => v.order);
              for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
                const d = (ka[i] ?? 0) - (kb[i] ?? 0);
                if (d !== 0) return d;
              }
              return 0;
            });

          const prices = combinations.filter((c) => c.sellable && c.price !== null).map((c) => c.price as number);
          return {
            productId: p.id,
            name: p.name,
            category: p.category,
            description: p.description,
            archived: p.status === 'archived',
            hidden: !!p.hidden,
            availableToday: p.availableToday,
            allergens: p.allergens,
            groups: productGroups,
            combinations,
            priceFromLabel: prices.length ? config.formatMoney(Math.min(...prices)) : null,
            sellable: prices.length > 0,
            can,
          };
        });
    },
  },

  order_list: {
    roles: ['owner', 'cashier'],
    build: async ({ store, config }) => {
      const orders = await store.find<Order>('orders', { orderBy: { field: 'createdAt', dir: 'desc' }, limit: 200 });
      const ids = orders.map((o) => o.id);
      const [lines, payments, refunds] = ids.length
        ? await Promise.all([
            store.find<OrderLine>('orderLines', { where: { orderId: ids } }),
            store.find<Payment>('payments', { where: { orderId: ids } }),
            store.find<Refund>('refunds', { where: { orderId: ids } }),
          ])
        : [[], [], []];
      return orders.map((o) =>
        listItem(
          o,
          lines.filter((l) => l.orderId === o.id),
          payments.filter((p) => p.orderId === o.id),
          refunds.filter((r) => r.orderId === o.id),
          config.formatMoney,
        ),
      );
    },
  },

  order_card: {
    roles: ['owner', 'cashier'],
    build: async (ctx, params) => {
      const { config, session } = ctx;
      const fmt = config.formatMoney;
      const { order, lines, payments, refunds } = await loadOrderBundle(ctx, params.orderId);
      const role = session!.role;
      const base = listItem(order, lines, payments, refunds, fmt);
      const money = moneySummary(lines, payments, refunds);
      const cancelledOrder = base.status === 'cancelled';
      const finished = base.status === 'completed' || cancelledOrder;

      const settings = await loadSettings(ctx.store);
      const quotes = await ctx.store.find<Quote>('quotes', { where: { orderId: order.id } });
      const hasPayments = payments.length > 0;
      const cardLines = lines.map((l): OrderCardLine => {
        const cancelled = l.status === 'cancelled';
        const lineStatus = (l.status as OrderStatus) ?? 'new';
        const custom = isCustom(l) && l.custom;
        const q = custom && l.custom?.quoteId ? quotes.find((x) => x.id === l.custom!.quoteId) : undefined;
        const front = role === 'owner' || role === 'cashier';
        let blocked: string | null = null;
        if (custom && l.status === 'draft') {
          if (!order.deliveryDate) blocked = 'Set the delivery date first. The owner needs it to price the cake.';
          else if (order.deliveryDate < todayLocal(ctx.clock.now())) blocked = 'The delivery date has passed. Choose a new one first.';
        }
        return {
          lineId: l.id,
          title: l.snapshot.productName,
          options: Object.entries(l.snapshot.options).length && custom ? Object.entries(l.snapshot.options).map(([k, v]) => `${k}: ${v}`).join(', ') : Object.values(l.snapshot.options).join(', '),
          allergens: l.snapshot.allergens,
          qty: l.qty,
          unitPriceLabel: custom && needsPrice(l.status) ? 'Not priced yet' : fmt(l.snapshot.unitPrice),
          totalLabel: custom && needsPrice(l.status) ? 'Not priced yet' : fmt(lineTotal(l)),
          status: l.status,
          statusLabel: STATUS_LABEL[lineStatus],
          statusTone: STATUS_TONE[lineStatus],
          cancelled,
          actions: nextActions(order, l, role, settings),
          canRemove: canRemoveLine(l, role, hasPayments),
          kind: custom ? 'custom' : 'catalogue',
          cake: custom ? cakeDetails(l.custom!.spec) : undefined,
          quote: q ? quoteState(q, fmt) : undefined,
          canEdit: !!custom && front && (l.status === 'draft' || l.status === 'new'),
          canRequestQuote: !!custom && front && l.status === 'draft' && blocked === null,
          quoteBlockedReason: blocked,
          canWithdrawQuote: !!custom && front && l.status === 'awaiting_quote',
          maxPhotos: MAX_PHOTOS_PER_CAKE,
        };
      });

      const warnings: string[] = [];
      if (money.balance > 0 && base.status !== 'new' && base.status !== 'empty' && !cancelledOrder)
        warnings.push(`${fmt(money.balance)} is still unpaid.`);
      if (money.overpaid > 0) warnings.push(`${fmt(money.overpaid)} has been paid above the current total.`);
      if (money.quotePending) warnings.push('A custom cake has no price yet, so the total is not final.');

      return {
        ...base,
        source: order.source,
        deliveryAddress: order.deliveryAddress,
        customerPhone: order.customerPhone,
        lines: cardLines,
        paidLabel: fmt(money.paid),
        refundedLabel: money.refunded > 0 ? fmt(money.refunded) : null,
        balance: money.balance,
        total: money.total,
        canRecordPayment: (role === 'owner' || role === 'cashier') && !cancelledOrder && !money.quotePending && money.balance > 0,
        canCancel:
          !finished &&
          (role === 'owner' ||
            (role === 'cashier' &&
              money.net <= 0 &&
              !lines.some((l) => isCustom(l) && ['in_production', 'decorating', 'ready', 'out_for_delivery'].includes(l.status)))),
        canEditDelivery: !finished,
        canRefund: role === 'owner' && money.net > 0,
        refundableLabel: fmt(money.net),
        payments: payments
          .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
          .map((p) => ({
            id: p.id,
            methodLabel: METHOD_LABEL[p.method] ?? p.method,
            amountLabel: fmt(p.amount),
            at: p.receivedAt,
            reference: p.reference,
          })),
        warnings,
      };
    },
  },

  quote_inbox: {
    roles: ['owner', 'cashier'],
    build: async (ctx) => {
      const { store, config, session } = ctx;
      const fmt = config.formatMoney;
      const quotes = await store.list<Quote>('quotes');
      const orderIds = [...new Set(quotes.map((q) => q.orderId))];
      const [orders, lines] = orderIds.length
        ? await Promise.all([
            store.find<Order>('orders', { where: { id: orderIds } }),
            store.find<OrderLine>('orderLines', { where: { orderId: orderIds } }),
          ])
        : [[], []];
      const toRow = (q: Quote): QuoteRow | null => {
        const order = orders.find((o) => o.id === q.orderId);
        const line = lines.find((l) => l.id === q.lineId);
        if (!order || !line?.custom) return null;
        return {
          quoteId: q.id,
          orderId: order.id,
          orderNumber: order.number,
          lineId: line.id,
          customerName: order.customerName,
          deliveryDate: order.deliveryDate,
          fulfilment: order.fulfilment,
          status: q.status,
          statusLabel: QUOTE_LABEL[q.status],
          requestedByName: q.requestedByName,
          requestedAt: q.requestedAt,
          note: q.note,
          priceLabel: q.price !== undefined ? fmt(q.price) : undefined,
          answer: q.answer,
          resolvedAt: q.resolvedAt,
          cake: cakeDetails(line.custom.spec),
        };
      };
      const rows = quotes.map((q) => ({ q, row: toRow(q) })).filter((x): x is { q: Quote; row: QuoteRow } => x.row !== null);
      const open = rows
        .filter((x) => x.q.status === 'sent' || x.q.status === 'seen')
        .sort((a, b) => (a.row.deliveryDate ?? '9999').localeCompare(b.row.deliveryDate ?? '9999') || a.q.requestedAt.localeCompare(b.q.requestedAt))
        .map((x) => x.row);
      const recent = rows
        .filter((x) => x.q.status !== 'sent' && x.q.status !== 'seen')
        .sort((a, b) => (b.q.resolvedAt ?? '').localeCompare(a.q.resolvedAt ?? ''))
        .slice(0, 20)
        .map((x) => x.row);
      return { open, recent, can: { provide: session?.role === 'owner', withdraw: true } };
    },
  },

  bake_queue: {
    roles: ['owner', 'baker'],
    build: async (ctx) => {
      const { store, session, clock } = ctx;
      const settings = await loadSettings(store);
      const lines = (await store.find<OrderLine>('orderLines', { where: { status: ['new', 'in_production', 'decorating', 'ready'] } })).filter(isCustom);
      const orderIds = [...new Set(lines.map((l) => l.orderId))];
      const orders = orderIds.length ? await store.find<Order>('orders', { where: { id: orderIds } }) : [];
      const today = todayLocal(clock.now());
      const lineIds = lines.map((l) => l.id);
      const [suggestions, reports] = lineIds.length
        ? await Promise.all([
            store.find<UsageSuggestion>('usageSuggestions', { where: { lineId: lineIds } }),
            store.find<UsageReport>('usageReports', { where: { lineId: lineIds } }),
          ])
        : [[], []];
      const rank: Record<string, number> = { late: 0, today: 1, soon: 2, later: 3, undated: 4 };
      const rows = lines
        .map((l): BakeRow | null => {
          const order = orders.find((o) => o.id === l.orderId);
          if (!order || !l.custom) return null;
          const due = dueInfo(order.deliveryDate, today);
          const status = l.status as OrderStatus;
          return {
            lineId: l.id,
            orderId: order.id,
            orderNumber: order.number,
            customerName: order.customerName,
            deliveryDate: order.deliveryDate,
            fulfilment: order.fulfilment,
            dueLabel: due.label,
            urgency: due.urgency,
            status: l.status,
            statusLabel: STATUS_LABEL[status],
            statusTone: STATUS_TONE[status],
            actions: nextActions(order, l, session!.role, settings),
            cake: cakeDetails(l.custom.spec),
            usage: usageStateFor(
              l.status,
              suggestions.some((x) => x.lineId === l.id),
              reports.filter((x) => x.lineId === l.id),
            ),
          };
        })
        .filter((r): r is BakeRow => r !== null)
        .sort((a, b) => (a.deliveryDate ?? '9999').localeCompare(b.deliveryDate ?? '9999') || rank[a.urgency]! - rank[b.urgency]!);
      const open = rows.filter((r) => r.status !== 'ready');
      return {
        rows,
        counts: {
          late: open.filter((r) => r.urgency === 'late').length,
          today: open.filter((r) => r.urgency === 'today').length,
          toStart: rows.filter((r) => r.status === 'new').length,
          inProduction: rows.filter((r) => r.status === 'in_production' || r.status === 'decorating').length,
          ready: rows.filter((r) => r.status === 'ready').length,
        },
        decoratingStage: settings.decoratingStage,
      };
    },
  },

  shop_settings: {
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    build: async ({ store, session, config }) => {
      const s = await loadSettings(store);
      return {
        decoratingStage: s.decoratingStage,
        shopName: s.shopName,
        shopAddress: s.shopAddress ?? null,
        shopPhone: s.shopPhone ?? null,
        receiptFooter: s.receiptFooter ?? null,
        currencyLabel: config.currencyLabel,
        paymentMethods: ALL_PAYMENT_METHODS.filter((m) => s.paymentMethods.includes(m)).map((m) => ({ key: m, label: METHOD_LABEL[m] ?? m })),
        allPaymentMethods: ALL_PAYMENT_METHODS.map((m) => ({ key: m, label: METHOD_LABEL[m] ?? m, on: s.paymentMethods.includes(m) })),
        lowStockUnits: s.lowStockUnits,
        bigDifferencePercent: s.bigDifferencePercent,
        refundCooldownMinutes: s.refundCooldownMinutes,
        offlineEnabled: s.offlineEnabled,
        offlinePassHours: s.offlinePassHours,
        offlineMaxSales: s.offlineMaxSales,
        offlineMaxTotal: s.offlineMaxTotal,
        dayCloseBy: s.dayCloseBy,
        can: { edit: session?.role === 'owner' },
      };
    },
  },

  offline_review: {
    roles: ['owner'],
    build: async ({ store, clock }) => {
      const nowMs = clock.now().getTime();
      const all = await store.list<HeldAction>('heldActions');
      const held: HeldSaleRow[] = [];
      for (const h of all.filter((x) => x.status === 'held').sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
        const sale = (h.payload ?? {}) as { items?: Array<{ combinationId?: string; qty?: number }>; method?: string; expectedTotal?: number };
        const items: string[] = [];
        const priced: Array<{ combinationId: string; qty: number }> = [];
        for (const it of Array.isArray(sale.items) ? sale.items : []) {
          const combo = it.combinationId ? await store.get<Combination>('combinations', it.combinationId) : undefined;
          const product = combo ? await store.get<Product>('products', combo.productId) : undefined;
          items.push(`${it.qty ?? '?'} × ${product?.name ?? 'an item that is no longer in the catalogue'}`);
          if (it.combinationId && typeof it.qty === 'number') priced.push({ combinationId: it.combinationId, qty: it.qty });
        }
        held.push({
          id: h.id,
          userName: h.userName,
          deviceName: h.deviceName,
          queuedAt: h.queuedAt,
          receivedAt: h.receivedAt,
          reasons: h.reasons,
          items,
          method: typeof sale.method === 'string' ? (METHOD_LABEL[sale.method as PaymentMethod] ?? sale.method) : null,
          expectedTotal: typeof sale.expectedTotal === 'number' ? sale.expectedTotal : null,
          totalNow: priced.length ? await quickSaleTotal({ store }, priced) : null,
          canApprove: h.type === 'orders/quick_sale',
        });
      }
      const recent = all
        .filter((x) => x.status !== 'held')
        .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))
        .slice(0, 20)
        .map((h) => ({ id: h.id, userName: h.userName, deviceName: h.deviceName, queuedAt: h.queuedAt, status: h.status as 'approved' | 'dismissed', resolvedByName: h.resolvedByName ?? '', resolvedAt: h.resolvedAt ?? '', note: h.note ?? null, orderId: h.orderId ?? null }));
      const passes = (await store.list<OfflinePass>('offlinePasses'))
        .filter((p) => !p.closedAt && Date.parse(p.expiresAt) > nowMs)
        .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
        .map((p) => ({ id: p.id, userName: p.userName, deviceName: p.deviceName, issuedAt: p.issuedAt, expiresAt: p.expiresAt, sales: p.sales, total: p.total, maxSales: p.maxSales, maxTotal: p.maxTotal }));
      return { held, recent, passes, can: { review: true } };
    },
  },

  ingredient_list: {
    roles: ['owner', 'inventory', 'baker'],
    build: async ({ store, session, clock }, params) => {
      const [ingredients, movements, reports] = await Promise.all([
        store.list<Ingredient>('ingredients'),
        store.find<IngredientMovement>('ingredientMovements', { where: { reason: 'usage' } }),
        store.find<UsageReport>('usageReports', { where: { status: 'reported' } }),
      ]);
      const canEdit = session?.role === 'owner' || session?.role === 'inventory';
      return ingredients
        .filter((i) => params.includeInactive || i.active)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((i): IngredientRow => {
          const waiting = reports.flatMap((r) => r.items.filter((x) => x.ingredientId === i.id));
          const dl = daysLeftInfo(i.onHand, movements.filter((m) => m.ingredientId === i.id), clock.now());
          return {
            ingredientId: i.id,
            name: i.name,
            unit: i.unit,
            onHand: i.onHand,
            onHandText: formatQty(i.onHand, i.unit),
            reorderLevel: i.reorderLevel ?? null,
            reorderLevelText: i.reorderLevel === undefined ? null : formatQty(i.reorderLevel, i.unit),
            low: i.reorderLevel !== undefined && i.onHand <= i.reorderLevel,
            allergens: i.allergens,
            ranges: rangeRows(i),
            active: i.active,
            kind: i.kind ?? 'ingredient',
            countedAt: i.countedAt ?? null,
            pending: waiting.length ? { min: waiting.reduce((s, x) => s + x.min, 0), max: waiting.reduce((s, x) => s + x.max, 0), text: rangeText(waiting.reduce((s, x) => s + x.min, 0), waiting.reduce((s, x) => s + x.max, 0), i.unit), reports: waiting.length } : null,
            daysLeft: dl.days === null ? null : Math.round(dl.days * 10) / 10,
            daysLeftLabel: dl.label,
            can: { edit: canEdit },
          };
        });
    },
  },

  recipe_rules: {
    roles: ['owner', 'baker', 'inventory'],
    build: async ({ store }) => {
      const [rules, ingredients] = await Promise.all([store.list<RecipeRule>('recipeRules'), store.list<Ingredient>('ingredients')]);
      return rules
        .map((r): RecipeRuleRow | null => {
          const ing = ingredients.find((i) => i.id === r.ingredientId);
          if (!ing) return null;
          let subject = r.flavors.length ? `${r.flavors.join(' or ')} cakes` : 'any cake';
          if (r.fillings.length) subject += ` with ${r.fillings.join(' or ')} filling`;
          if (r.needsDietary.length) subject += ` that are ${r.needsDietary.join(' and ')}`;
          if (r.excludedByDietary.length) subject += ` but not ${r.excludedByDietary.join(' or ')}`;
          return {
            ruleId: r.id,
            ingredientId: ing.id,
            ingredientName: ing.name,
            unit: ing.unit,
            quantity: r.quantity,
            quantityText: formatQty(r.quantity, ing.unit),
            scaling: r.scaling,
            scalingLabel: SCALING_LABEL[r.scaling],
            flavors: r.flavors,
            fillings: r.fillings,
            needsDietary: r.needsDietary,
            excludedByDietary: r.excludedByDietary,
            note: r.note,
            summary: `${formatQty(r.quantity, ing.unit)} of ${ing.name} ${SCALING_LABEL[r.scaling]}, for ${subject}`,
          };
        })
        .filter((r): r is RecipeRuleRow => r !== null)
        .sort((a, b) => a.ingredientName.localeCompare(b.ingredientName) || a.summary.localeCompare(b.summary));
    },
  },

  usage_form: {
    roles: ['owner', 'baker'],
    build: async (ctx, params) => {
      const { store } = ctx;
      const order = await store.get<Order>('orders', params.orderId);
      const line = await store.get<OrderLine>('orderLines', params.lineId);
      if (!order || !line || line.orderId !== order.id || !line.custom) throw new DomainError('invalid', ['That cake is not on the order.']);
      const [suggestion, ingredients, reports] = await Promise.all([
        store.get<UsageSuggestion>('usageSuggestions', line.id),
        store.list<Ingredient>('ingredients'),
        store.find<UsageReport>('usageReports', { where: { lineId: line.id } }),
      ]);
      const active = ingredients.filter((i) => i.active);
      const suggestedIds = new Set((suggestion?.lines ?? []).map((l) => l.ingredientId));
      const item = (i: Ingredient, qty: number | null): UsageFormItem => ({
        ingredientId: i.id,
        name: i.name,
        unit: i.unit,
        suggestedQty: qty,
        suggestedText: qty === null ? null : formatQty(qty, i.unit),
        ranges: rangeRows(i),
        suggestedRangeId: bestRange(i.ranges, qty),
      });
      const latest = [...reports].sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))[0];
      const open = reports.some((r) => r.status === 'reported');
      const state = usageStateFor(line.status, !!suggestion, reports);
      return {
        lineId: line.id,
        orderId: order.id,
        orderNumber: order.number,
        cake: cakeDetails(line.custom.spec),
        suggested: (suggestion?.lines ?? [])
          .map((l) => ({ l, ing: active.find((i) => i.id === l.ingredientId) }))
          .filter((x): x is { l: (typeof x)['l']; ing: Ingredient } => !!x.ing)
          .map((x) => item(x.ing, x.l.qty)),
        extras: active.filter((i) => !suggestedIds.has(i.id)).sort((a, b) => a.name.localeCompare(b.name)).map((i) => item(i, null)),
        report: latest ? { reportId: latest.id, status: latest.status, reportedAt: latest.reportedAt, sentBackReason: latest.sentBackReason } : null,
        canReport: state.canReport,
        blockedReason: state.canReport ? null : open ? 'Already waiting for Inventory to confirm.' : 'Start baking this cake first.',
      };
    },
  },

  alert_inbox: {
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    build: async ({ store, session, clock }) => {
      const me = session!;
      const nowIso = clock.now().toISOString();
      const mine = (await store.list<Alert>('alerts')).filter((a) => canSeeAlert(a, me.role));
      const row = (a: Alert): AlertRow => ({
        alertId: a.id,
        kind: a.kind,
        kindLabel: ALERT_KIND_LABEL[a.kind],
        severity: a.severity,
        title: a.title,
        body: a.body,
        screen: a.screen,
        targetId: a.targetId,
        createdAt: a.createdAt,
        seen: !!a.seen[me.userId],
        acknowledgedByName: a.acknowledgedBy?.name ?? null,
        acknowledgedAt: a.acknowledgedBy?.at,
        snoozedUntil: a.snoozed[me.userId] && a.snoozed[me.userId]! > nowIso ? a.snoozed[me.userId] : undefined,
        resolvedAt: a.resolvedAt,
        to: a.to,
        can: { acknowledge: a.status === 'open' && !a.acknowledgedBy, snooze: a.status === 'open' },
      });
      const open = mine.filter((a) => a.status === 'open').map(row);
      const rank = (r: AlertRow) => (r.severity === 'critical' ? 0 : 1);
      const live = open.filter((r) => !r.snoozedUntil).sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
      return {
        open: live,
        snoozed: open.filter((r) => r.snoozedUntil),
        recent: mine
          .filter((a) => a.status === 'resolved')
          .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))
          .slice(0, 20)
          .map(row),
        unseen: live.filter((r) => !r.seen).length,
        critical: live.filter((r) => r.severity === 'critical').length,
      };
    },
  },

  request_inbox: {
    roles: ['owner', 'cashier', 'baker', 'inventory', 'it'],
    build: async ({ store, session, clock }) => {
      const me = session!;
      const settings = await loadAlertSettings(store);
      const nowIso = clock.now().toISOString();
      const all = (await store.list<StaffRequest>('staffRequests')).filter((r) => canSeeRequest(r, me));
      const row = (r: StaffRequest): RequestRow => {
        const question = !!r.choices;
        const steps = question ? ['Sent', 'Seen', 'Answered'] : ['Sent', 'Seen', 'Acknowledged', 'Done', 'Confirmed'];
        const index = { sent: 0, seen: 1, acknowledged: 2, done: 3, confirmed: question ? 2 : 4, withdrawn: 0 }[r.status];
        const waitMs = (r.urgent ? settings.urgentRequestMinutes * 60_000 : 2 * settings.requestWaitHours * 3_600_000) + 0;
        const unanswered = ['sent', 'seen'].includes(r.status) && r.audience !== 'owner';
        const at = new Date(Date.parse(r.createdAt) + waitMs).toISOString();
        const actions = requestActions(r, me);
        return {
          requestId: r.id,
          title: r.title,
          body: r.body,
          category: r.category === 'Other' && r.tag ? r.tag : r.category,
          urgent: r.urgent,
          link: r.link,
          orderId: r.orderId,
          from: { userId: r.fromId, name: r.fromName, role: r.fromRole },
          to: { label: r.toName ?? ROLE_LABEL[r.audience], role: r.audience, userId: r.toUserId },
          status: r.status,
          statusLabel: { sent: 'Sent', seen: 'Seen', acknowledged: 'Taken', done: 'Done, waiting for the sender', confirmed: question ? `Answered: ${r.outcome}` : 'Closed', withdrawn: 'Withdrawn' }[r.status],
          steps,
          step: index,
          seenBy: Object.values(r.seenBy).map((s) => s.name),
          takenByName: r.takenBy?.name ?? null,
          choices: r.choices,
          outcome: r.outcome,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          escalatesAt: unanswered ? at : undefined,
          escalated: unanswered && at <= nowIso,
          mine: r.fromId === me.userId,
          forMe: isTarget(r, me),
          needsYou: needsPerson(r, me),
          actions,
          final: isFinal(r),
          timeline: r.timeline,
        };
      };
      const open = all.filter((r) => !isFinal(r)).map(row).sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.createdAt.localeCompare(a.createdAt));
      const closed = all
        .filter(isFinal)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 40)
        .map(row);
      const staff = (await store.list<Staff>('staff')).filter((s) => s.active && s.id !== me.userId).sort((a, b) => a.name.localeCompare(b.name));
      const roles = (Object.keys(ROLE_LABEL) as Role[]).filter((r) => r !== me.role && staff.some((s) => s.role === r));
      return {
        rows: [...open, ...closed],
        counts: { needsYou: open.filter((r) => r.needsYou).length, open: open.length },
        targets: { roles: roles.map((r) => ({ role: r, label: ROLE_LABEL[r] })), people: staff.map((s) => ({ userId: s.id, name: s.name, role: s.role })) },
        categories: [...REQUEST_CATEGORIES],
        can: { send: true },
      };
    },
  },

  notification_setup: {
    roles: ['owner', 'cashier', 'baker', 'inventory'],
    build: async ({ store, session, terminals }) => {
      const me = (await store.get<Staff>('staff', session!.userId))!;
      const subs = (await store.list<PushSubscriptionRecord>('pushSubscriptions')).filter((s) => s.userId === me.id);
      const provided = new Set(terminals.messages?.channels() ?? []);
      const notes: string[] = [];
      if (!terminals.push) notes.push('Phone notifications are not set up on the server yet. Ask IT.');
      if (!provided.has('sms') && !provided.has('whatsapp')) notes.push('Text messages are not set up on the server yet. Ask IT.');
      if (me.contact?.phone && me.contact.sms !== 'off' && me.contact.whatsapp !== 'off') notes.push('You have both SMS and WhatsApp on, so you will get each alert twice.');
      if (terminals.push && subs.length === 0) notes.push('No phone or browser of yours is subscribed yet. Turn on notifications on the device you carry.');
      return {
        me: { userId: me.id, name: me.name, phone: me.contact?.phone ?? null, sms: me.contact?.sms ?? 'off', whatsapp: me.contact?.whatsapp ?? 'off' },
        channels: { push: !!terminals.push, sms: provided.has('sms'), whatsapp: provided.has('whatsapp') },
        push: { publicKey: terminals.push?.publicKey ?? null, endpoints: subs.map((s) => s.endpoint) },
        notes,
      };
    },
  },

  notification_log: {
    roles: ['owner', 'it'],
    build: async ({ store }) => {
      const items = (await store.find<OutboxItem>('outbox', { where: { status: ['pending', 'sent', 'failed'] } }))
        .filter((o) => o.kind === 'notify')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 50);
      const alertIds = items.map((i) => (i.payload as unknown as NotifyPayload).alertId).filter((x): x is string => !!x);
      const alerts = alertIds.length ? await store.find<Alert>('alerts', { where: { id: alertIds } }) : [];
      return items.map((o): NotificationLogRow => {
        const p = o.payload as unknown as NotifyPayload;
        const alert = alerts.find((a) => a.id === p.alertId);
        return {
          itemId: o.id,
          at: o.createdAt,
          title: alert?.title ?? (p.test ? 'Test message' : 'An alert that has since been removed'),
          kind: p.test ? 'test' : 'alert',
          severity: alert?.severity ?? 'test',
          status: o.status as 'pending' | 'sent' | 'failed',
          note: p.note,
          deliveries: (p.deliveries ?? []).map((d) => ({ who: d.userName, channel: d.channel, status: d.status, attempts: d.attempts, error: d.lastError, nextAt: d.nextAt })),
        };
      });
    },
  },

  alert_settings: {
    roles: ['owner'],
    build: async ({ store }) => {
      const s = await loadAlertSettings(store);
      return {
        stockoutDays: s.stockoutDays,
        reorderDays: s.reorderDays,
        usageWaitHours: s.usageWaitHours,
        quoteWaitHours: s.quoteWaitHours,
        dueSoonDays: s.dueSoonDays,
        countDifference: s.countDifference,
        urgentRequestMinutes: s.urgentRequestMinutes,
        requestWaitHours: s.requestWaitHours,
        kinds: ALERT_KINDS.map((kind) => ({ kind, label: ALERT_KIND_LABEL[kind], critical: s.critical[kind] })),
        can: { edit: true },
      };
    },
  },

  stock_forecast: {
    roles: ['owner', 'baker', 'inventory'],
    build: async ({ store, clock }, params) => {
      const s = await loadAlertSettings(store);
      const horizonDays = params.horizonDays ?? 14;
      let rows = await buildForecasts(store, clock.now(), { horizonDays, stockoutDays: s.stockoutDays, reorderDays: s.reorderDays });
      if (params.ingredientId) rows = rows.filter((r) => r.ingredientId === params.ingredientId);
      return {
        rows,
        generatedAt: clock.now().toISOString(),
        horizonDays,
        method:
          'The next few days follow the cakes already booked, using the recipe suggestions corrected by what the chefs actually used. Further out it moves toward the kitchen\'s usual daily use. It never goes below what is booked.',
      };
    },
  },

  unit_list: {
    roles: ['owner', 'baker', 'inventory'],
    build: async () => ({
      baseUnits: [
        { code: BASE_UNIT_FOR.mass, kind: 'mass' as const, label: 'Weight' },
        { code: BASE_UNIT_FOR.volume, kind: 'volume' as const, label: 'Liquid' },
        { code: BASE_UNIT_FOR.count, kind: 'count' as const, label: 'Counted' },
      ],
      units: unitTable(),
    }),
  },

  usage_inbox: {
    // A baker sees only their own reports (to follow what happened to them). Inventory and the owner see all.
    roles: ['owner', 'inventory', 'baker'],
    build: async ({ store, session }) => {
      const [allReports, ingredients] = await Promise.all([store.list<UsageReport>('usageReports'), store.list<Ingredient>('ingredients')]);
      const reports = session?.role === 'baker' ? allReports.filter((r) => r.reportedBy === session.userId) : allReports;
      const orderIds = [...new Set(reports.map((r) => r.orderId))];
      const lineIds = [...new Set(reports.map((r) => r.lineId))];
      const [orders, lines, suggestions] = reports.length
        ? await Promise.all([
            store.find<Order>('orders', { where: { id: orderIds } }),
            store.find<OrderLine>('orderLines', { where: { id: lineIds } }),
            store.find<UsageSuggestion>('usageSuggestions', { where: { lineId: lineIds } }),
          ])
        : [[], [], []];
      const toRow = (r: UsageReport): UsageReportRow | null => {
        const order = orders.find((o) => o.id === r.orderId);
        const line = lines.find((l) => l.id === r.lineId);
        if (!order || !line?.custom) return null;
        const sug = suggestions.find((s) => s.lineId === r.lineId);
        return {
          reportId: r.id,
          orderId: order.id,
          orderNumber: order.number,
          lineId: line.id,
          cake: cakeDetails(line.custom.spec),
          status: r.status,
          statusLabel: REPORT_LABEL[r.status],
          reportedByName: r.reportedByName,
          reportedAt: r.reportedAt,
          note: r.note,
          items: r.items.map((i) => ({
            ingredientId: i.ingredientId,
            name: i.name,
            unit: i.unit,
            rangeLabel: i.rangeLabel,
            min: i.min,
            max: i.max,
            extra: i.extra,
            rangeText: rangeText(i.min, i.max, i.unit),
            suggestedQty: sug?.lines.find((l) => l.ingredientId === i.ingredientId)?.qty ?? null,
            suggestedText: (() => {
              const q = sug?.lines.find((l) => l.ingredientId === i.ingredientId)?.qty;
              return q === undefined ? null : formatQty(q, i.unit);
            })(),
            onHand: ingredients.find((x) => x.id === i.ingredientId)?.onHand ?? 0,
            onHandText: formatQty(ingredients.find((x) => x.id === i.ingredientId)?.onHand ?? 0, i.unit),
            confirmedQty: r.confirmed?.find((c) => c.ingredientId === i.ingredientId)?.qty,
            confirmedText: (() => {
              const q = r.confirmed?.find((c) => c.ingredientId === i.ingredientId)?.qty;
              return q === undefined ? undefined : formatQty(q, i.unit);
            })(),
          })),
          confirmedByName: r.confirmedByName,
          confirmedAt: r.confirmedAt,
          sentBackReason: r.sentBackReason,
        };
      };
      const rows = reports.map((r) => ({ r, row: toRow(r) })).filter((x): x is { r: UsageReport; row: UsageReportRow } => x.row !== null);
      return {
        pending: rows.filter((x) => x.r.status === 'reported').sort((a, b) => a.r.reportedAt.localeCompare(b.r.reportedAt)).map((x) => x.row),
        recent: rows
          .filter((x) => x.r.status !== 'reported')
          .sort((a, b) => (b.r.confirmedAt ?? b.r.reportedAt).localeCompare(a.r.confirmedAt ?? a.r.reportedAt))
          .slice(0, 20)
          .map((x) => x.row),
        can: { confirm: session?.role === 'owner' || session?.role === 'inventory' },
      };
    },
  },

  audit_view: {
    roles: ['owner'],
    build: async ({ store }) =>
      (await store.find<AuditEntry>('audit', { orderBy: { field: 'at', dir: 'desc' }, limit: 200 })).map((a) => ({
        id: a.id,
        at: a.at,
        who: a.actorName ?? 'Not signed in',
        role: a.role,
        intent: a.intent,
        summary: a.summary,
        outcome: a.outcome,
      })),
  },

  panel_map: {
    roles: ['it'],
    build: async ({ store, stats, terminals, clock }) => {
      const [outbox, sessions, backup, system] = await Promise.all([
        store.list<OutboxItem>('outbox'),
        store.list<{ id: string; expiresAt: string }>('sessions'),
        terminals.backup ? terminals.backup.status() : Promise.resolve(null),
        terminals.system ? terminals.system.info() : Promise.resolve([]),
      ]);
      const nowMs = clock.now().getTime();
      const s = stats();
      const live = [...s.entries()].map(([name, st]) => ({ name, status: 'live' as const, ...st }));
      const planned = PLANNED_CIRCUITS.map((name) => ({
        name,
        status: 'planned' as const,
        handled: 0,
        denied: 0,
        invalid: 0,
        errors: 0,
        lastActivityAt: null,
      }));
      const backupState = !terminals.backup
        ? 'not set up yet'
        : backup?.lastError
          ? 'last backup failed'
          : backup?.lastOkAt
            ? 'ok'
            : 'no backup yet';
      return {
        circuits: [...live, ...planned],
        outbox: {
          pending: outbox.filter((o) => o.status === 'pending').length,
          sent: outbox.filter((o) => o.status === 'sent').length,
          failed: outbox.filter((o) => o.status === 'failed').length,
        },
        terminals: [
          { name: 'Storage', state: 'connected' },
          { name: 'Backups', state: backupState },
          {
            name: 'Cloud sync',
            state: terminals.sync ? (terminals.sync.isOnline() ? 'online' : 'offline') : 'not set up yet',
          },
          { name: 'WhatsApp and SMS', state: 'not set up yet' },
          { name: 'Printer', state: 'not set up yet' },
          { name: 'Recipe generator', state: 'not set up yet' },
        ],
        activeSessions: sessions.filter((x) => Date.parse(x.expiresAt) > nowMs).length,
        backup,
        system,
      };
    },
  },
};
