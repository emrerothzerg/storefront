# server/contact

Contact-form messages (T42, programmer). Server-only: never import from a `"use client"` module. Consumers: contact server action (T51), ContactForm, account messages page.

## Files

| File | Contents |
|---|---|
| `contact-repository.ts` | `ContactRepository`, `SqliteContactRepository`, `NewContactMessageRow`, `ContactSummaryRow`: thin SQL over `contact_messages` + ownership lookup on `orders` + existence lookup on `products`. Bound parameters only |
| `contact-service.ts` | `CONTACT_TOPICS`, `ContactTopic`, `CONTACT_DUPLICATE_WINDOW_MS`, limits constants, `EMAIL_PATTERN`, `validateContactFields`, `ContactCleanedFields`, `ContactFieldsValidation`, `ContactInput`, `ContactReceipt`, `ContactMessageView`, `ContactField*` types, `ContactService`, `SqliteContactService`, `generateReference`, `createContactService`, `getContactService` |

App code: `getContactService()` (globalThis singleton over `getDatabase()`). Tests: `new SqliteContactService({ db, logger, random? })` or `createContactService({ db, logger })` over `createDatabase(":memory:")` + `runMigrations` + `seedDatabase`.

## Rules

- **Synchronous** (bun:sqlite). `submit` runs the duplicate check, reference generation and insert in one `withTransaction` (BEGIN IMMEDIATE), so two concurrent identical submits cannot both pass the duplicate check.
- **Owner key.** `sessionId` is the owner key (SR11) or `null`. A string that fails `isSessionId` is treated as `null`. A `null` sender can still submit, gets no duplicate check, and any `orderId` is rejected. Messages stored with `session_id NULL` are visible to nobody through this service.
- **Validation** (all fields checked, every failure reported in `details.fields[field] = { code, message }`):

  | Field | Rule | Field codes |
  |---|---|---|
  | name | `cleanText` single line, 1..80 (empty after cleaning or non-string = `REQUIRED`) | `REQUIRED`, `TOO_LONG` |
  | email | `cleanText` single line, 1..254, then the same pattern as `validateAddress` in `src/lib/validation.ts` (copied; not exported there). Stored as typed (not lower-cased) | `REQUIRED`, `TOO_LONG`, `INVALID_EMAIL` |
  | topic | string, trimmed, exact member of `CONTACT_TOPICS` (help topic slugs + `product`, `feedback` (T142, ruling O-4: `/contact?topic=feedback` from FeedbackBlock), `other`) | `INVALID_TOPIC` |
  | message | `cleanText` multiline, max 2000; empty after cleaning (incl. whitespace / invisible-only) = `REQUIRED`, 1..9 chars = `TOO_SHORT`; then `countUrls <= 3` | `REQUIRED`, `TOO_SHORT`, `TOO_LONG`, `TOO_MANY_URLS` |
  | orderId | optional (`undefined`/`null`/blank = absent). Must be an order of this owner. Missing, foreign, malformed, over 128 chars, or sender is `null`: one identical error (no existence leak) | `INVALID_ORDER` |
  | productSlug | optional; non-string, unknown or unpublished slug is dropped (stored `null`), never an error. Published means `published_at <= now` where `now` is submit's injected clock (bound parameter) | none |

  `validateContactFields(input)` is the pure part of this table (name, email, topic, message; no DB, no orderId/productSlug/duplicate checks). It returns `{ fields, cleaned? }` with `cleaned` present exactly when `fields` is empty. `submit` calls it first, then adds the orderId/productSlug checks, so an action pre-check and `submit` report the same field errors.

  Top-level code: `TOO_LONG` when every field error is `TOO_LONG`, otherwise `VALIDATION_FAILED`. Read `details.fields` in both cases.
- **Duplicates.** Same owner + identical cleaned message with `created_at >= now - 10 min` (inclusive) returns `DUPLICATE`. Topic and other fields are ignored for the comparison.
- **Stored text** is the `cleanText` output, verbatim (HTML is kept as text; render as React text children only, SR3). `created_at` = `new Date(now).toISOString()`.
- **Reference.** `"C-"` + 8 Crockford base32 chars (`0-9A-Z` without `I L O U`) from `crypto.getRandomValues`. Collision (checked inside the transaction) regenerates up to 5 times, then `INVALID_INPUT`. `getByReference` trims and upper-cases input, then requires the exact shape.
- **Reads.** `listForSession` returns own messages only, newest first (`created_at DESC, rowid DESC`), capped at 200, with `excerpt` = first 80 code points; no name/email. Invalid session → `[]`. `getByReference` returns the full `ContactMessage` (incl. name/email, the sender's own data) only to the owner; anything else is `NOT_FOUND`.
- **Errors and logging.** Unexpected DB errors are caught: `submit` → `INVALID_INPUT` ("We could not send your message..."), `listForSession` → `[]`, `getByReference` → `NOT_FOUND`. The injectable `logger` (default `console`) receives only a fixed message plus the error's `name`/`code`, never the error message (SQLite messages can echo values) and never name, email or message. Validation and duplicate failures are not logged.
- **Rate limiting** is not done here: the contact action applies `limitAction` (3/hour, 10/day per owner, 200/hour global) before calling `submit`.
