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

#### `staff/set_role`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `userId` | string | yes | min length 1, max length 64 |
| `role` | "cashier" \| "baker" \| "inventory" \| "it" | yes |  |

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

#### `catalogue/set_hidden`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `productId` | string | yes | min length 1, max length 64 |
| `hidden` | boolean | yes |  |

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
| `customerPhone` | string | no | max length 30 |

#### `orders/set_delivery`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `fulfilment` | "pickup" \| "delivery" | no |  |
| `deliveryDate` | string | no | max length 10 |
| `deliveryAddress` | string | no | max length 300 |
| `customerPhone` | any | no |  |

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

Allowed: **owner, cashier, baker**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `lineId` | string | yes | min length 1, max length 64 |
| `to` | "draft" \| "awaiting_quote" \| "new" \| "in_production" \| "decorating" \| "ready" \| "out_for_delivery" \| "completed" \| "cancelled" | yes |  |

#### `orders/cancel_order`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |

#### `orders/add_custom_line`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `spec` | object | yes |  |

#### `orders/update_custom_line`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `lineId` | string | yes | min length 1, max length 64 |
| `spec` | object | yes |  |

#### `orders/attach_reference_photo`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `lineId` | string | yes | min length 1, max length 64 |
| `photoId` | string | yes | min length 1, max length 64 |

#### `orders/remove_reference_photo`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `lineId` | string | yes | min length 1, max length 64 |
| `photoId` | string | yes | min length 1, max length 64 |

### Quotes

#### `quotes/request`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `lineId` | string | yes | min length 1, max length 64 |
| `note` | string | no | max length 500 |

#### `quotes/mark_seen`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `quoteId` | string | yes | min length 1, max length 64 |

#### `quotes/provide`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `quoteId` | string | yes | min length 1, max length 64 |
| `price` | number | yes | min 0, max 1000000000 |
| `note` | string | no | max length 500 |

#### `quotes/decline`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `quoteId` | string | yes | min length 1, max length 64 |
| `reason` | string | yes | max length 500 |

#### `quotes/withdraw`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `quoteId` | string | yes | min length 1, max length 64 |

#### `quotes/revise`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `quoteId` | string | yes | min length 1, max length 64 |
| `price` | number | yes | min 0, max 1000000000 |
| `reason` | string | yes | max length 500 |

### Settings

#### `settings/update`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `decoratingStage` | boolean | no |  |
| `shopName` | string | no | max length 60 |
| `shopAddress` | any | no |  |
| `shopPhone` | any | no |  |
| `receiptFooter` | any | no |  |

### Inventory

#### `inventory/create_ingredient`

Allowed: **owner, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `name` | string | yes | max length 120 |
| `unit` | "mg" \| "g" \| "kg" \| "t" \| "oz" \| "lb" \| "ml" \| "cl" \| "dl" \| "l" \| "tsp" \| "tbsp" \| "cup" \| "fl_oz" \| "pcs" \| "dozen" | yes |  |
| `reorderLevel` | number | no | min 0, max 1000000000 |
| `allergens` | string[] | no | max 20 items |
| `ranges` | { label: string, min: number, max: number }[] | no | max 12 items |
| `openingStock` | number | no | min 0, max 1000000000 |
| `kind` | "ingredient" \| "packaging" | no |  |

#### `inventory/update_ingredient`

Allowed: **owner, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `ingredientId` | string | yes | min length 1, max length 64 |
| `name` | string | no | max length 120 |
| `reorderLevel` | any | no |  |
| `allergens` | string[] | no | max 20 items |
| `ranges` | { id?: string, label: string, min: number, max: number }[] | no | max 12 items |
| `active` | boolean | no |  |
| `kind` | "ingredient" \| "packaging" | no |  |
| `unit` | "mg" \| "g" \| "kg" \| "t" \| "oz" \| "lb" \| "ml" \| "cl" \| "dl" \| "l" \| "tsp" \| "tbsp" \| "cup" \| "fl_oz" \| "pcs" \| "dozen" | no |  |

#### `inventory/receive`

Allowed: **owner, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `ingredientId` | string | yes | min length 1, max length 64 |
| `qty` | number | yes | min 0, max 1000000000 |
| `unit` | "mg" \| "g" \| "kg" \| "t" \| "oz" \| "lb" \| "ml" \| "cl" \| "dl" \| "l" \| "tsp" \| "tbsp" \| "cup" \| "fl_oz" \| "pcs" \| "dozen" | no |  |
| `note` | string | no | max length 500 |

#### `inventory/count`

Allowed: **owner, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `ingredientId` | string | yes | min length 1, max length 64 |
| `counted` | number | yes | min 0, max 1000000000 |
| `unit` | "mg" \| "g" \| "kg" \| "t" \| "oz" \| "lb" \| "ml" \| "cl" \| "dl" \| "l" \| "tsp" \| "tbsp" \| "cup" \| "fl_oz" \| "pcs" \| "dozen" | no |  |
| `note` | string | no | max length 500 |

#### `inventory/write_off`

