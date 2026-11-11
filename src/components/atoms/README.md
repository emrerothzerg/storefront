# atoms

Smallest reusable UI building blocks (Button, Input, Price, Badge, Icon...). Pure presentational components with no data fetching and no knowledge of business domain; styled with Tailwind and individually unit-tested. Owner: designer-technologist.

## Light mode only

**Light mode only (Phase 3 ruling, 2026-11-08).** There is no dark theme: no `prefers-color-scheme` block, no `data-theme` attribute, no theme toggle, and no `dark:` utilities anywhere in atoms, molecules, organisms or pages. `:root` sets `color-scheme: light` so native controls stay light. `tokens.phase3.test.ts` guards this.

## Using design tokens

All tokens live in `src/app/globals.css` (the comment header there is the full token list with contrast ratios). Atoms consume them **only through Tailwind utilities**.

### Rules

1. **Tailwind token utilities only.** No inline `style={{ ... }}` for colour, spacing, type, radius, shadow or z-index.
2. **No arbitrary values.** `bg-[#fff]`, `p-[13px]`, `w-[calc(...)]`, `[mask-type:luminance]` are banned. If a value is missing, ask the designer-technologist to add a token; don't work around it.
3. **No raw hex colours in TS/TSX**, not even in props, constants or SVGs. SVG icons use `fill-current` / `stroke-current` and inherit the text colour.
4. **No Tailwind palette colours.** The default palette (`bg-gray-100`, `text-blue-600`...) is removed and generates nothing. Same for default radii and shadows.
5. `bun run check:tokens` enforces rules 2 and 3 over `src/components` and `src/app`. Run it before handing off.

### Which utility for which role

| Role | Utilities |
| --- | --- |
| Page background | `bg-surface-page` (already on `<body>`) |
| Card / popover / input background | `bg-surface-raised` |
| Well, stripe, inset area | `bg-surface-sunken` |
| Light-grey section band, image tile | `bg-surface-sunken` |
| Inverse band (footer, toast) | `bg-surface-inverse` + `text-text-inverse` |
| Promotional panel (bold) | `bg-promo` (gold) + `text-text-primary` (or `Card tone="promo"`); actions inside use primary Button/Link. Never `text-promo` or white text on it |
| Promotional panel (soft) | `bg-promo-subtle` / `bg-accent-subtle` / `bg-deal-subtle` + `text-text-primary` |
| Deal / sale price, deal badge | `text-deal` (price), `bg-deal text-text-on-accent` (solid badge), `bg-deal-subtle text-deal` (tint) |
| Body text, headings | `text-text-primary` (inherited from `<body>`) |
| Muted / helper text | `text-text-secondary` |
| Text on any solid fill (accent, deal or status) | `text-text-on-accent` (on the gold `bg-promo` fill use `text-text-primary`) |
| Primary action | `bg-accent hover:bg-accent-hover active:bg-accent-active text-text-on-accent` |
| Link / accent text | `text-accent` (plus `underline`; colour alone is not enough) |
| Accent tint | `bg-accent-subtle` with `text-accent` or `text-text-primary` |
| Status message | `bg-danger-subtle text-danger` (same for `success`, `warning`, `info`) |
| Solid status fill | `bg-danger text-text-on-accent` (same for the others) |
| Solid status fill hover | `hover:bg-danger-hover` / `hover:bg-success-hover` (keep `text-text-on-accent`) |
| Rating stars | `text-rating` (stars only; graphics token, AA on every surface; empty stars use the same colour as an outline) |
| Control boundary (input, checkbox, outline button) | `border border-border-strong` |
| Decorative divider only | `border-border-default` / `divide-border-default` |
| Spacing | 4px scale: `p-1` = 4px, `p-2` = 8px, `p-3` = 12px, `p-4` = 16px... |
| Type | `text-caption`, `text-small`, `text-body`, `text-h4`, `text-h3`, `text-h2`, `text-h1` (use `md:text-h1-lg` from md up). Each sets size, line height and heading weight together. Don't use `text-xs`...`text-9xl` in atoms. |
| Fonts | `font-sans` (default), `font-mono` (SKUs, codes) |
| Radius | `rounded-full` (buttons, chips, search field, category circles), `rounded-sm` (square badges), `rounded-md` (inputs, thumbnails, menus), `rounded-lg` (cards, image tiles), `rounded-xl` (dialogs, promo panels) |
| Elevation | `shadow-sm` (resting card), `shadow-md` (card hover lift, dropdown), `shadow-lg` (dialog) |
| Price type | `text-price` (24px bold), `text-price-lg` (36px bold); normally via `Price display="superscript"` |
| Stacking | `z-base`, `z-raised`, `z-dropdown`, `z-sticky`, `z-overlay`, `z-modal`, `z-toast`. Never use a bare `z-50`. |
| Breakpoints | mobile-first `xs:` 480, `sm:` 640, `md:` 768, `lg:` 1024, `xl:` 1280, `rail:` 1360 (ScrollRail gutter only), `2xl:` 1536 |

