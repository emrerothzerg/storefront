# Phase 3 redesign: QA plan (T133)

Owner: qa-engineer. App root: `storefront/`. Inputs: `BACKLOG-phase3.md` (R1–R11, inventory, section 4), `STATE.md` PHASE 3, `design-reference/*.png`, `tests/redesign/CONTRACTS.md` (T134).

## Memory rule (binding for every agent)

Never run the full suite (`bun test`, `bun run test`, `bun run test:raw`); the orchestrator runs `bun run test` (sharded) alone. Agents run only the commands in the "Run" column below, plus `bun run typecheck`, `bun run lint`, `bun run check:tokens`. No `next build`/`next dev` before T175.

## Files

| File | Task | Purpose |
|---|---|---|
| `tests/redesign/PLAN.md` | T133 | this plan |
| `tests/redesign/guards.test.ts` | T133, activated by T174 | brand-free and light-only guards |
| `tests/redesign/CONTRACTS.md` | T134 | markup contracts for home, listing, PDP (one row = one test) |
| `tests/redesign/atoms-molecules.test.tsx` | T147 | tokens, atoms, molecules |
| `tests/redesign/home-organisms.test.tsx` | T163 | header, footer, home organisms |
| `tests/redesign/listing-pdp-organisms.test.tsx` | T164 | listing, PDP, checkout organisms |
| `tests/redesign/pages-home-listing.test.tsx` | T172 | home, listing, search pages (CONTRACTS H, L, G) |
| `tests/redesign/pages-pdp-cart.test.tsx` | T173 | PDP, cart, checkout, account (CONTRACTS P, G) |
| `tests/redesign/audit.test.tsx` | T174 | whole-app audit as tests (replaces the planned `AUDIT.md`; results are rows A-1…A-15 in `CONTRACTS.md`) |
| `tests/redesign/SMOKE.md` | T175 | build + HTTP smoke results |

## Guards (`guards.test.ts`)

Run: `bun test tests/redesign/guards.test.ts` (about 0.5 s, one process, files streamed line by line).
Status report with the pending list ignored: `REDESIGN_GUARDS_ALL=1 bun test tests/redesign/guards.test.ts`.

The only skip mechanism is the `PENDING_UNTIL_T174` array at the top of the file (guards listed there are registered with `test.skipIf` and show as "skip"). **T174: the list is empty and all twelve guards are active and pass** (plus self-tests: scan reaches colocated tests, SVGs, READMEs and globals.css; no stale negative-grep exemption; red window 335–20). No `.skip` anywhere else.

| Guard | Checks | Fixed by | State at T133 |
|---|---|---|---|
| G01-no-retailer-brand-strings | `src/**`, `public/**` text files (colocated tests, READMEs, CSS and SVGs included): case-insensitive `kmart`, `onepass`, `anko` (with a non-letter before it), `afterpay`, `zip pay`; failure lists `file:line [pattern] text` | T154, T165, SEED-EXPAND, all | active, passes |
| G02-light-only-strings | same scan: `dark:`, `prefers-color-scheme`, `data-theme`, `color-scheme: light dark` (exact case); rule-stating prose tolerated (see Deviations) | T130, T146, T149, T171 | active, passes |
| G03-brand-site-constant | `SITE_NAME` = "Northwind Goods"; `SITE_DESCRIPTION` contains it | T149 | active, passes |
| G04-brand-metadata | root layout `metadata.title.default`, title template, `applicationName`, `openGraph.siteName` | T149 | active, passes |
| G05-brand-header | `render(await HeaderShell())` (unseeded in-memory DB): banner has a link `href="/"` whose text contains the brand | T148 | active, passes |
| G06-brand-footer | `SiteFooter` element from the root layout tree, rendered: contentinfo text contains the brand and not "Storefront" | T150 | active, passes |
| G07-brand-manifest | `manifest().name` = brand, `short_name` starts with "Northwind" | T149 | active, passes |
| G08-theme-color-matches-primary | `manifest().theme_color` (and `viewport.themeColor` when exported, must be one string) equals the documented primary raw value | T149 | **pending**, fails |
| G09-brand-jsonld-organization | `organizationJsonLd().name` and the Organization (and WebSite) objects in the root layout's JsonLd | T149 | active, passes |
| G10-primary-hue-not-red | primary hue outside 335–20 deg (T174 widened it from 345–20; `RED_WINDOW` in the file). The primary is the colour role the atoms README documents in its "Primary …" table row (`bg-<role>`), resolved through `@theme` `--color-<role>: var(--raw)` to the raw value in the top-level `:root` of `globals.css`; hex, rgb, hsl, oklch, oklab parsed. The failure message prints role, raw token, raw value, rgb and hue | T130 | active, passes |
| G11-primary-hue-not-reference | primary hue ≥ 30 deg from the reference teal (170) and purple (270) (T130 AC4, R2) | T130 | active, **fails** (defect, see hand-off) |
| G12-color-scheme-light-only | every `color-scheme` declaration in `globals.css` (comments stripped) is exactly `light`, at least one exists | T130 | active, passes |

