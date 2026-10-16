import { z } from 'zod';
import type { IntentMap, IntentName } from './intents';
import type { FeedMap, FeedName } from './feeds';
import { UNIT_CODES } from './units';
import { REQUEST_CATEGORIES } from './domain';

/**
 * Runtime shape of every instruction. TypeScript only checks code we wrote; this checks what
 * actually arrives over the wire. The compile-time check at the bottom keeps it in step with IntentMap.
 */
const id = z.string().min(1).max(64);
const pin = z.string().min(1).max(12);
/** Money is whole shillings (TSh has no cents in daily use). */
const money = z.number().finite().int('enter a whole number of shillings, with no cents').min(0).max(1_000_000_000);
const name = z.string().max(120);
const longText = z.string().max(500);
const method = z.enum(['cash', 'card', 'bank_transfer', 'mobile_money']);
const lineStatus = z.enum(['draft', 'awaiting_quote', 'new', 'in_production', 'decorating', 'ready', 'out_for_delivery', 'completed', 'cancelled']);
const role = z.enum(['owner', 'cashier', 'baker', 'inventory', 'it']);
const empty = z.strictObject({});
const qty = z.number().finite().min(0).max(1_000_000_000);
const unit = z.enum(UNIT_CODES);
const tags = z.array(z.string().max(60)).max(20);
const rangeInput = z.strictObject({ id: id.optional(), label: z.string().max(60), min: qty, max: qty });
const cakeSpec = z.strictObject({
  servings: z.number().int().min(1).max(500),
  sizeNote: z.string().max(80).optional(),
  flavor: z.string().min(1).max(80),
  filling: z.string().max(80).optional(),
  layers: z.number().int().min(1).max(10).optional(),
  dietary: z.array(z.string().max(40)).max(8).optional(),
  decorationNotes: z.string().max(1000).optional(),
  inscription: z.string().max(120).optional(),
  allergyNotes: z.string().max(300).optional(),
});