### Palette (token → value)

No token was renamed in Phase 3; every MVP/Phase 2 name keeps working. New: `promo`, `promo-hover`, `promo-subtle`, `deal`, `deal-subtle`, `focus-ring-inverse`, `text-price`, `text-price-lg`.

| Token | Value | Role |
| --- | --- | --- |
| `surface-page` | #ffffff | page (white) |
| `surface-raised` | #ffffff | cards, inputs, popovers |
| `surface-sunken` | #f4f4f5 | light-grey bands, image tiles |
| `surface-inverse` | #18181b | footer, toast |
| `text-primary` | #18181b | near-black text |
| `text-secondary` | #52525b | muted text |
| `text-inverse` | #ffffff | text on inverse / promo / accent |
| `text-on-accent` | #ffffff | text on solid fills |
| `border-default` | #e4e4e7 | soft card borders, dividers |
| `border-strong` | #71717a | control boundaries |
| `accent` / `-hover` / `-active` / `-subtle` | #1d4ed8 / #1e40af / #1e3a8a / #eff6ff | primary (vivid blue, hue 224) |
| `promo` / `-hover` / `-subtle` | #fbbf24 / #f59e0b / #fef3c7 | promotional accent (gold, hue 43; dark text on it) |
| `deal` / `-subtle` | #b94a00 / #fff7ed | price / deal accent (warm orange, hue 24; white text on it) |
| `danger` / `-hover` / `-subtle` | #b91c1c / #991b1b / #fef2f2 | errors |
| `success` / `-hover` / `-subtle` | #15803d / #166534 / #f0fdf4 | success |
| `warning` / `-subtle` | #a14d07 / #fffbeb | warning |
| `info` / `-subtle` | #0369a1 / #f0f9ff | info |
| `rating` | #b45309 | stars |
| `skeleton` | #d4d4d8 | loading placeholders |
| `focus-ring` | #2563eb | keyboard focus ring |
| `focus-ring-inverse` | #ffffff | focus ring inside dark inverse bands (automatic) |
| `scrim` | rgb(24 24 27 / 0.6) | modal backdrop |

**Brand-distance rule (ruling D-T130-1, guarded by `tests/redesign/guards.test.ts` G10/G11 and `tokens.phase3.test.ts`):** the primary, promo and deal hues stay at least 30° from the reference retailer's teal (~170°) and purple (~270°) and outside its red window (345°–20°). Check this before changing any of them.

### Backlog token names (T130 AC5) → shipped roles

`BACKLOG-phase3.md` T130 AC5 names nine tokens. They shipped as role tokens/utilities under existing naming; there is no `radius-card` or `badge-new` CSS variable. Use the right-hand column.