Allowed: **owner, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `ingredientId` | string | yes | min length 1, max length 64 |
| `qty` | number | yes | min 0, max 1000000000 |
| `unit` | "mg" \| "g" \| "kg" \| "t" \| "oz" \| "lb" \| "ml" \| "cl" \| "dl" \| "l" \| "tsp" \| "tbsp" \| "cup" \| "fl_oz" \| "pcs" \| "dozen" | no |  |
| `note` | string | no | max length 500 |

### Recipes

#### `recipes/save_rule`

Allowed: **owner, baker**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `ruleId` | string | no | min length 1, max length 64 |
| `ingredientId` | string | yes | min length 1, max length 64 |
| `quantity` | number | yes | min 0, max 1000000000 |
| `unit` | "mg" \| "g" \| "kg" \| "t" \| "oz" \| "lb" \| "ml" \| "cl" \| "dl" \| "l" \| "tsp" \| "tbsp" \| "cup" \| "fl_oz" \| "pcs" \| "dozen" | no |  |
| `scaling` | "per_serving" \| "per_layer_gap" \| "fixed" | yes |  |
| `flavors` | string[] | no | max 20 items |
| `fillings` | string[] | no | max 20 items |
| `needsDietary` | string[] | no | max 20 items |
| `excludedByDietary` | string[] | no | max 20 items |
| `note` | string | no | max length 500 |

#### `recipes/remove_rule`

Allowed: **owner, baker**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `ruleId` | string | yes | min length 1, max length 64 |

### Usage

#### `usage/report`

Allowed: **owner, baker**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `lineId` | string | yes | min length 1, max length 64 |
| `items` | { ingredientId: string, rangeId: string }[] | yes | max 60 items |
| `note` | string | no | max length 500 |

#### `usage/confirm`

Allowed: **owner, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `reportId` | string | yes | min length 1, max length 64 |
| `items` | { ingredientId: string, qty: number, unit?: "mg" \| "g" \| "kg" \| "t" \| "oz" \| "lb" \| "ml" \| "cl" \| "dl" \| "l" \| "tsp" \| "tbsp" \| "cup" \| "fl_oz" \| "pcs" \| "dozen" }[] | yes | max 60 items |

#### `usage/send_back`

Allowed: **owner, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `reportId` | string | yes | min length 1, max length 64 |
| `reason` | string | yes | max length 500 |

### Alerts

#### `alerts/mark_seen`

Allowed: **owner, cashier, baker, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `alertIds` | string[] | yes | max 100 items |

#### `alerts/acknowledge`

Allowed: **owner, cashier, baker, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `alertId` | string | yes | min length 1, max length 64 |

#### `alerts/snooze`

Allowed: **owner, cashier, baker, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `alertId` | string | yes | min length 1, max length 64 |
| `hours` | integer | yes | min 1, max 72 |

#### `alerts/configure`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `stockoutDays` | integer | no | min 0, max 30 |
| `reorderDays` | integer | no | min 0, max 30 |
| `usageWaitHours` | integer | no | min 1, max 72 |
| `quoteWaitHours` | integer | no | min 1, max 72 |
| `dueSoonDays` | integer | no | min 0, max 14 |
| `countDifference` | integer | no | min 1, max 1000 |
| `urgentRequestMinutes` | integer | no | min 1, max 240 |
| `requestWaitHours` | integer | no | min 1, max 72 |
| `critical` | object | no |  |

### Messages

#### `requests/send`

Allowed: **owner, cashier, baker, inventory, it**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `toRole` | "owner" \| "cashier" \| "baker" \| "inventory" \| "it" | no |  |
| `toUserId` | string | no | min length 1, max length 64 |
| `category` | "Maintenance" \| "System error" \| "Stock and supplies" \| "Order issue" \| "Money" \| "Approval" \| "Staffing" \| "Safety and hygiene" \| "Other" | yes |  |
| `tag` | string | no | max length 24 |
| `title` | string | yes | max length 80 |
| `body` | string | no | max length 500 |
| `urgent` | boolean | no |  |
| `link` | string | no | max length 120 |
| `orderId` | string | no | min length 1, max length 64 |
| `choices` | string[] | no | max 4 items |

#### `requests/mark_seen`

Allowed: **owner, cashier, baker, inventory, it**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `requestId` | string | yes | min length 1, max length 64 |

#### `requests/acknowledge`

Allowed: **owner, cashier, baker, inventory, it**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `requestId` | string | yes | min length 1, max length 64 |

#### `requests/done`

Allowed: **owner, cashier, baker, inventory, it**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `requestId` | string | yes | min length 1, max length 64 |
| `note` | string | no | max length 300 |

#### `requests/decide`

Allowed: **owner, cashier, baker, inventory, it**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `requestId` | string | yes | min length 1, max length 64 |
| `choice` | string | yes | min length 1, max length 30 |
| `note` | string | no | max length 300 |

#### `requests/confirm`

Allowed: **owner, cashier, baker, inventory, it**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `requestId` | string | yes | min length 1, max length 64 |

#### `requests/reopen`

Allowed: **owner, cashier, baker, inventory, it**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `requestId` | string | yes | min length 1, max length 64 |
| `reason` | string | no | max length 300 |

