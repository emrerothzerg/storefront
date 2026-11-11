# server/addresses

Session / account address book (`address-repository.ts`, `address-service.ts`). Server-only: never import from a `"use client"` module. Owning task: T40 (programmer). Consumers: address actions (T49), checkout action v2 (T71), AddressBook organism, merge service (T117).

## Files

| File | Contents |
|---|---|
| `address-repository.ts` | `AddressRecord`, `AddressRepository`, `SqliteAddressRepository`: thin SQL over `addresses`, bound parameters only, every statement scoped by `session_id`, no business rules |
| `address-service.ts` | `AddressService`, `createAddressService({ db, logger?, now? })`, `getAddressService()`, `AddressInput`, `AddressBookField`, `AddressStorageError`, `parseAddressInput`, `duplicateKey`, constants `MAX_ADDRESSES_PER_SESSION` (10), `LABEL_MAX` (40), `PHONE_MAX` (20), `PHONE_MIN_DIGITS` (7), `ADDRESS_FIELD_MAX` (200) |

App code uses `getAddressService()` (globalThis singleton over `getDatabase()`; rebuilt if the DB handle changes). Tests use `createAddressService({ db: createDatabase(":memory:") /* + runMigrations */, logger: spy })`.

## API

| Method | Result | Errors |
|---|---|---|
| `list(s)` | addresses, default first, then newest (`created_at DESC`, insertion order breaks ties) | invalid owner key → `[]` |
| `get(s, id)` | the address | `INVALID_INPUT` (owner key), `NOT_FOUND` (unknown, foreign or malformed id, indistinguishable) |
| `getDefault(s)` | default address or `null` | invalid owner key → `null` |
| `countFor(s)` | row count | invalid owner key → `0` |
| `create(s, input, now?)` | the new address | `INVALID_INPUT`, `TOO_LONG`, `VALIDATION_FAILED`, `DUPLICATE`, `LIMIT_REACHED` (`details.max`) |
| `update(s, id, input, now?)` | the address | as create (minus LIMIT_REACHED) + `NOT_FOUND` |
| `remove(s, id)` | `undefined` | `INVALID_INPUT`, `NOT_FOUND` |
| `setDefault(s, id)` | the new default | `INVALID_INPUT`, `NOT_FOUND` |

`now` is epoch ms (defaults to the `now` dep, else `Date.now`); a non-finite or out-of-range value falls back to the clock. Timestamps are stored as ISO strings.

## Rules

- **Owner key.** `s` is the owner key (guest `sf_session` or a user's `owner_key`), validated with `isSessionId` before any query.
- **Input.** `AddressInput` has every `Address` key (pass `email` and `line2` as `undefined` if absent) plus optional `label`, `phone`, `isDefault`. `email` is **ignored**: the table has no email column (`validateAddress` is called with a placeholder email and the `email` error key is never reported). `isDefault` accepts `true`, `1`, `"on"`, `"true"`, `"1"` (checkbox values); anything else is false.
- **Validation order.** (1) Non-object input → `INVALID_INPUT`. (2) Any raw string field longer than 4x its cap (address fields 800, label 160, phone 80) → top-level `TOO_LONG` with `details: { field, max }`, before scanning. (3) Each text field goes through `cleanText` (control/zero-width characters stripped, whitespace collapsed, trimmed), then `validateAddress` (REQUIRED, INVALID_COUNTRY, country upper-cased, empty `line2` dropped). Label: ≤ 40 after cleaning, may be empty. Phone: optional (blank = absent); characters `0-9 + - ( ) space` only (`INVALID_CHARACTERS`), ≤ 20 (`TOO_LONG`), ≥ 7 digits (`INVALID_LENGTH`). Non-string values → `INVALID_TYPE`. All field problems are reported together as `VALIDATION_FAILED` with `details.fields: Partial<Record<AddressBookField, FieldError>>`.
- **Stored as text.** `<`/`>` and other markup are stored as typed; the UI renders them as React text (SR3).
- **Limit.** 10 addresses per owner; the 11th create is `LIMIT_REACHED`. Count and insert happen in one `BEGIN IMMEDIATE` transaction, so concurrent creates cannot overshoot.
- **Duplicates.** Same normalised full name + line 1 (NFKC, lower case, letters/digits only, single spaces) + postal code (letters/digits only) + country, within the same owner → `DUPLICATE`, no row. Checked before the limit. Update checks against the owner's other rows (an address is never a duplicate of itself).
- **Exactly one default.** The first address becomes default. `create`/`update` with `isDefault` and `setDefault` clear the old default and set the new one in one transaction. `isDefault: false` never removes the default (choose another one instead). Removing the default promotes the most recently created remaining address, or none when the book is empty.
- **No-op update.** If the cleaned values equal the stored ones (and no default change is requested), `update` returns the stored address without writing (`updatedAt` unchanged).
- **PII and errors.** Address values are never logged. Expected errors log nothing. DB failures log one line `[addresses] <operation> failed: <CODE>` (driver code such as `SQLITE_CONSTRAINT_TRIGGER`) via the injected logger and throw `AddressStorageError` (`operation`, `code`; no input, no original message, no cause). Callers (actions) catch it and show a generic error.