| Backlog name | Shipped as | Ready-made | On-colour (ratio) |
| --- | --- | --- | --- |
| `radius-card` | `rounded-lg` (12px); `rounded-xl` (16px) for promo panels and dialogs | `Card radius="lg"` / `"xl"` | n/a |
| `radius-pill` | `rounded-full` | Button, Chip, `Badge shape="pill"`, `StoreBadge` | n/a |
| `band-primary` | `bg-accent` + `text-text-on-accent` (white ring inside) | `Card tone="accent"` | 6.70 |
| `band-primary-subtle` | `bg-accent-subtle` + `text-text-primary` | `Card tone="accent-subtle"` | 16.28 |
| `band-neutral` | `bg-surface-sunken` + `text-text-primary` | `Card tone="sunken"` | 16.12 |
| `price-sale` | `text-deal` | `Price tone="deal"` | 5.19 page / 4.73 sunken |
| `badge-sale` | `bg-deal` + `text-text-on-accent` | `BADGE_PRESETS.deal` | 5.19 |
| `badge-new` | `bg-promo` + `text-text-primary` (gold) | `BADGE_PRESETS.new` | 10.61 |
| `badge-top` | `bg-surface-inverse` + `text-text-inverse` | `BADGE_PRESETS.highlight` | 17.72 |

The bold promotional (secondary accent) band is `bg-promo` (`Card tone="promo"`, near-black text 10.61).

### Contrast (WCAG 2.x, computed; full list in the globals.css header)

| Foreground | Background | Ratio | Min |
| --- | --- | --- | --- |
| text-primary | page / raised / sunken | 17.72 / 17.72 / 16.12 | 4.5 |
| text-secondary | page / raised / sunken | 7.73 / 7.73 / 7.03 | 4.5 |
| accent (links) | page / raised / sunken | 6.70 / 6.70 / 6.10 | 4.5 |
| deal text (sale price) | page / raised / sunken | 5.19 / 5.19 / 4.73 | 4.5 |
| danger / success / warning / info text | page | 6.47 / 5.02 / 5.87 / 5.93 | 4.5 |
| text-on-accent | accent / hover / active | 6.70 / 8.72 / 10.36 | 4.5 |
| text-on-accent | deal | 5.19 | 4.5 |
| text-on-accent | danger / success / warning / info | 6.47 / 5.02 / 5.87 / 5.93 | 4.5 |
| text-primary | promo / promo-hover (gold) | 10.61 / 8.25 | 4.5 |
| text-secondary | promo (not promo-hover: 3.60) | 4.63 | 4.5 |
| accent fill (primary button) | promo / promo-hover band | 4.01 / 3.12 | 3 |
| text-inverse | surface-inverse | 17.72 | 4.5 |
| accent / deal on own tint | `*-subtle` | 6.16 / 4.89 | 4.5 |
| text-primary | any `*-subtle` tint | 15.91 – 17.08 | 4.5 |
| text-primary | border-default (filled Chip hover) | 13.96 | 4.5 |
| border-strong | page / raised / sunken | 4.83 / 4.83 / 4.40 | 3 |
| focus-ring | page / raised / sunken / inverse / promo | 5.17 / 5.17 / 4.70 / 3.43 / 3.10 | 3 |
| focus-ring-inverse | inverse / accent (dark bands, `Card tone="accent"`) | 17.72 / 6.70 | 3 |
| focus-ring | accent-subtle (FeedbackBlock band) | 4.75 | 3 |
| StoreBadge, PaymentMark text | `surface-raised` (own fill) | 17.72 | 4.5 |
| border-strong (StoreBadge / PaymentMark edge) | raised / sunken | 4.83 / 4.40 | 3 |
| rating | page / raised / sunken | 5.02 / 5.02 / 4.57 | 3 |
| accent fill | surface-inverse (hover / active) | 2.64 (2.03 / 1.71) | 3 — fails: use `inverse` buttons or `ring-2 ring-text-inverse` |

Only the text/surface pairs in the `globals.css` header are verified for contrast. Don't invent new pairs (for example `text-text-secondary` on a status tint or `text-warning` on `bg-info-subtle`). Ask for them to be checked and added first.

Every atom has to work at a **320px** viewport. Don't set fixed widths without a breakpoint prefix; let content wrap.

## Focus ring convention