#### `requests/withdraw`

Allowed: **owner, cashier, baker, inventory, it**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `requestId` | string | yes | min length 1, max length 64 |

#### `announcements/post`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `text` | string | yes | max length 500 |
| `requiresAck` | boolean | no |  |

#### `announcements/mark_seen`

Allowed: **owner, cashier, baker, inventory, it**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `announcementId` | string | yes | min length 1, max length 64 |

#### `announcements/acknowledge`

Allowed: **cashier, baker, inventory, it**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `announcementId` | string | yes | min length 1, max length 64 |

#### `announcements/retire`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `announcementId` | string | yes | min length 1, max length 64 |

### Inventory

#### `count/start`

Allowed: **owner, inventory**

_No fields. Send an empty object `{}`._

#### `count/record`

Allowed: **owner, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `sessionId` | string | yes | min length 1, max length 64 |
| `ingredientId` | string | yes | min length 1, max length 64 |
| `counted` | any | yes |  |
| `unit` | "mg" \| "g" \| "kg" \| "t" \| "oz" \| "lb" \| "ml" \| "cl" \| "dl" \| "l" \| "tsp" \| "tbsp" \| "cup" \| "fl_oz" \| "pcs" \| "dozen" | no |  |

#### `count/submit`

Allowed: **owner, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `sessionId` | string | yes | min length 1, max length 64 |

#### `count/discard`

Allowed: **owner, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `sessionId` | string | yes | min length 1, max length 64 |

### Stock

#### `batches/log`

Allowed: **baker, owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `combinationId` | string | yes | min length 1, max length 64 |
| `qty` | integer | yes | min 1, max 1000 |
| `note` | string | no | max length 80 |

#### `batches/undo`

Allowed: **baker, owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `batchId` | string | yes | min length 1, max length 64 |

### Notify

#### `staff/set_contact`

Allowed: **owner, cashier, baker, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `userId` | string | yes | min length 1, max length 64 |
| `phone` | any | no |  |
| `sms` | "off" \| "critical" \| "all" | no |  |
| `whatsapp` | "off" \| "critical" \| "all" | no |  |

#### `push/subscribe`

Allowed: **owner, cashier, baker, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `endpoint` | string | yes | max length 1000 |
| `p256dh` | string | yes | min length 1, max length 200 |
| `auth` | string | yes | min length 1, max length 100 |
| `userAgent` | string | no | max length 300 |

#### `push/unsubscribe`

Allowed: **owner, cashier, baker, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `endpoint` | string | yes | max length 1000 |

#### `notify/send_test`

Allowed: **owner, cashier, baker, inventory**

_No fields. Send an empty object `{}`._

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

#### `payments_ledger`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `day` | string | no | max length 10 |

#### `receipt`

Allowed: **owner, cashier**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |

#### `announcements`

Allowed: **owner, cashier, baker, inventory, it**

_No fields. Send an empty object `{}`._

#### `count_session`

Allowed: **owner, inventory**

_No fields. Send an empty object `{}`._

#### `batch_log`

Allowed: **baker, owner, inventory**

_No fields. Send an empty object `{}`._

#### `reports`

Allowed: **owner**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `days` | any | no |  |

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

#### `quote_inbox`

Allowed: **owner, cashier**

_No fields. Send an empty object `{}`._

#### `bake_queue`

Allowed: **owner, baker**

_No fields. Send an empty object `{}`._

#### `shop_settings`

Allowed: **owner, cashier, baker, inventory**

_No fields. Send an empty object `{}`._

#### `ingredient_list`

Allowed: **owner, inventory, baker**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `includeInactive` | boolean | no |  |

#### `recipe_rules`

Allowed: **owner, baker, inventory**

_No fields. Send an empty object `{}`._

#### `usage_form`

Allowed: **owner, baker**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `orderId` | string | yes | min length 1, max length 64 |
| `lineId` | string | yes | min length 1, max length 64 |

#### `alert_inbox`

Allowed: **owner, cashier, baker, inventory**

_No fields. Send an empty object `{}`._

#### `request_inbox`

Allowed: **owner, cashier, baker, inventory, it**

_No fields. Send an empty object `{}`._

#### `notification_setup`

Allowed: **owner, cashier, baker, inventory**

_No fields. Send an empty object `{}`._

#### `notification_log`

Allowed: **owner, it**

_No fields. Send an empty object `{}`._

#### `alert_settings`

Allowed: **owner**

_No fields. Send an empty object `{}`._

#### `stock_forecast`

Allowed: **owner, baker, inventory**

| Field | Type | Required | Limits |
| --- | --- | --- | --- |
| `ingredientId` | string | no | min length 1, max length 64 |
| `horizonDays` | integer | no | min 1, max 30 |

#### `unit_list`

Allowed: **owner, baker, inventory**

_No fields. Send an empty object `{}`._

#### `usage_inbox`

Allowed: **owner, inventory, baker**

_No fields. Send an empty object `{}`._

#### `audit_view`

Allowed: **owner**

_No fields. Send an empty object `{}`._

#### `panel_map`

Allowed: **it**

_No fields. Send an empty object `{}`._