export const schemas = {
  'auth/sign_in': z.strictObject({ userId: id, pin }),
  'auth/sign_out': empty,
  'day/close': z.strictObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'choose a date').optional(), countedCash: money, floatKept: money.optional(), note: longText.optional() }),
  'offline/get_pass': empty,
  'offline/review': z.strictObject({ heldId: id, action: z.enum(['approve', 'dismiss']), note: longText.optional() }),
  'auth/change_pin': z.strictObject({ currentPin: pin, newPin: pin }),

  'devices/create_code': z.strictObject({ name, replaces: id.optional() }),
  'devices/cancel_code': z.strictObject({ codeId: id }),
  'devices/pair': z.strictObject({ code: z.string().min(1).max(40) }),
  'devices/rename': z.strictObject({ deviceId: id, name }),
  'devices/revoke': z.strictObject({ deviceId: id }),

  'staff/create': z.strictObject({ name, role, pin }),
  'staff/set_pin': z.strictObject({ userId: id, pin }),
  'staff/set_active': z.strictObject({ userId: id, active: z.boolean() }),
  'staff/delete': z.strictObject({ userId: id }),
  'staff/set_role': z.strictObject({ userId: id, role: z.enum(['cashier', 'baker', 'inventory', 'it']) }),

  'catalogue/create_option_group': z.strictObject({
    name,
    values: z.array(z.strictObject({ label: name, allergens: z.array(name).max(20).optional() })).max(60),
  }),
  'catalogue/create_product': z.strictObject({
    name,
    category: name.optional(),
    description: z.string().max(1000).optional(),
    allergens: z.array(name).max(20).optional(),
  }),
  'catalogue/set_product_options': z.strictObject({ productId: id, valueIds: z.array(id).max(200) }),
  'catalogue/generate_combinations': z.strictObject({ productId: id }),
  'catalogue/set_price': z.strictObject({ combinationId: id, price: money }),
  'catalogue/fill_price': z.strictObject({ productId: id, valueId: id, price: money }),
  'catalogue/mark_unavailable': z.strictObject({ combinationId: id, unavailable: z.boolean() }),
  'catalogue/archive_product': z.strictObject({ productId: id }),
  'catalogue/set_hidden': z.strictObject({ productId: id, hidden: z.boolean() }),
  'catalogue/toggle_available_today': z.strictObject({ productId: id, available: z.boolean() }),

  'stock/set_count': z.strictObject({ combinationId: id, count: z.number().int().min(0).max(1_000_000) }),

  'orders/create_order': z.strictObject({
    customerName: name.optional(),
    source: z.enum(['walk_in', 'phone']),
    fulfilment: z.enum(['pickup', 'delivery']),
    deliveryDate: z.string().max(10).optional(),
    deliveryAddress: z.string().max(300).optional(),
    customerPhone: z.string().max(30).optional(),
  }),
  'orders/set_delivery': z.strictObject({
    orderId: id,
    fulfilment: z.enum(['pickup', 'delivery']).optional(),
    deliveryDate: z.string().max(10).optional(),
    deliveryAddress: z.string().max(300).optional(),
    customerPhone: z.string().max(30).nullable().optional(),
  }),
  'orders/quick_sale': z.strictObject({
    items: z.array(z.strictObject({ combinationId: id, qty: z.number().int().min(1).max(10_000) })).min(1).max(50),
    method,
    reference: name.optional(),
    customerName: name.optional(),
    expectedTotal: money.optional(),
  }),
  'orders/add_catalogue_line': z.strictObject({ orderId: id, combinationId: id, qty: z.number().int().min(1).max(10_000) }),
  'orders/add_custom_line': z.strictObject({ orderId: id, spec: cakeSpec }),
  'orders/update_custom_line': z.strictObject({ orderId: id, lineId: id, spec: cakeSpec }),
  'orders/attach_reference_photo': z.strictObject({ orderId: id, lineId: id, photoId: id }),
  'orders/remove_reference_photo': z.strictObject({ orderId: id, lineId: id, photoId: id }),
  'orders/cancel_line': z.strictObject({ orderId: id, lineId: id }),
  'orders/advance_line': z.strictObject({ orderId: id, lineId: id, to: lineStatus }),
  'orders/cancel_order': z.strictObject({ orderId: id }),

  'quotes/request': z.strictObject({ orderId: id, lineId: id, note: longText.optional() }),
  'quotes/mark_seen': z.strictObject({ quoteId: id }),
  'quotes/provide': z.strictObject({ quoteId: id, price: money, note: longText.optional() }),
  'quotes/decline': z.strictObject({ quoteId: id, reason: longText }),
  'quotes/withdraw': z.strictObject({ quoteId: id }),
  'quotes/revise': z.strictObject({ quoteId: id, price: money, reason: longText }),

  'settings/update': z.strictObject({
    decoratingStage: z.boolean().optional(),
    shopName: z.string().max(60).optional(),
    shopAddress: z.string().max(160).nullable().optional(),
    shopPhone: z.string().max(40).nullable().optional(),
    receiptFooter: z.string().max(160).nullable().optional(),
    paymentMethods: z.array(method).max(4).optional(),
    lowStockUnits: z.number().int().min(0).max(1000).optional(),
    bigDifferencePercent: z.number().min(1).max(100).optional(),
    refundCooldownMinutes: z.number().int().min(0).max(120).optional(),
    offlineEnabled: z.boolean().optional(),
    offlinePassHours: z.number().int().min(1).max(72).optional(),
    offlineMaxSales: z.number().int().min(1).max(1000).optional(),
    offlineMaxTotal: money.optional(),
    dayCloseBy: z.enum(['owner', 'cashier_and_owner']).optional(),
  }),

  'payments/record_payment': z.strictObject({
    orderId: id,
    method,
    amount: money,
    reference: name.optional(),
    allowPartial: z.boolean().optional(),
  }),
  'payments/approve_refund': z.strictObject({ orderId: id, amount: money, reason: longText, method }),

  'inventory/create_ingredient': z.strictObject({
    name,
    unit,
    reorderLevel: qty.optional(),
    allergens: z.array(name).max(20).optional(),
    ranges: z.array(rangeInput.omit({ id: true })).max(12).optional(),
    openingStock: qty.optional(),
    kind: z.enum(['ingredient', 'packaging']).optional(),
  }),
  'inventory/update_ingredient': z.strictObject({
    ingredientId: id,
    name: name.optional(),
    reorderLevel: qty.nullable().optional(),
    allergens: z.array(name).max(20).optional(),
    ranges: z.array(rangeInput).max(12).optional(),
    active: z.boolean().optional(),
    kind: z.enum(['ingredient', 'packaging']).optional(),
    unit: unit.optional(),
  }),
  'inventory/receive': z.strictObject({ ingredientId: id, qty, unit: unit.optional(), note: longText.optional() }),
  'inventory/count': z.strictObject({ ingredientId: id, counted: qty, unit: unit.optional(), note: longText.optional() }),
  'inventory/write_off': z.strictObject({ ingredientId: id, qty, unit: unit.optional(), note: longText.optional() }),

  'batches/log': z.strictObject({ combinationId: id, qty: z.number().int().min(1).max(1000), note: z.string().max(80).optional() }),
  'batches/undo': z.strictObject({ batchId: id }),

  'count/start': z.strictObject({}),
  'count/record': z.strictObject({ sessionId: id, ingredientId: id, counted: qty.nullable(), unit: unit.optional() }),
  'count/submit': z.strictObject({ sessionId: id }),
  'count/discard': z.strictObject({ sessionId: id }),

  'recipes/save_rule': z.strictObject({
    ruleId: id.optional(),
    ingredientId: id,
    quantity: qty,
    unit: unit.optional(),
    scaling: z.enum(['per_serving', 'per_layer_gap', 'fixed']),
    flavors: tags.optional(),
    fillings: tags.optional(),
    needsDietary: tags.optional(),
    excludedByDietary: tags.optional(),
    note: longText.optional(),
  }),
  'recipes/remove_rule': z.strictObject({ ruleId: id }),

  'usage/report': z.strictObject({
    orderId: id,
    lineId: id,
    items: z.array(z.strictObject({ ingredientId: id, rangeId: id })).max(60),
    note: longText.optional(),
  }),
  'usage/confirm': z.strictObject({ reportId: id, items: z.array(z.strictObject({ ingredientId: id, qty, unit: unit.optional() })).max(60) }),
  'usage/send_back': z.strictObject({ reportId: id, reason: longText }),

  'alerts/mark_seen': z.strictObject({ alertIds: z.array(id).min(1).max(100) }),
  'alerts/acknowledge': z.strictObject({ alertId: id }),
  'alerts/snooze': z.strictObject({ alertId: id, hours: z.number().int().min(1).max(72) }),
  'alerts/configure': z.strictObject({
    stockoutDays: z.number().int().min(0).max(30).optional(),
    reorderDays: z.number().int().min(0).max(30).optional(),
    usageWaitHours: z.number().int().min(1).max(72).optional(),
    quoteWaitHours: z.number().int().min(1).max(72).optional(),
    dueSoonDays: z.number().int().min(0).max(14).optional(),
    countDifference: z.number().int().min(1).max(1000).optional(),
    urgentRequestMinutes: z.number().int().min(1).max(240).optional(),
    requestWaitHours: z.number().int().min(1).max(72).optional(),
    critical: z
      .strictObject({
        low_stock: z.boolean().optional(),
        stockout: z.boolean().optional(),
        usage_waiting: z.boolean().optional(),
        order_not_started: z.boolean().optional(),
        quote_waiting: z.boolean().optional(),
        overdue_delivery: z.boolean().optional(),
        count_difference: z.boolean().optional(),
        request_waiting: z.boolean().optional(),
        offline_held: z.boolean().optional(),
      })
      .optional(),
  }),

  'requests/send': z.strictObject({
    toRole: role.optional(),
    toUserId: id.optional(),
    category: z.enum(REQUEST_CATEGORIES),
    tag: z.string().max(24).optional(),
    title: z.string().max(80),
    body: z.string().max(500).optional(),
    urgent: z.boolean().optional(),
    link: z.string().max(120).optional(),
    orderId: id.optional(),
    choices: z.array(z.string().max(30)).min(2).max(4).optional(),
  }),
  'requests/mark_seen': z.strictObject({ requestId: id }),
  'requests/acknowledge': z.strictObject({ requestId: id }),
  'requests/done': z.strictObject({ requestId: id, note: z.string().max(300).optional() }),
  'requests/decide': z.strictObject({ requestId: id, choice: z.string().min(1).max(30), note: z.string().max(300).optional() }),
  'requests/confirm': z.strictObject({ requestId: id }),
  'requests/reopen': z.strictObject({ requestId: id, reason: z.string().max(300).optional() }),
  'requests/withdraw': z.strictObject({ requestId: id }),

  'announcements/post': z.strictObject({ text: z.string().max(500), requiresAck: z.boolean().optional() }),
  'announcements/mark_seen': z.strictObject({ announcementId: id }),
  'announcements/acknowledge': z.strictObject({ announcementId: id }),
  'announcements/retire': z.strictObject({ announcementId: id }),

  'staff/set_contact': z.strictObject({
    userId: id,
    phone: z.string().max(40).nullable().optional(),
    sms: z.enum(['off', 'critical', 'all']).optional(),
    whatsapp: z.enum(['off', 'critical', 'all']).optional(),
  }),
  'push/subscribe': z.strictObject({ endpoint: z.string().url().max(1000), p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100), userAgent: z.string().max(300).optional() }),
  'push/unsubscribe': z.strictObject({ endpoint: z.string().max(1000) }),
  'notify/send_test': empty,

  'sync/flush': empty,
  'sync/full_copy': empty,
} as const;

