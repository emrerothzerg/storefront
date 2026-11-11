# tests/components/molecules (QA)

Independent QA suite for the molecules layer and site chrome (T14 ProductCard/StockBadge,
T15 AddToCartForm/CartLineItem/cart action contract, T16 AddressFields/PaymentFields/SummaryRow,
T17 SiteHeader/SiteFooter). Owner: QA. The colocated tests in `src/components/**` belong to the
implementers; these files re-check the acceptance criteria adversarially and do not import them.

| File | Covers |
| --- | --- |
| `product-card.qa.test.tsx` | T14: one interactive element per card across 300-char name, emoji/reserved-char slug (`encodeURIComponent` href), `imageUrl: ""`, stock 0/1/5/6/-1/NaN; StockBadge threshold table; clamp/wrap classes; placeholder; tokens-only rendered output. |
| `cart.qa.test.tsx` | T15: pending/double-click (gated promise, released in `finally`), every `ERROR_CODES` value -> `role="alert"`, polite success region, stock clamp 5->2, stock 0/-3/NaN, exact FormData keys; CartLineItem Remove name, line total vs `formatMoney`, unavailable/reduced, both forms' payloads, keyboard. |
| `checkout-fields.qa.test.tsx` | T16: label/`autocomplete`/`inputmode`/`type` per control, real `validateAddress({})` + `validateCard(...)` errors linked by `aria-describedby` and adjacent, name/id uniqueness across both fieldsets, smuggled card `defaultValues` not rendered, test-mode notice vs `MOCK_CARDS`; SummaryRow dl structure. |
| `../organisms/site-chrome.qa.test.tsx` | T17: skip link first focusable + `#main` target, cart name for 0/1/3/99/100/150/-1/2.5/NaN/Infinity, landmarks, 320px class audit, footer. |

Conventions

- Defect reproductions use `test.failing(...)` (names start with `DEFECT:`) so the suite stays
  green, with a sibling "evidence" test pinning the wrong output. On a fix, drop `.failing`,
  rename to `Dn (fixed): ...` and replace the evidence test. Fixed so far: D1 (AddToCartForm
  NaN stock), D2 (CartLineItem update success not announced). No open `test.failing` cases.
- "documents behaviour" tests pin questionable-but-allowed behaviour.
- Cart actions: React 19 entangles pending async actions across tests, so every gated action is
  released in `finally` (including actions React queued behind the first one).
- happy-dom: keyboard is checked as native controls + stepper key handling + `fireEvent.submit`.

Run: `bun test tests/components/molecules tests/components/organisms`
