# server/session

Session cookies and OWNER-KEY resolution. Server-only (never import from a `"use client"` module; `safe-next.ts` is the one pure exception). Owning tasks: T08 (guest cookie), T119 (accounts: owner key, auth cookie, current user).

## The owner key

Every owner-keyed service (cart, orders, lists, reviews, addresses, ...) takes a "session id" argument. Since T119 (SR11) that argument is the **owner key**:

- signed in (valid `sf_auth`): the user's `users.owner_key`;
- otherwise: the guest `sf_session` id.

Guests and users share one shape: a canonical lower-case UUID v4, checked with `isSessionId`. Services, tables and `session_id` columns did not change.

The owner key is a bearer credential and stays server-side (R-1). It never goes into a component prop, action state, JSON, HTML, URL or log. UI code uses `readCurrentUser()`, which returns only `{ id, email, displayName }`.

**R-1 shape rule.** A guest `sf_session` value that equals any `users.owner_key` is treated as **no cookie**. This costs one indexed lookup per resolution that carries a valid guest cookie. Read paths return `null`, `getOrCreateSessionId()` replaces the cookie with a fresh id, and `readGuestSessionId()` returns `null`. So a leaked owner key cannot be replayed as a guest cookie.

**Tombstone.** `DELETED_OWNER_KEY` = `00000000-0000-4000-8000-000000000000` (defined by the account lifecycle, T118). Orders and coupon redemptions of deleted accounts are re-keyed to it. It is v4-shaped and no user has it as `owner_key`, so if it ever arrives in `sf_session` it is treated like any guest id. It owns only anonymised orders, and order lookups by that key are blocked in the order service (T55).

## API: `session.ts`

| Export | Use |
|---|---|
| `SESSION_COOKIE_NAME` | `"sf_session"` |
| `SESSION_MAX_AGE_SECONDS` | `60 * 60 * 24 * 30` (30 days) |
| `AUTH_COOKIE_NAME` | `"sf_auth"` |
| `AUTH_COOKIE_MAX_AGE_SECONDS` | `30 * 24 * 60 * 60` (cap for `sf_auth`) |
| `readSessionId(): Promise<string \| null>` | **Read paths, render included.** Returns the owner key: user's `owner_key` for a valid `sf_auth`, else the R-1-checked guest id, else `null`. Never sets or clears cookies. A bad, expired or revoked `sf_auth` is left in place (SR10, R-8). Never throws an application error: `cookies()` failures and DB failures read as `null`. Next control-flow errors are rethrown (`unstable_rethrow` first in the catch). |
| `getOrCreateSessionId(): Promise<string>` | **Server Actions / Route Handlers only.** With a valid `sf_auth` it returns the owner key and writes **no** guest cookie. Otherwise it returns the existing acceptable guest id, or mints `crypto.randomUUID()` and sets `sf_session`, as in the MVP. Garbage, or a value equal to a user's owner key, is replaced. DB errors propagate, so the action fails instead of silently swapping the visitor's cookie. Calling it from render throws when it tries to set the cookie. |
| `readGuestSessionId(): Promise<string \| null>` | The raw `sf_session` value if it is a valid v4 and not a user's owner key. Ignores `sf_auth`. The sign-in/sign-up merge uses this, and only this id is ever merged (K-4). Never sets cookies. Cookie-store failures read as `null`; DB errors propagate (actions). |
| `readAuthToken(): Promise<string \| null>` | The raw `sf_auth` if it is 43 chars of base64url, else `null`. No DB access. Bearer credential: never log, render or return it. |
| `setAuthCookie(token, expiresAt): Promise<void>` | **Actions / Route Handlers only.** `httpOnly`, `sameSite: "lax"`, `path: "/"`, `maxAge` = seconds until `expiresAt` (rounded up, capped at 30 days), `secure` iff `NODE_ENV === "production"`. Throws `TypeError` for a malformed token or date and `RangeError` for a past expiry. Error messages never contain the token. |
| `clearAuthCookie(): Promise<void>` | **Actions only.** `set("sf_auth", "", { ...same flags, maxAge: 0 })`. |
| `rotateGuestSession(): Promise<string>` | **Actions only.** Writes a new v4 id to `sf_session` that always differs from the current value, and returns it. Used after sign-in/sign-up (fixation defence), sign-out and deletion. |
| `isSessionId(value): value is string` | UUID v4 guard, re-exported from `session-id.ts` (pure, no `next/*`). Pure modules should import it from `@/server/session/session-id`. |

Cookie attributes for both cookies: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production. `sf_session` has `Max-Age=2592000`. `sf_auth` gets its `Max-Age` from the session expiry, which is absolute: 30 days from issue, never extended (R-8).

## API: `current-user.ts`

