import { z } from 'zod';
import type { IntentMap, IntentName } from './intents';
import type { FeedMap, FeedName } from './feeds';

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
  'catalogue/toggle_available_today': z.strictObject({ productId: id, available: z.boolean() }),

  'stock/set_count': z.strictObject({ combinationId: id, count: z.number().int().min(0).max(1_000_000) }),

  'orders/create_order': z.strictObject({
    customerName: name.optional(),
    source: z.enum(['walk_in', 'phone']),
    fulfilment: z.enum(['pickup', 'delivery']),
    deliveryDate: z.string().max(10).optional(),
    deliveryAddress: z.string().max(300).optional(),
  }),
  'orders/set_delivery': z.strictObject({
    orderId: id,
    fulfilment: z.enum(['pickup', 'delivery']).optional(),
    deliveryDate: z.string().max(10).optional(),
    deliveryAddress: z.string().max(300).optional(),
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

  'settings/update': z.strictObject({ decoratingStage: z.boolean().optional() }),

  'payments/record_payment': z.strictObject({
    orderId: id,
    method,
    amount: z.number().finite().min(0).max(1_000_000_000),
    reference: name.optional(),
    allowPartial: z.boolean().optional(),
  }),
  'payments/approve_refund': z.strictObject({ orderId: id, amount: money, reason: longText, method }),

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
