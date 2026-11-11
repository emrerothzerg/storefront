# `src/app/_layout`: root layout helpers (T20, T80, T148)

Private folder (the leading `_` keeps it out of routing). Holds the pieces used by `src/app/layout.tsx`.

| File | What |
|---|---|
| `HeaderShell.tsx` | Async Server Component (T80, v3 T148). Calls `loadHeaderData` with the production readers and renders `<SiteHeader>` with `SITE_NAME`, departments (search + mobile drawer), popular searches, the account state (signed-in users get `signOutAction={headerSignOut}`), `HEADER_UTILITY_LINKS` (Lists `/lists`), `categoryNav={DEPARTMENT_NAV}` with `categoryNavLeading={HEADER_CATEGORY_LEADING}` (Deals → `/deals`, first in the Primary row) and `benefits` from `buildHeaderBenefits`. The header SearchBox has no department select. No Shop row, no promo strip (the coupon is a benefits item). |
| `header-data.ts` | `loadHeaderData(deps)`: runs `readSessionId()` and `readCurrentUser()` in parallel first, then the cart totals (only when there is a session), `categoryTree()`, `listPromoted()` and `listShippingMethods()` (optional dep). Returns `{ cartCount, user: { displayName } \| null, departments, popularSearches (first 5 department names), promoCoupon, freeShippingThresholdCents }`. `freeShippingThreshold(methods)`: lowest positive safe-integer `freeOverCents` among active methods, else `null`. |
| `header-benefits.ts` | `buildHeaderBenefits({ freeShippingThresholdCents, currency, coupon, content? })` → `{ label, items }` for the header benefits strip: free shipping (only with a threshold; "$35" formatting via `formatThreshold`), the static items from `src/content/header-benefits.ts`, then "Use code CODE for …" when a coupon is promoted. Missing/blank/malformed content parts fall back to `HEADER_BENEFITS_FALLBACK`. |
| `header-actions.ts` | `'use server'`: `headerSignOut(formData)`, the header's Sign out form action. It is a thin wrapper over `signOut` from `src/app/actions/auth.ts`. |
| `header-sign-out-core.ts` | `runHeaderSignOut(formData, load?)`: lazily imports `auth.ts` at submit time and calls `signOut(null, formData)`. The redirect and any error propagate. The lazy import keeps the root layout's import graph free of `auth.ts`, which imports `headers` from `next/headers` at module scope. Without it, suites that mock `next/headers` with only `cookies` (e.g. `tests/app/seo-metadata.qa.test.tsx`) failed to import the layout. |
| `cart-count.ts` | Pure `resolveHeaderCartCount(totals)`: `null`/`undefined`, non-finite or negative → `0`; fractional values are floored. |

## Data flow and failure handling

```
layout.tsx → <ToastProvider> → <HeaderShell/> → loadHeaderData({
  readSessionId, readCurrentUser,              // request scope, read-only, never set cookies (SR10)
  getCartTotals: getCartService().getTotals,   // skipped when readSessionId() is null
  categoryTree: getListingService().categoryTree,
  listPromoted: getCouponService().listPromoted,
  listShippingMethods: getShippingService().listMethods(0) → methods,
}) → buildHeaderBenefits(...) → <SiteHeader .../>
```

- The request-scoped reads come first, so a build-time prerender aborts at `cookies()` before any database read.
- `readSessionId()` and `readCurrentUser()` are guarded as well (their cookie lookup can hit the database): `unstable_rethrow` first, then an application error falls back to a guest header (no session → 0 items, no user) and is logged once per reader per process (`[HeaderShell] failed to read session|user`) with only `{ name }` (no message, stack or cookie data).
- Each database read is wrapped in its own try/catch. `unstable_rethrow(error)` comes first, so Next control-flow errors propagate. Application errors are logged once per reader per process (`[HeaderShell] failed to read <reader>`) and replaced by `0` items, `[]` departments, no coupon or no free-shipping threshold (the benefit is then omitted; the amount is never hardcoded).
- Only `displayName` leaves the loader. The user id, email and owner key never reach props or HTML.
- Guests without cookies now cause three small reads per request (`categoryTree`, `listPromoted`, `listShippingMethods`, the last added by T148). Before T80 the header touched the database only when a session cookie was present.

## Rendering model: dynamic SSR, no PPR

- `next.config.ts` has `cacheComponents: false` and no `partialPrefetching`. PPR was turned off because it flushed a 200 shell before `notFound()`/`redirect()` ran, which produced soft 404s and meta-refresh "redirects", and it hid content from no-JS clients.
- The root layout renders `<HeaderShell />` directly inside `<ToastProvider>`, with no `<Suspense>`, no fallback and no `"use cache"`. It reads cookies, so every route is dynamically server-rendered per request (`ƒ` in the build table). `layout.test.tsx` asserts that there is no Suspense element and no root `loading.tsx`.
- `ToastProvider` (client) wraps the header, `<main id="main" tabIndex={-1}>` and the footer. It renders the single "Notifications" toast viewport after them. Server children inside it still render on the server.
- `<SiteFooter storeName={SITE_NAME} columns={FOOTER_COLUMNS} />` is rendered directly. The P2-S `metadata` export and the Organization + WebSite `<JsonLd>` (after the provider) appear exactly once.
- Never call `getOrCreateSessionId()` from render. Only Server Actions may set the cookie.

## `currentPath` is not passed

Layouts do not re-render on navigation and cannot read the pathname on the server. Nothing gets `aria-current` from the layout (CategoryNav included; `SiteHeader` would derive the department from `currentPath` if a caller passed it). The account flyout and the department drawer close themselves when one of their links is clicked.

## Error / not-found / loading

- `error.tsx` (client): generic copy only, logs `error.digest` only. "Try again" calls `retry()`.
- Initial responses carry the real status: a thrown server error gives 500 (production HTML has no message or stack).
- `not-found.tsx`: unknown URLs return HTTP 404 with the styled page.
- There is deliberately **no root `loading.tsx`** (SR8): it wraps every page in Suspense, so the response streams 200 before `notFound()`/`redirect()` run.