- The base layer gives every element a keyboard focus ring: `:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px }`. It meets 3:1 against every surface and tint. Inside a `bg-surface-inverse` element the base layer switches it to `--focus-ring-inverse` (white) automatically, so nothing extra is needed on dark bands; the gold `bg-promo` band keeps the blue ring (3.10) (avoid nesting a white card inside such a band; if you must, add `focus-visible:outline-focus-ring` on the controls in that card).
- `Card tone="accent"` (solid blue band) cannot rely on the base layer (the blue ring is 1.30:1 on blue), so the card carries `**:focus-visible:outline-focus-ring-inverse`: every focused descendant gets the white ring (6.70:1). Put only `inverse` Buttons/Links and inverse text in it.
- Never set the ring **colour** with a utility on an atom (`focus-visible:outline-focus-ring`, `has-focus-visible:outline-focus-ring`): utilities beat the base `.bg-surface-inverse :focus-visible` rule and keep a blue ring on dark bands (D-T131-4). Width/offset utilities are fine. If the visible box is not the focused element (Rating stars), make the focused control itself cover the box (Rating's radios are transparent `appearance-none` layers over each 44px star) so the base rule draws the ring.
- `bg-accent-subtle` bands (e.g. the FeedbackBlock action strip) keep the default blue ring: `focus-ring` on `accent-subtle` is 4.75:1 (min 3), so a primary `Link variant="button"` or any control there needs no override. Same for every other `*-subtle` tint (4.64 – 4.98, see the globals.css header).
- Atoms **inherit** it. Don't write `outline-none`, `focus:outline-none` or `focus-visible:outline-none`, and don't swap it for a `ring-*` that has lower contrast.
- If an atom really needs a different shape (for example an inset ring inside a clipped container), use `focus-visible:outline-offset-0` or `focus-visible:outline-focus-ring` only. Keep the colour and the 2px width.
- Because of the 2px offset, the ring's neighbour is the surface around the control, not the control's own fill, so the ring is not (and need not be) 3:1 against solid fills (`bg-accent`, `bg-promo-hover`, `bg-deal`, status fills). Never use `focus-visible:outline-offset-0` on a solid fill.
- Use native interactive elements (`<button>`, `<a href>`, `<input>`) so focus and keyboard behaviour come for free. A custom widget must have `tabIndex={0}` and handle keys.

## Touch-target rule

Every interactive atom has a hit area of at least **44 x 44 px**. Use `min-h-touch min-w-touch` (or `size-touch` for icon-only buttons). If the visual element has to be smaller (a 20px checkbox, for example), keep the visual small and make the clickable wrapper or label `min-h-touch`. Icon-only controls also need an accessible name (`aria-label`).

## Motion

Under `prefers-reduced-motion: reduce` the base layer cuts every transition and animation to about 0ms. Don't depend on `transitionend` / `animationend` for logic. If motion is essential, discuss it first.

## Landmark rule

Every landmark an atom renders has an accessible name, and two landmarks of the same role on one page need different names. `SearchField` (`role="search"`) is always named: `landmarkLabel` if given, otherwise "Site search" (the header's default); an explicit `aria-label` / `aria-labelledby` on the form wins. The landmark name never comes from the field `label`, so the input stays the only element labelled by it. Any search form other than the header's must pass its own `landmarkLabel` (`/help` "Help", `/orders` "Search orders", the 404 page's search), otherwise it duplicates "Site search". The same applies to named regions (`ScrollRail`, `Table` scroll region): pass a `label` that is unique on the page.

## Atom inventory

Import path is `@/components/atoms/<Folder>`. Every atom takes `className` (merged last) and `ref` as a prop (React 19). **Runtime:** "server" means no `"use client"` (it renders in server components with zero client JS). "client" means `"use client"`: server components can still render it if they pass only serialisable props (no functions).

| Atom | Import | Runtime | Notes |
| --- | --- | --- | --- |
| Heading, Text | `Typography` | server | Semantic level separate from visual size. Heading `tone`: `default` (text-primary), `inverse` (only on `bg-surface-inverse`, e.g. HeroBanner), `secondary`. Text `tone`: `primary`, `secondary`, `inverse`, `danger`, `success` |
| Link | `Link` | server | `inline`, `nav`, `subtle`, `button`; `tone="inverse"` on `bg-surface-inverse`; `external` adds new-tab text; `isCurrent` implies `aria-current="page"`, an explicit `aria-current` ("true", "step", ...) wins. `variant="button"` is a pill built from the same class table as Button; `buttonVariant` (`primary` default, `secondary`, `outline`, `inverse`) and `buttonSize` (`sm`/`md`/`lg`). On dark bands use `buttonVariant="inverse"` (or keep primary + `ring-2 ring-text-inverse`); on the gold promo band use primary |
| Badge | `Badge` | server | Text required, never colour alone. Square by default (`shape="pill"` for round). `tone`: neutral, success, warning, danger, info, accent, promo, deal; `emphasis` `subtle` (tint, default) or `solid` (fill); `size` `sm`/`md`. `BADGE_PRESETS.new` / `.onlineOnly` / `.deal` / `.highlight` spread into props |
| Price | `Price` | server | Money formatting. `display="superscript"`: retail style with raised currency symbol and cents, `.00` dropped ("$10", "$5⁵⁰"); full "$5.50" stays the accessible text. `tone="deal"` colours the current price. `splitPrice()` exported |
| Button | `Button` | client | Pills by default. `primary`, `secondary`, `outline` (accent border), `ghost`, `danger`, `inverse` (white pill on dark bands), `quick-add` (compact "+ Add" pill over a 44px transparent hit area; give it `aria-label="Add <product> to cart"`). `shape` `pill`/`rounded` (`padding="none"` defaults to `rounded` so thumbnails keep corners). `loading` keeps focus and swallows clicks. `buttonClassName()` exported for Button-looking links |
| Card | `Card` | server | Surface container: `tone` raised (white, soft border + shadow-sm by default), sunken, accent-subtle, promo-subtle, deal-subtle, promo (gold, dark text), inverse (dark, white text), accent (blue, white text); `padding` none/sm/md/lg; `elevation`; `bordered`; `radius` lg/xl; `interactive` hover lift; `as` div/article/section/li/aside. `tone="accent"`: solid blue band, white text (6.70), descendants get the white focus ring automatically; use `inverse` actions on it. Never focusable itself |
| CategoryTile | `CategoryTile` | server | ONE link (single tab stop) wrapping image + caption; the caption is the accessible name and the image is decorative (`alt=""`). `shape`: `circle` (default, round image, home category rail), `rounded` (12px square), `card` (rectangular 4:5 image card, category discovery). `size` sm/md/lg is responsive (below md -> from md): circle/rounded sm 64px, md 80->96px, lg 80->128px (about four lg circles on a 390px phone); card sm 112->128px, md 128->160px, lg 160->224px; the image `sizes` attribute follows. Pair circles with ScrollRail `itemWidth="sm"` and cards with `itemWidth="auto"`. Missing/blank `imageSrc` renders a fallback tile (initial letter on `bg-surface-sunken`, no `<img>`). Caption `line-clamp-2`. `href` must pass `isAllowedInternalHref` (else `#` + dev warning). Focus ring on the link, outside the `overflow-hidden` mask; only width/offset utilities, colour from the base layer (white on dark bands); `min-h-touch`/`min-w-touch`. `priority` for the first row |
| Spinner | `Spinner` | server | `role="status"` with hidden label |
| Image | `Image` | client | Wraps next/image; placeholder on missing or failing src |
| Input, Select | `Input`, `Select` | server | Use inside FormField. Input `variant="pill"`: rounded light-grey 48px field (keeps the border-strong edge) |
| FormField | `FormField` | server | Render prop hands id + ARIA to the control |
| QuantityStepper | `QuantityStepper` | client | Cart quantities; `name` posts the value. Pill outline |
| Icon | `Icon` | server | `ICON_NAMES` (51, append-only), 24px grid, `currentColor`; decorative unless `title` |
| IconButton | `IconButton` | client | `label` required (`aria-label`); `pressed` sets `aria-pressed`; wraps Button; `padding="none"` passes through (box size kept) |
| Rating | `Rating` | client | Display (`value`, `count`; `variant="compact"` = one star + "4.6" + "(84)" for grids; `showValue` puts "4.6" before the five stars) or `mode="input"`: native radios named "N out of 5 stars" (each a transparent `appearance-none` layer over its 44px star, so the radio draws the base focus ring, white on dark bands), posts without JS, CSS-only fill/hover, `errorText` (alert, linked); `required` shows a visible aria-hidden "(required)" after the legend like FormField (`requiredMarker={false}` to hide). Pass the plain label, never "... (required)" |
| Checkbox | `Checkbox` | client | `indeterminate` sets `aria-checked="mixed"`; posts without JS |
| Radio, RadioGroup | `Radio` | client | `<fieldset role="radiogroup">` + legend; `errorText`/`hint` linked; posts without JS |
| Switch | `Switch` | client | `role="switch"` button; `name` posts via hidden input while on (cannot toggle without JS) |
| Textarea | `Textarea` | client | Input-shaped; `maxLength` + `showCount` (threshold announcements); `autoResize` via CSS |
| Chip | `Chip` | client | Every chip keeps `min-h-touch min-w-touch` (one-character labels too). `onToggle` sets `aria-pressed`; `onRemove` adds "Remove <label>" (override with `removeLabel`, e.g. "Remove filter: Brand Acme"); `aria-label` renames a button/link chip (keep the visible text in it); `as="a"` for filter links (selected implies `aria-current="true"`; an explicit `aria-current`, e.g. "page", wins). `variant="filled"`: borderless grey pill (popular/related searches); `trailingIcon` (decorative, e.g. "search"); `title` sets a native tooltip on the main element (button/link/span, never the remove button), e.g. the full text of a truncated label; supplementary only, blank is dropped |
| Avatar | `Avatar` | client | Photo or initials; tint hashed from name |
| Divider | `Divider` | server | `<hr>` / `role="separator"`; optional `label` ("or") |
| VisuallyHidden | `VisuallyHidden` | server | `sr-only`; `focusable` for skip links |
| Notice | `Notice` | server | info/success use `role="status"`; warning/danger use `role="alert"`; optional `onDismiss`. Use instead of ad-hoc status markup |
| Skeleton | `Skeleton` | server | `aria-hidden`; the loading container must carry `aria-busy` + text for assistive tech. Uses `bg-skeleton` |
| ProgressBar | `ProgressBar` | server | `label` required; `valueText` gives the meaning ("$12 away from free shipping"). `hideValueText` drops the visible line but keeps `aria-valuetext` (when the same message is already shown nearby). Inline width style is an orchestrator-approved exception |
| Table | `Table` | server | `label` names the focusable scroll region; `sort` sets `aria-sort` |
| Tabs | `Tabs` | client | JS-only: content that must work without JS or be crawled goes outside Tabs or gets anchors |
| Disclosure, Accordion | `Disclosure` | client | Native `<details>`; `exclusive` via `name`. Native marker hidden in globals.css |
| Dialog, DialogFooter | `Dialog` | client | Native `showModal`; parent owns `open`; `alert` for destructive confirms; no-JS fallback is the caller's job. Backdrop: `backdrop:bg-scrim` |
| Toast | `Toast` | client | `ToastProvider` + `useToast()`; server actions must still render inline status (e.g. Notice) for no-JS users. Position: fixed, `z-toast` (above the `z-sticky` header and sticky buy box); bottom-centre below md, top-right from md (`md:top-16 md:bottom-auto`, just under the sticky top bar) so it never covers a sticky "Add to cart" that was just pressed |
| Tooltip | `Tooltip` | client | Never the only way to convey information; trigger must be focusable |
| Breadcrumb | `Breadcrumb` | client | Full trail without JS; collapses after hydration |
| Pagination, PaginationSummary | `Pagination` | server | `hrefFor` from server pages; next/link with `rel` prev/next |
| SearchField | `SearchField` | client | GET form `action="/search"` `name="q"` works without JS; caller supplies `suggestions` (optional decorative `icon` and `value` inserted on choose, default `label`); `maxLength` forwarded to the input (also in no-JS HTML); `listFooter` slot at the bottom of the popup, outside the options (focusable; Tab keeps the popup open, Escape returns to the input); landmark always named (`landmarkLabel`, default "Site search"; explicit `aria-label`/`aria-labelledby` win), see Landmark rule. `variant="pill"`: rounded grey field with the round submit inset at its end (header search) |
| Drawer | `Drawer` | client | Native `<dialog>` `showModal`; `title` required; `side` left/right/bottom; Escape, backdrop and Close all call `onClose`; scroll lock; focus returns to the trigger; optional `footer`. Backdrop: `backdrop:bg-scrim`; keeps a `border-border-strong` edge against the scrim |
| ScrollRail | `ScrollRail` | client | `label` required: named region with `tabIndex=0`; CSS scroll-snap works without JS (`scroll-px-1` matches the list's `p-1` so the rail loads at scrollLeft 0); prev/next buttons are only rendered (conditional render, not the `hidden` attribute) when there is content in that direction; no auto-scroll. Arrows never overlap rail content: none below md (touch scroll), from md the wrapper reserves a 48px gutter each side (`md:px-12`) for them, from the `rail` breakpoint (1360px, `--breakpoint-rail`) it pulls out by 48px (`rail:-mx-12`) so items align with the heading and the arrows sit in the page gutter. Use it in the page content column (max-w-7xl + px-4), not inside a padded card. `itemWidth`: `sm` 80->160px (below md -> from md), `md` 224px, `lg` 288px, `auto` (child sizes itself, e.g. CategoryTile cards) |
| StoreBadge | `StoreBadge` | server | **placeholder — replace with approved brand assets later.** Neutral outlined pill (`border-border-strong`, own white fill) with a decorative phone `Icon` and text; `label` defaults to "Mobile app coming soon" (blank falls back); `size` `sm`/`md` (default md). Non-interactive `<span>`: no link, button, role or tabindex, and props cannot add them. No store name or logo ever (T132, R10) |
| PaymentMark | `PaymentMark` | server | **placeholder — replace with approved brand assets later.** Neutral rounded rectangle (`rounded-md`, `border-border-strong`, own white fill) with a generic text `label` (required; "Card", "Gift card", "Pay later: coming soon"; blank renders nothing + dev warning); `size` `sm`/`md`. Non-interactive `<span>`, text not image, no payment brand names. Wrap a set in `<ul className="flex flex-wrap gap-2">` under a visible heading |
| Steps | `Steps` | server | `<ol>` timeline; status as hidden text + icon; `aria-current="step"`; `orientation` |

### Requesting atom changes

Molecule and organism authors do not edit atoms. Send the request to the orchestrator (it queues a Designer batch), naming the atom, the prop you need and the caller. Changes are additive only: a new optional prop whose default is today's behaviour, so existing callers and QA tests keep passing. Until it lands, use the atom as-is (no raw-element or `!important` workarounds without orchestrator sign-off).

### Usage snippets (T132 placeholders)

Both atoms are placeholders until approved brand assets exist; they wrap inside a flex list at 320px and their text is text-primary on their own white fill (17.72:1) on any band.

```tsx
<ul className="flex flex-wrap gap-2">
  <li><StoreBadge /></li>                                              // "Mobile app coming soon", not a link
</ul>
<h3 id="pay-heading">Ways to pay</h3>
<ul className="flex flex-wrap gap-2" aria-labelledby="pay-heading">
  <li><PaymentMark label="Card" /></li>
  <li><PaymentMark label="Gift card" /></li>
  <li><PaymentMark label="Pay later: coming soon" size="sm" /></li>
</ul>
<Chip as="a" href={href} label={truncated} title={fullText} variant="filled" />   // (bu) full text on hover
```

### Usage snippets (Phase 3)

```tsx
<Button>Shop now</Button>                                              // blue pill
<Button variant="outline">Shop beauty</Button>
<Button variant="quick-add" aria-label={`Add ${name} to cart`} />      // "+ Add", 44px hit area
<Card tone="promo" radius="xl" padding="lg">                           // gold band, dark text
  <Heading level={2}>Holiday toy catalogue</Heading>
  <Link href="/deals" variant="button">Shop now</Link>                   // blue pill on gold
</Card>
<Card tone="inverse" radius="xl" padding="lg">                         // dark band
  <Heading level={2} tone="inverse">Join the newsletter</Heading>
  <Link href="/signup" variant="button" buttonVariant="inverse">Sign up</Link>
</Card>
<Card tone="accent" radius="xl" padding="lg">                          // blue band, white text + white rings
  <Heading level={2} tone="inverse">Gift ideas</Heading>
  <Link href="/gifts" variant="button" buttonVariant="inverse">Shop gifts</Link>
</Card>
<Card as="article" interactive padding="sm">…product card…</Card>
<Price amountCents={550} display="superscript" />                       // $5⁵⁰ (reads "$5.50")
<Price amountCents={1999} compareAtCents={2999} display="superscript" size="h2" tone="deal" />
<Badge {...BADGE_PRESETS.new}>New</Badge>
<Badge {...BADGE_PRESETS.onlineOnly}>Online only</Badge>
<Badge {...BADGE_PRESETS.deal}>Deal</Badge>
<Badge tone="neutral">Custom text</Badge>
<SearchField variant="pill" placeholder="Find products, categories and more" />
<Chip as="a" href="/search?q=lego" label="Lego" variant="filled" trailingIcon="search" />
<CategoryTile href="/category/home-kitchen" label="Home & Kitchen" imageSrc={getDepartmentTileArt("home-kitchen").path} />   // circle (default)
<CategoryTile href="/category/toys-games" label="Toys & Games" imageSrc={getDiscoveryTileArt(0).path} shape="card" size="lg" />
<CategoryTile href="/category/office" label="Office" imageSrc={null} />                  // fallback tile "O"
<Rating value={4.6} count={84} variant="compact" size="sm" />          // grid cards
<Rating value={4.6} count={84} showValue />                            // PDP / listing rows
```

### Usage snippets (batch 4)

```tsx
<Rating mode="input" name="rating" label="Overall rating" required />   // visible "(required)", aria-hidden
<Link href="?stars=5" variant="subtle" isCurrent aria-current="true">5 star</Link>
<Chip as="a" href="?stars=5" label="5 stars" selected aria-current="page" />
<Chip as="span" label="Acme" onRemove={clear} removeLabel="Remove filter: Brand Acme" />
<Heading level={1} tone="inverse">Deals of the day</Heading>          // on bg-surface-inverse
<Link href="/deals" variant="button" className="ring-2 ring-text-inverse">Shop deals</Link>
<SearchField action="/help" label="Search help" landmarkLabel="Help" />  // 2nd search form on the page
<SearchField maxLength={100} suggestions={[{ id: "r1", label: "Recent: lamp", value: "lamp", icon: "clock", href: "/search?q=lamp" }]}
  listFooter={<Button variant="ghost" size="sm" onClick={clearRecent}>Clear recent searches</Button>} />
<Button variant="ghost" padding="none" className="overflow-hidden" aria-label="Image 2 of 5">
  <Image src={src} alt="" width={64} height={64} />
</Button>
```

### Usage snippets (batch 1)

```tsx
<Icon name="truck" />                                   // decorative
<Icon name="warning" title="Warning" size="sm" />       // meaningful

<IconButton icon={saved ? "heart-filled" : "heart"} label="Save to wishlist"
  pressed={saved} onClick={toggle} />

<Rating value={4.3} count={1234} />                     // "4.3 out of 5 stars, 1,234 ratings"
<Rating mode="input" name="rating" label="Overall rating" required errorText={error} />
                                                        // legend "Overall rating (required)"; name "Overall rating"

<Checkbox name="brand" value="acme" label="Acme" description="12 items" />
<RadioGroup label="Shipping speed" name="shipping" defaultValue="standard" errorText={err}>
  <Radio value="standard" label="Standard" description="5-7 business days" />
  <Radio value="express" label="Express" />
</RadioGroup>
<Switch label="Email me about price drops" name="alerts" defaultChecked />

<FormField id="review" label="Your review" required error={err}>
  {(p) => <Textarea {...p} name="body" maxLength={2000} showCount autoResize />}
</FormField>

<Chip label="Prime" selected={prime} onToggle={setPrime} />
<Chip as="a" href="/search?q=desk&brand=acme" label="Acme" selected />
<Chip as="span" label="Under $25" onRemove={clearPrice} />

<Avatar name="Jane Doe" src={photoUrl} size="sm" />
<Divider label="or" />
<VisuallyHidden as="a" href="#main" focusable>Skip to main content</VisuallyHidden>
<Notice tone="success" title="Added to cart" onDismiss={close}>1 item</Notice>
```