/** Compile-time proof that each schema and its IntentMap entry accept the same shapes. */
type Both<K extends IntentName> = [z.infer<(typeof schemas)[K]>] extends [IntentMap[K]]
  ? [IntentMap[K]] extends [z.infer<(typeof schemas)[K]>]
    ? true
    : false
  : false;
export const _schemasMatchIntentMap: { [K in IntentName]: Both<K> } = null as unknown as {
  [K in IntentName]: true;
};

export const feedSchemas = {
  me: empty,
  navigation: empty,
  staff_signin: empty,
  staff_list: empty,
  device_list: empty,
  catalogue_grid: z.strictObject({ includeArchived: z.boolean().optional() }),
  order_list: empty,
  order_card: z.strictObject({ orderId: id }),
  quote_inbox: empty,
  bake_queue: empty,
  shop_settings: empty,
  offline_review: empty,
  day_report: z.strictObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'choose a date').optional() }),
  ingredient_list: z.strictObject({ includeInactive: z.boolean().optional() }),
  recipe_rules: empty,
  usage_form: z.strictObject({ orderId: id, lineId: id }),
  usage_inbox: empty,
  unit_list: empty,
  alert_inbox: empty,
  request_inbox: empty,
  announcements: empty,
  count_session: empty,
  batch_log: empty,
  reports: z.strictObject({ days: z.union([z.literal(7), z.literal(30)]).optional() }),
  payments_ledger: z.strictObject({ day: z.string().max(10).optional() }),
  receipt: z.strictObject({ orderId: id }),
  notification_setup: empty,
  notification_log: empty,
  alert_settings: empty,
  stock_forecast: z.strictObject({ ingredientId: id.optional(), horizonDays: z.number().int().min(1).max(30).optional() }),
  audit_view: empty,
  panel_map: empty,
} as const;