Self-tests (always active): colour parser and hue maths, README role parser, `:root` parser ignores `@media` and comments, scan of temp fixtures (line numbers, tolerance, binary cut-off), pattern boundaries.

Reference hues were measured from `design-reference/home-reference.png`: dominant 5-degree bins of saturated pixels (chroma, max minus min channel, ≥ 0.35 and max channel ≥ 0.3) were red/pink 340–355, magenta 320, purple 270 (membership strip), teal 170 (service band). The PNG decoder used is a scratch script, not part of the repo.

## Checks by owner task

"Run" is the narrowest command that covers the check. Implementers run their own colocated files; QA runs `tests/redesign/<file>`.

| Check | Owner | Verified by | Run |
|---|---|---|---|
| Light-only tokens, `color-scheme: light`, no dark block | T130 | G02, G12, `src/app/globals.test.ts` | `bun test src/app/globals.test.ts tests/redesign/guards.test.ts` |
| Contrast table recomputed from raw values | T130, T147 | `atoms-molecules.test.tsx` | `bun test tests/redesign/atoms-molecules.test.tsx` |
| Primary hue window and reference distance | T130 | G10, G11 | `bun test tests/redesign/guards.test.ts` |
| New tokens (radius-card, radius-pill, band-*, price-sale, badge-*) with on-colours | T130 | T130 test, T147 | `bun test src/app/globals.test.ts` |
| Atom variants: Button compact/44px, Price superscript + accessible "$12.50", Badge text, Tabs link mode, ScrollRail no-JS | T131, T147 | atom tests, T147 matrix | `bun test src/components/atoms tests/redesign/atoms-molecules.test.tsx` |
| StoreBadge / PaymentMark non-interactive, no trademarks | T132, T163 | atom tests, T163 | `bun test src/components/atoms/StoreBadge src/components/atoms/PaymentMark` |
| Placeholder art manifest, viewBox, no script/href/text, < 40 KB | T136 | `src/content/home-art.test.ts`, G01 | `bun test src/content/home-art.test.ts` |
| Seed: ≥ 4 per department, ≥ 12 deals, ≥ 10 new, ≥ 8 rated 4.5+, low/out of stock, no retailer names | SEED-EXPAND | seed tests, G01 | `bun test src/server/db` |
| `cardBadges`, quick-add sibling form, SR9 | T137, T147 | colocated, T147 | `bun test src/components/molecules/ProductCard` |
| CategoryTile, HeroBanner carousel, Benefits/ServiceTiles, PromoTile/Strip/LifestyleCard, ChipRow/FeedbackBlock, SearchBox/CategoryNav | T138–T143, T147 | colocated, T147 | `bun test src/components/molecules/<Name>` |
| PDP molecules (gallery, buy-box pieces) | T144, T145 | colocated | `bun test src/components/molecules/<Name>` |
| Remaining molecules light pass | T146 | colocated, G02 | `bun test src/components/molecules` (per folder if memory is tight) |
| Header v3 (G-1…G-13), footer v3 (G-14…G-16) | T148, T150, T163 | colocated, `home-organisms.test.tsx`, G05, G06 | `bun test src/components/organisms/SiteHeader src/app/_layout tests/redesign/home-organisms.test.tsx` |
| Layout/manifest light cleanup, single theme colour | T149 | `layout.test.tsx`, `manifest.test.ts`, G04, G07, G08, G09 | `bun test src/app/layout.test.tsx src/app/manifest.test.ts tests/redesign/guards.test.ts` |
| Home organisms (hero, rails, tabs, lifestyle, services) | T151–T155, T163 | colocated, T163 | `bun test tests/redesign/home-organisms.test.tsx` |
| `placePromos`, filter panel, ListingTemplate slots, BuyBox saving, cart/checkout failure states | T156–T162, T164 | colocated, T164 | `bun test tests/redesign/listing-pdp-organisms.test.tsx` |
| Home content and loader (copy guard, hrefs, rail validation, isolation) | T165 | `src/content/home.test.ts`, `src/app/_lib/home.test.ts`, G01 | `bun test src/content src/app/_lib/home.test.ts` |
| Home page contract (CONTRACTS H) | T166, T172 | `src/app/page.test.tsx`, `pages-home-listing.test.tsx` | `bun test src/app/page.test.tsx tests/redesign/pages-home-listing.test.tsx` |
| Listing and search pages (CONTRACTS L) | T167, T168, T172 | colocated, T172 | `bun test src/app/_listing src/app/search tests/redesign/pages-home-listing.test.tsx` |
| PDP (CONTRACTS P, reference pending) | T169, T173 | colocated, T173 | `bun test "src/app/products/[slug]" tests/redesign/pages-pdp-cart.test.tsx` |
| Cart, checkout, account, static pages light pass | T170, T171, T173 | colocated, T173, G02 | `bun test src/app/cart src/app/checkout tests/redesign/pages-pdp-cart.test.tsx` |
| Guards active with empty pending list; whole-app audit (brand-free, light-only, tokens, a11y basics, 320px markup) | T174 | `guards.test.ts`, `audit.test.tsx` (CONTRACTS A-1…A-15) | see "Final run commands" |
| Build, HTTP smoke, no-JS curl round trips | T175 | `SMOKE.md` | `bun run build` then curl (T175 only) |
| Tokens-only Tailwind (every task) | all | `check:tokens` | `bun run check:tokens` |
| Types and lint (every task) | all | tsc, eslint | `bun run typecheck && bun run lint` |