| Export | Use |
|---|---|
| `CurrentUser` | `{ id, email, displayName }`. The only user shape allowed in components and HTML. It never has `ownerKey`, a hash or a token. |
| `readCurrentUser(): Promise<CurrentUser \| null>` | **Render-safe.** Returns `null` for guests and for invalid, expired, revoked or unknown tokens, and for tokens of deleted users. Never sets cookies and never throws an application error. Next control-flow errors are rethrown. |
| `requireUser(nextPath?): Promise<CurrentUser>` | **Pages/layouts.** Returns the user or throws `redirect("/signin?next=" + encodeURIComponent(safeNext(nextPath)))`. Do **not** call it in `generateMetadata`. Actions return `UNAUTHENTICATED` instead (AR4). |
| `readOwnerAndUser(): Promise<{ ownerKey: string \| null; user: CurrentUser \| null }>` | **Render-safe** (consistency at). The same pair as `readSessionId()` + `readCurrentUser()` but with ONE `sf_auth` lookup: a valid token gives the user and their owner key, otherwise the R-1 checked guest id. Never mints, rotates or clears a cookie; application errors read as "no cookie" / "not signed in"; Next control-flow errors are rethrown. `ownerKey` is server-only (R-1). Used by `src/app/account/_lib/context.ts`. |
| `readResolvedAuth(): Promise<{ user: User; authSessionId: string } \| null>` | **Server actions only.** The full `User`, including `ownerKey`, plus the auth session id, for sign-out, password change and similar. Never pass it to a component, action state or log. |
| `SIGN_IN_PATH` | `"/signin"` |

## API: `safe-next.ts` (pure)

`safeNext(raw: unknown, fallback = "/account"): string` returns `raw` only if it is a same-origin path, and `fallback` otherwise. The path must:

- be at most 512 chars;
- start with exactly one `/` (not `//` or `/\`);
- use only the chars `A-Za-z0-9/_-.~%?=&#`, so no scheme, backslash, whitespace, control or non-ASCII chars;
- still pass after one `decodeURIComponent`: no `//` or `/\` prefix, no backslash, no control chars, no leftover `%2F%2F` or `%5C`;
- have no malformed escapes.

Example: `/%2F/evil.com` returns the fallback.

## Database access

`session.ts` and `current-user.ts` import `@/server/auth/*` and `@/server/db/client` **lazily**, with `await import(...)` inside the functions. Importing them never opens the DB, and neither does resolving a request with no cookies, a malformed guest cookie, or a malformed `sf_auth`. The DB is opened only when a well-formed cookie is present: `sf_auth` goes to `getAuthService().resolveToken`, which binds only the SHA-256 of the token, and a guest id goes to the single R-1 `findUserByOwnerKey` lookup. This is T119 AC8 as relaxed by R-1.

## Design notes for callers

- Read paths (pages, header) call `readSessionId()` and treat `null` as "nothing yet". They never create a session.
- Mutating actions call `getOrCreateSessionId()` **once** and pass the id down. Parallel calls in one cookie-less request each mint a different id, and the last `set` wins.
- Sign-in/sign-up (T120), in order: `getOrCreateSessionId()` before rate limiting (R-3), `readGuestSessionId()` for the merge, `setAuthCookie(token, expiresAt)`, `rotateGuestSession()`.
- Sign-out: `clearAuthCookie()` and `rotateGuestSession()`.
- Only ids returned by these functions, or ones that pass `isSessionId`, reach repositories. Use bound SQL parameters anyway.

No middleware or proxy file is used.

## Tests

- `session.test.ts` covers the T08 tests, which are unchanged, plus PLAN.md 2a rows C-01..C-19 for `readSessionId`/`getOrCreateSessionId`/"DB opened?", and the cookie attributes of the 2b helpers. Auth fixtures are created through `createAuthRepository` with `token_hash = sha256(token)` and resolved by the real `getAuthService()`.
- `current-user.test.ts` covers the `readCurrentUser`/`requireUser` columns of C-01..C-19, `readResolvedAuth`, the `next` handling, and `readOwnerAndUser` (equal to the two separate helpers for every cookie case, one `resolveToken` call, no cookie writes).
- `safe-next.test.ts` covers the PLAN.md 3.7 hostile and safe sets.

Each file mocks `next/headers` with `mock.module` and a fake cookie store that records `set` calls. `current-user.test.ts` also mocks `next/navigation`: it spreads the real module and replaces `redirect` with a sentinel. Bun's `mock.restore()` does not undo `mock.module`, so every file registers its own mocks before importing the module under test.

Any test that resolves a valid guest or auth cookie opens the shared DB. It must set `process.env.DATABASE_PATH = ":memory:"` before importing, otherwise `./data/storefront.sqlite` is created.
