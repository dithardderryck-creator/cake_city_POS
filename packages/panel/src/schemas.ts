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
const money = z.number().finite().min(0).max(1_000_000_000);
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
  'auth/change_pin': z.strictObject({ currentPin: pin, newPin: pin }),

  'staff/create': z.strictObject({ name, role, pin }),
  'staff/set_pin': z.strictObject({ userId: id, pin }),
  'staff/set_active': z.strictObject({ userId: id, active: z.boolean() }),
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
  'quotes/provide': z.strictObject({ quoteId: id, price: z.number().finite().min(0).max(1_000_000_000), note: longText.optional() }),
  'quotes/decline': z.strictObject({ quoteId: id, reason: longText }),
  'quotes/withdraw': z.strictObject({ quoteId: id }),
  'quotes/revise': z.strictObject({ quoteId: id, price: z.number().finite().min(0).max(1_000_000_000), reason: longText }),

  'settings/update': z.strictObject({
    decoratingStage: z.boolean().optional(),
    shopName: z.string().max(60).optional(),
    shopAddress: z.string().max(160).nullable().optional(),
    shopPhone: z.string().max(40).nullable().optional(),
    receiptFooter: z.string().max(160).nullable().optional(),
  }),

  'payments/record_payment': z.strictObject({
    orderId: id,
    method,
    amount: z.number().finite().min(0).max(1_000_000_000),
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
  }),
  'inventory/update_ingredient': z.strictObject({
    ingredientId: id,
    name: name.optional(),
    reorderLevel: qty.nullable().optional(),
    allergens: z.array(name).max(20).optional(),
    ranges: z.array(rangeInput).max(12).optional(),
    active: z.boolean().optional(),
    unit: unit.optional(),
  }),
  'inventory/receive': z.strictObject({ ingredientId: id, qty, unit: unit.optional(), note: longText.optional() }),
  'inventory/count': z.strictObject({ ingredientId: id, counted: qty, unit: unit.optional(), note: longText.optional() }),
  'inventory/write_off': z.strictObject({ ingredientId: id, qty, unit: unit.optional(), note: longText.optional() }),

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
  catalogue_grid: z.strictObject({ includeArchived: z.boolean().optional() }),
  order_list: empty,
  order_card: z.strictObject({ orderId: id }),
  quote_inbox: empty,
  bake_queue: empty,
  shop_settings: empty,
  ingredient_list: z.strictObject({ includeInactive: z.boolean().optional() }),
  recipe_rules: empty,
  usage_form: z.strictObject({ orderId: id, lineId: id }),
  usage_inbox: empty,
  unit_list: empty,
  alert_inbox: empty,
  request_inbox: empty,
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

/** Turn schema problems into a short list a developer can act on. */
export function describeSchemaProblems(error: z.ZodError): string[] {
  return error.issues.slice(0, 5).map((i) => {
    const where = i.path.length ? `"${i.path.join('.')}"` : 'the request';
    return i.code === 'unrecognized_keys' ? `Unexpected field in ${where}.` : `Check ${where}: ${i.message}.`;
  });
}