type FeedBoth<K extends FeedName> = [z.infer<(typeof feedSchemas)[K]>] extends [FeedMap[K]['params']]
  ? [FeedMap[K]['params']] extends [z.infer<(typeof feedSchemas)[K]>]
    ? true
    : false
  : false;
export const _feedSchemasMatchFeedMap: { [K in FeedName]: FeedBoth<K> } = null as unknown as {
  [K in FeedName]: true;
};

const THOUSANDS = (n: unknown) => (typeof n === 'number' || typeof n === 'bigint' ? n.toLocaleString('en-US') : String(n));

/** One schema problem in plain words. The field name stays so a developer can find it. */
function plainProblem(i: z.core.$ZodIssue): string {
  const field = [...i.path].reverse().find((p) => typeof p === 'string');
  const where = field !== undefined ? `"${String(field)}"` : 'the request';
  if (i.code === 'unrecognized_keys') return `Unexpected field in ${where}.`;
  const issue = i as unknown as { origin?: string; maximum?: number | bigint; minimum?: number | bigint; expected?: string; input?: unknown; format?: string; values?: unknown[]; message: string };
  let what: string;
  if (i.code !== 'too_big' && i.code !== 'too_small' && !/^(Invalid|Too )/.test(issue.message)) {
    what = issue.message.replace(/\.$/, ''); // a message written for people in the schema itself
  } else if (i.code === 'too_big') {
    what = issue.origin === 'string' ? `it is too long (at most ${THOUSANDS(issue.maximum)} characters)` : issue.origin === 'array' ? `it has too many entries (at most ${THOUSANDS(issue.maximum)})` : `it can be at most ${THOUSANDS(issue.maximum)}`;
  } else if (i.code === 'too_small') {
    what = issue.origin === 'string' ? (Number(issue.minimum) <= 1 ? 'it cannot be empty' : `it is too short (at least ${THOUSANDS(issue.minimum)} characters)`) : issue.origin === 'array' ? `it needs at least ${THOUSANDS(issue.minimum)} entr${Number(issue.minimum) === 1 ? 'y' : 'ies'}` : `it must be at least ${THOUSANDS(issue.minimum)}`;
  } else if (i.code === 'invalid_type') {
    what = issue.expected === 'int' ? 'enter a whole number' : issue.expected === 'number' ? 'enter a number' : issue.expected === 'string' ? 'enter text' : issue.expected === 'boolean' ? 'choose yes or no' : issue.expected === 'array' ? 'a list is needed' : 'the value is not the right kind';
  } else if (i.code === 'invalid_value') {
    what = 'it is not one of the allowed choices';
  } else if (i.code === 'invalid_format') {
    what = 'it is not in the right format';
  } else if (/^Invalid input: expected int/.test(issue.message)) {
    what = 'enter a whole number';
  } else {
    what = issue.message.replace(/\.$/, '');
  }
  return `Check ${where}: ${what}.`;
}

