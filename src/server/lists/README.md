# Lists (wish lists + save for later) — T37

Server-only. `list-service.ts` holds the rules; `list-repository.ts` is the SQL (bound parameters only). Tables: `lists`, `list_items` (see `src/server/db/README.md`). Cart interplay (move to cart / save for later from the cart) lives in the cart service v2 (T45), which calls `ensureSaveForLater` + `addItem` / `moveItem` here.

```ts
import { getListService } from "@/server/lists/list-service";   // app (globalThis singleton over getDatabase())
import { createListService } from "@/server/lists/list-service"; // tests: createListService({ db, now? })
```

All methods are synchronous. Every multi-statement write runs in one `withTransaction` (BEGIN IMMEDIATE); a thrown DB error rolls back and propagates (callers/actions map it to a generic failure).

## Ownership
- `sessionId` is the OWNER KEY (guest session or `users.owner_key`), validated with `isSessionId` before any query. Invalid: mutations and `getList` return `INVALID_INPUT`; `listLists` returns `[]`; `isInDefaultList` returns `false`.
- Every list-id operation filters on `id AND session_id`. A foreign, unknown or malformed list id (also a share token passed as a list id) returns `NOT_FOUND` with the identical message `"List not found"`, and writes nothing.
- No returned object carries `session_id` (`toPublicList` strips it).

## Lists
| Rule | Behaviour |
|---|---|
| Default wishlist | `ensureDefaultList` is idempotent: returns the `is_default = 1` wishlist, else promotes the oldest wishlist (repair), else creates "Shopping List". The first wishlist created via `createList` also becomes the default. At most one default per owner. |
| Save for later | `ensureSaveForLater` inserts with `ON CONFLICT (session_id) WHERE kind = 'save_for_later' DO NOTHING` then selects, so concurrent calls yield one row. Name "Saved for later". `renameList` / `setSharing` / `deleteList` on it → `FORBIDDEN`. Items can be added/moved/updated/removed normally. |
| Names | `cleanText(name, { max: 60, min: 1 })`: non-string `INVALID_INPUT`, blank after cleaning `VALIDATION_FAILED`, > 60 `TOO_LONG`. Duplicate names are allowed. |
| Count | max 20 **wishlists** per owner (21st `createList` → `LIMIT_REACHED`, `details.max`). The save-for-later list does not count. |
| Delete | Deleting the default requires another wishlist (else `FORBIDDEN`); the oldest remaining wishlist is promoted in the same transaction. Items go by `ON DELETE CASCADE`; products and other lists are untouched. |
| Order | `listLists`: default first, other wishlists oldest first, save-for-later last; each with `itemCount` (rows). |

## Items
| Field | Rule |
|---|---|
| `quantityDesired` | integer 1..99 (numbers, or digit strings like `"3"` from forms); else `INVALID_QUANTITY`. Default 1. |
| `priority` | 0 / 1 / 2 (number or `"0"`-`"2"`); else `VALIDATION_FAILED` (`details.field = "priority"`). Default 0. |
| `note` | `cleanText(note, { max: 200, multiline: true })`; > 200 `TOO_LONG`; `null`/`undefined`/blank → `null`. In `updateItem`, `undefined` = unchanged, `null` or blank = clear. |
| `price_at_add_cents` | current product price at add time (server-side; never from the client). |

- `addItem(sessionId, listId | null, productId, opts)`: `null` = default wishlist (created if needed, rolled back if the add fails). Product must exist and be published (`published_at <= now`), else `PRODUCT_NOT_FOUND`. Already present → `{ alreadyPresent: true }` with the stored item unchanged (opts ignored). 201st item → `LIMIT_REACHED` (an already-present product at the cap still succeeds).
- `updateItem`: item not in the list → `NOT_FOUND`. Empty patch returns the item unchanged.
- `removeItem`: idempotent (absent item = success) once the list is owned.
- `moveItem(from, to, productId)`: both lists must be owned; source item missing → `NOT_FOUND`; `from === to` is a no-op. Target without the item: the row moves with its snapshot (price, priority, note, `added_at`); full target → `LIMIT_REACHED` and nothing changes. Target with the item: merge keeps the larger `quantityDesired`, keeps the target's priority and note (takes the source note only when the target's is null), and deletes the source row.
- `isInDefaultList(sessionId, productId)`: boolean, for the PDP "Added to list" state.

## Views
- `getList(sessionId, listId, sort?)` → `ListView` (`ProductList` + `items`, `itemCount` = rows, `totalCents` = Σ current price × quantityDesired over items whose product still exists; `MONEY_OVERFLOW` if unsafe).
- `ListItemView`: `product` (hydrated with `SqliteProductRepository.getManyByIds`; `null` when vanished), `priceDroppedByCents` (stored − current when current < stored, else `null`), `available` (product exists and `stock > 0`), `purchasedSinceAdded` (the owner has an order with `status = 'paid'`, `fulfillment_status <> 'cancelled'`, containing the product, `created_at >= added_at`).
- Sort: `added_desc` (default) | `price_asc` | `price_desc` | `priority` (high first). Ties fall back to newest first; vanished products sort last for price sorts. Unknown values → default.

## Sharing
- `setSharing(sessionId, listId, "enable" | "disable" | "rotate")` (wishlists only). Enable is idempotent (keeps an active token); rotate always issues a new one; disable clears the token and `is_public`. Token: 16 bytes from `crypto.getRandomValues`, base64url without padding (22 chars).
- `getByToken(token, sort?)` is the only token entry point and is read-only. Tokens not matching `^[A-Za-z0-9_-]{22}$`, disabled, rotated or non-public → `NOT_FOUND`. Returns `SharedListView { name, items, itemCount }`: no session id, no list id (`items[].listId` is `""`), no token, and `purchasedSinceAdded` is always `false` (owner purchase history is private). Notes, quantities and priorities are shown.
- Tokens are bearer credentials: never log them; render them only to the owner.

## Error codes
`INVALID_INPUT`, `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_FAILED`, `TOO_LONG`, `LIMIT_REACHED`, `PRODUCT_NOT_FOUND`, `INVALID_QUANTITY`, `MONEY_OVERFLOW`.

## Tests
`bun test src/server/lists` (in-memory DB, seeded with `seedDatabase`).