## Accessibility and responsive checks (QA tasks)

- Keyboard path for header (skip link first, search, account, cart), filter `details`, carousel dots, rail scroller (`tabindex="0"`), tabs as links: T163, T172, T174.
- Focus visibility: atoms never remove the outline (grep `outline-none` in changed files): T147, T174.
- Labels: every input has a label (SearchBox, filter form, quantity): T147, T164.
- 44px targets: `min-h-touch`/`size-touch` on interactive atoms and links in footer/chips: T147, T163, T174.
- 320px: no fixed widths without breakpoint prefix, rails scroll inside their container, grid never 1 column: markup review in T174 (no browser tooling approved).
- Contrast: computed from raw values (T147); spot-checked in T174.

## Deviations from the T133 text (decided here, flagged in the hand-off)

1. `anko` is matched only when not preceded by a letter. Plain substring matching hits identifiers in current code (`rankOf` in `src/server/catalog/listing-service.ts:264-267`). Covered by a self-test.
2. Light-only strings are tolerated on Markdown lines and CSS comment lines that also contain a negation (`no`, `not`, `never`, `without`, `do not`, `banned`, `forbidden`, `removed`). This lets `globals.css` and the atoms README state the light-only rule (T130 header, T131 AC8) as the designer has already written it. Retailer brand strings are never tolerated.
3. Colocated tests that the backlog requires to contain forbidden strings as negative greps are exempt. **T174 narrowed the list to `src/components/atoms/tokens.phase3.test.ts`** (T130 AC6); `globals.test.*` does not exist and the StoreBadge/PaymentMark tests no longer carry literals, so those exemptions were dropped. A guard self-test fails when an exemption becomes stale. If the designer builds those strings at run time, delete the last exemption.
4. Extra guards beyond the T133 text: G08 (theme colour = primary, T149 AC1), G11 (reference-hue distance, T130 AC4), G12 (`color-scheme` exactly `light`, T130 AC1).