/** Turn schema problems into a short list of plain sentences (the screens show them as they are). */
export function describeSchemaProblems(error: z.ZodError): string[] {
  const seen = new Set<string>(); // one problem per field is enough to act on
  const out: string[] = [];
  // when two limits are broken the tighter one is the useful one to report
  const tightest = (i: z.core.$ZodIssue) => Number((i as unknown as { maximum?: number }).maximum ?? Infinity);
  for (const i of [...error.issues].sort((a, b) => tightest(a) - tightest(b))) {
    const key = i.path.join('.');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(plainProblem(i));
  }
  return out.slice(0, 5);
}

/* ---------- Text clean-up ---------- */

/** Text fields that may run over several lines. Everything else is one line. */
const MULTILINE_KEYS = new Set(['decorationNotes', 'allergyNotes', 'description', 'deliveryAddress', 'shopAddress', 'receiptFooter', 'body', 'note', 'reason', 'text']);
/** Never touched: what the person typed is exactly what is checked. */
const UNTOUCHED_KEYS = new Set(['pin', 'currentPin', 'newPin']);
/** Control characters, zero-width spaces and the bidirectional overrides used to disguise text. Joiners and left/right marks stay, because emoji and Arabic, Persian and Indic scripts need them. */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u202A-\u202E\u2060\uFEFF]/g;

/** One line: any run of spaces, tabs and line breaks becomes a single space; hidden characters are removed. */
export function cleanLine(s: string): string {
  return s.replace(/[\t\r\n\v\f\u2028\u2029]+/g, ' ').replace(HIDDEN, '').replace(/ {2,}/g, ' ').trim();
}

/** Several lines: line breaks are kept (at most one blank line in a row), other whitespace is tidied. */
export function cleanLines(s: string): string {
  return s
    .replace(/\r\n?|\u2028|\u2029/g, '\n')
    .replace(/[\t\v\f]+/g, ' ')
    .replace(HIDDEN, (c) => (c === '\n' ? c : ''))
    .replace(/ *\n */g, '\n')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Tidies every piece of text in a request before it is checked, so a pasted line break, a tab or an invisible
 * character can never end up in a name, on a receipt or in an export. Numbers and structure are left alone.
 */
export function cleanPayload(value: unknown, key = '', depth = 0): unknown {
  if (typeof value === 'string') return UNTOUCHED_KEYS.has(key) ? value : MULTILINE_KEYS.has(key) ? cleanLines(value) : cleanLine(value);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => cleanPayload(v, key, depth + 1));
  const out: Record<string, unknown> = {};
  // defineProperty so a key called "__proto__" stays an ordinary field and is refused like any other unknown one
  for (const [k, v] of Object.entries(value)) Object.defineProperty(out, k, { value: cleanPayload(v, k, depth + 1), enumerable: true, writable: true, configurable: true });
  return out;
}
