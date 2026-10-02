# API reference

_Generated from the code by `npm run docs:api`. Do not edit by hand: a test fails if this file is out of date._

How to send instructions and read feeds is in [api.md](api.md). Data shapes returned by feeds are the TypeScript types in `packages/panel/src/feeds.ts` (exported from `@cake-pos/panel`).

## Instructions

Send with `POST /api/dispatch` as `{ "type": "<name>", "payload": { ... }, "requestId": "<unique>" }`. Unknown fields are rejected.

### Auth

#### `auth/sign_in`

Allowed: **anyone (no sign-in)**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `userId` | string | yes | min length 1, max length 64 |
| `pin` | string | yes | min length 1, max length 12 |

#### `auth/sign_out`

Allowed: **owner, cashier, baker, inventory, it**

_No fields. Send an empty object `{}`._

#### `auth/change_pin`

Allowed: **owner, cashier, baker, inventory, it**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `currentPin` | string | yes | min length 1, max length 12 |
| `newPin` | string | yes | min length 1, max length 12 |

### Staff

#### `staff/create`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `name` | string | yes | max length 120 |
| `role` | "owner" \| "cashier" \| "baker" \| "inventory" \| "it" | yes |  |
| `pin` | string | yes | min length 1, max length 12 |

#### `staff/set_pin`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `userId` | string | yes | min length 1, max length 64 |
| `pin` | string | yes | min length 1, max length 12 |

#### `staff/set_active`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `userId` | string | yes | min length 1, max length 64 |
| `active` | boolean | yes |  |

### Catalogue

#### `catalogue/create_option_group`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `name` | string | yes | max length 120 |
| `values` | { label: string, allergens?: string[] }[] | yes | max 60 items |

#### `catalogue/create_product`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `name` | string | yes | max length 120 |
| `category` | string | no | max length 120 |
| `description` | string | no | max length 1000 |
| `allergens` | string[] | no | max 20 items |

#### `catalogue/set_product_options`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `productId` | string | yes | min length 1, max length 64 |
| `valueIds` | string[] | yes | max 200 items |

#### `catalogue/generate_combinations`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `productId` | string | yes | min length 1, max length 64 |

#### `catalogue/set_price`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `combinationId` | string | yes | min length 1, max length 64 |
| `price` | number | yes | min 0, max 1000000000 |

#### `catalogue/fill_price`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `productId` | string | yes | min length 1, max length 64 |
| `valueId` | string | yes | min length 1, max length 64 |
| `price` | number | yes | min 0, max 1000000000 |

#### `catalogue/mark_unavailable`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `combinationId` | string | yes | min length 1, max length 64 |
| `unavailable` | boolean | yes |  |

#### `catalogue/archive_product`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `productId` | string | yes | min length 1, max length 64 |

#### `catalogue/toggle_available_today`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `productId` | string | yes | min length 1, max length 64 |
| `available` | boolean | yes |  |

### Stock

#### `stock/set_count`

Allowed: **owner, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `combinationId` | string | yes | min length 1, max length 64 |
| `count` | integer | yes | min 0, max 1000000 |

### Orders

#### `orders/create_order`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `customerName` | string | no | max length 120 |
| `source` | "walk_in" \| "phone" | yes |  |
| `fulfilment` | "pickup" \| "delivery" | yes |  |
| `deliveryDate` | string | no | max length 10 |
| `deliveryAddress` | string | no | max length 300 |

#### `orders/add_catalogue_line`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `combinationId` | string | yes | min length 1, max length 64 |
| `qty` | integer | yes | min 1, max 10000 |

#### `orders/cancel_line`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `lineId` | string | yes | min length 1, max length 64 |

#### `orders/advance_line`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `lineId` | string | yes | min length 1, max length 64 |
| `to` | "new" \| "ready" \| "out_for_delivery" \| "completed" \| "cancelled" | yes |  |

#### `orders/cancel_order`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |

### Payments

#### `payments/record_payment`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `method` | "cash" \| "card" \| "bank_transfer" \| "mobile_money" | yes |  |
| `amount` | number | yes | min 0, max 1000000000 |
| `reference` | string | no | max length 120 |
| `allowPartial` | boolean | no |  |

#### `payments/approve_refund`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `amount` | number | yes | min 0, max 1000000000 |
| `reason` | string | yes | max length 500 |
| `method` | "cash" \| "card" \| "bank_transfer" \| "mobile_money" | yes |  |

### Sync

#### `sync/flush`

Allowed: **owner, it**

_No fields. Send an empty object `{}`._

## Feeds

Read with `POST /api/feed` as `{ "name": "<name>", "params": { ... } }`, or subscribe over the live connection to get the same data again after every change.

#### `me`

Allowed: **owner, cashier, baker, inventory, it**

_No fields. Send an empty object `{}`._

#### `navigation`

Allowed: **owner, cashier, baker, inventory, it**

_No fields. Send an empty object `{}`._

#### `staff_signin`

Allowed: **anyone (no sign-in)**

_No fields. Send an empty object `{}`._

#### `staff_list`

Allowed: **owner**

_No fields. Send an empty object `{}`._

#### `catalogue_grid`

Allowed: **owner, cashier, baker, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `includeArchived` | boolean | no |  |

#### `order_list`

Allowed: **owner, cashier**

_No fields. Send an empty object `{}`._

#### `order_card`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |

#### `audit_view`

Allowed: **owner**

_No fields. Send an empty object `{}`._

#### `panel_map`

Allowed: **it**

_No fields. Send an empty object `{}`._