## Final run commands (T174)

Agents never run the whole tree (memory rule). These are the QA-owned redesign checks; each command is one watchdogged process.

```sh
cd storefront
# guards + audit + the two (cj) QA files (about 5 s, peak about 450 MB)
bun run test --max-rss=1500 tests/redesign tests/components/organisms/phase2-home-sections.qa.test.tsx tests/components/organisms/phase3-home.qa.test.tsx
# guards only, every guard forced on (status report)
REDESIGN_GUARDS_ALL=1 bun test tests/redesign/guards.test.ts
# gates
bun run typecheck && bun run lint && bun run check:tokens
```

The orchestrator's sharded full run (`bun run test`) picks up `tests/redesign/*.test.ts(x)` with everything else. Defects found by the audit are `test.failing` pins tagged `// PIN: D-T174-n` at the bottom of `audit.test.tsx`; the owner flips `test.failing` to `test` in the same change as the fix (and removes the matching entry from the `known` filter in the scroll-row test / `KNOWN_COPY_HIT`).

## Browser-only checks (Playwright list, not runnable here: no browser tooling approved)

Markup cannot prove these; they need a real layout engine. Each names the task whose output it checks.

1. **No horizontal page scroll** at 320, 360 and 480 px on every audited page (`document.documentElement.scrollWidth <= innerWidth`); especially home rails, the hero carousel, the header row (wordmark + search + actions), checkout card fields (T156, T148, T139, T161).
2. **Drawer at 320 px**: `w-80` panel equals the viewport; close button reachable; no body scroll behind (T30/T79, T143 DepartmentMenu, T157 filter drawer).
3. **CategoryNav "More" popover** (`w-64`, absolute `end-0`) stays inside the viewport at 320 px and above the benefits strip (T143).
4. **Focus ring visibility**: Tab through every scroll row (CategoryNav, top-picks tabs, category/product rails, benefits strip, chip rows, PDP thumbnails) and confirm the 2px + 2px ring is not clipped (D-T174-1/2 fixes, D-T143-1).
5. **Keyboard path**: skip link → wordmark → search → account → lists → cart → CategoryNav; filter `details` opens with Enter/Space, Escape closes and returns focus; carousel dot links move the slide; rails scroll with arrow keys when the scroller has focus; top-picks tab links keep scroll position (`scroll={false}`) (T148, T157, T139, T153).
6. **Filter panel**: Drawer below 1024 px, inline `details` from `lg`; resize across 1024 px with the panel open; cancelled summary click; overlay stacking over the sticky header (T157).
7. **Sticky buy box** (PDP, `lg+`): focused controls below it are not hidden (`scroll-margin`), and it never covers the reviews anchor target (T159/T169, P-14, reference pending).
8. **Touch targets measured**: bounding boxes ≥ 44×44 for buttons, pills, nav links, checkbox/radio rows, carousel dots (T131, T139, T150).
9. **Contrast in context**: focus ring on the gold promo band (3.10:1), deal text on sunken tiles (4.73:1), white ring inside the accent band, text over hero art (T130, T132, T139).
10. **Images**: no layout shift (CLS) from product/hero art; first hero slide eager, others lazy; `sizes` 50vw below 480 px (T137, T139).
11. **Reduced motion**: carousel `scroll-smooth` and card hover transitions disabled under `prefers-reduced-motion` (T139).
12. **No-JS round trips** (curl or JS-disabled browser): quick-add form, filter GET form, sort, pagination, top-picks tabs, search, sign-in (T175 smoke covers status codes; these cover behaviour).
13. **PDP against the real reference** once the human supplies it (CONTRACTS P rows, all "reference pending").
