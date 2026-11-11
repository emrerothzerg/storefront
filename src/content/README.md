# src/content

Typed, plain-text static content for the help centre, FAQ, policy pages and site navigation. No CMS, no markdown, no React, no HTML: every string renders as a React text child. Store name comes from `SITE_NAME` (`@/lib/seo/site`).

| Module | Exports |
|---|---|
| `routes.ts` | `PLANNED_ROUTES` (as const), `PlannedRoute`, `isAllowedInternalHref(href)` |
| `faq.ts` | `FAQ_ENTRIES`, `FaqEntry`, `FaqJsonLdInput`, `getFaqEntry`, `getFaqEntries`, `toFaqJsonLdInput` |
| `help-topics.ts` | `HELP_TOPICS`, `HELP_TOPIC_SLUGS`, `HelpTopicSlug`, `HELP_TOPIC_ICONS`, `HelpTopicIcon`, `HelpTopic`, `getHelpTopic`, `isHelpTopicSlug`, `helpTopicHref` |
| `policies.ts` | `POLICY_PAGES`, `POLICY_PAGE_LIST`, `POLICY_SLUGS`, `PolicySlug`, `PolicyPage`, `PolicySection`, `SAMPLE_POLICY_NOTICE`, `POLICY_LAST_UPDATED`, `getPolicyPage`, `isPolicySlug`, `policyHref` |
| `navigation.ts` | `PRIMARY_NAV`, `ACCOUNT_NAV`, `AUTH_NAV`, `DEPARTMENT_NAV`, `FOOTER_COLUMNS` (v3: Help, Orders & delivery, About, Legal), `FOOTER_QUICK_LINKS` (Track order, Contact us; hrefs never repeated in the columns), `LEGAL_LINKS`, `NavLink`, `DepartmentNavLink`, `FooterColumn` |
| `search-help.ts` | `searchHelp(query)`, `HelpSearchResult`, `normalizeHelpQuery`, `HELP_QUERY_MAX_LENGTH`, `HELP_QUERY_MAX_TERMS`, `SEARCH_TIPS`, `POPULAR_SEARCHES` |
| `home-art.ts` | `HomeArtImage`, `HOME_ART_DIR`, `HOME_ART` (by purpose), `ALL_HOME_ART`, `HERO_SLIDE_ART`, `HERO_PANEL_ART`, `DELIVERY_PROMO_ART`, `BEAUTY_PROMO_ART`, `LIFESTYLE_ART` + `LIFESTYLE_ART_KEYS`, `LIFESTYLE_THREE_COLUMN_KEYS`, `DEPARTMENT_TILE_ART` (by department slug), `DISCOVERY_TILE_ART`, `FALLBACK_TILE_ART`, `getDepartmentTileArt(slug)`, `getDiscoveryTileArt(index)`: placeholder SVGs in `public/images/home/` (abstract, no text, palette raw values only, < 40 KB; use `alt=""` when a caption is visible) |
| `header-benefits.ts` | `HEADER_BENEFITS` (`label`, `freeShipping` template with `{amount}`, static `items`, `coupon` prefix), `HEADER_BENEFIT_ICONS`, `HEADER_BENEFIT_AMOUNT_TOKEN`, types: header benefits strip copy (T148). The amount comes from the shipping-method data at render time, never from here; the header keeps a hardcoded fallback in `src/app/_layout/header-benefits.ts`. T165 may move it |
| `home.ts` | `HOME_CONTENT` (`hero` slides ×3 from `HERO_SLIDE_ART`, `categories`, `shippingPromo` with `{amount}`, `discovery`, `lifestyleBanner` (beauty split), `topPicks` tabs + `defaultTabId`, `lifestyleExplore` (4 col) / `lifestyleMakeRoom` (3 col) from `LIFESTYLE_ART`, `popularSearches` (`POPULAR_SEARCHES` + home extras, ≤ 12), `promoPair` (New arrivals, Top rated), `recentlyViewed`, `brands`, `services` overrides; every section's contract `sectionId`), `HOME_AMOUNT_TOKEN`, `HOME_POPULAR_SEARCH_MAX`, `HOME_TOP_PICKS_SECTION_ID`, `topPicksTabHref(id)`, types: home page copy (T165). Read by `src/app/_lib/home.ts`; the threshold amount is filled in from the shipping methods at load time. `home.test.ts` checks every href (allow-list + page exists + seed category slugs), popular searches against the seeded search service, and brand-free/honesty word lists |
| `listing-promos.ts` | `LISTING_PROMOS` (shipping, deals, spare best-sellers stand-in, account sign-up; placement order), `LISTING_FEEDBACK_SUGGESTIONS` (`FeedbackBlock` links), types `ListingPromoCopy`, `ListingPromoTone`: listing page promo tile + feedback copy (T167). Read by `src/app/_listing/listing-page.ts` (`listingPromoSlots`, `listingFeedback`), which skips tiles whose CTA points at the current route. No hardcoded money (the shipping tile links to `/shipping`); `listing-promos.test.ts` checks hrefs and brand-free/honesty word lists |

## Usage notes

- FAQPage JSON-LD: `faqPageJsonLd(toFaqJsonLdInput(FAQ_ENTRIES))`.
- `/help/[topic]`: `getHelpTopic(params.topic)` (undefined means `notFound()`), then `getFaqEntries(topic.faqSlugs)`. Render each entry with `id={entry.slug}`: search results link to `/help/[topic]#[slug]`.
- Policy pages: render `page.sections` in order. The first paragraph of the first section is always `SAMPLE_POLICY_NOTICE`; `sampleNotice: true` lets a page also show it in a Notice atom (then skip the duplicate paragraph if desired). Show `lastUpdated` as "Last updated".
- `searchHelp("")` returns every topic then every FAQ entry (score 0). Non-empty queries are capped at 100 characters and 8 terms, matched with lower-cased `includes` (never a RegExp), and ranked: phrase in title, all terms in title, phrase in body, all terms anywhere.
- Header: show `AUTH_NAV` (Sign in, Create account) to signed-out visitors and `ACCOUNT_NAV` (ends with Settings) to signed-in ones; sign-out is a POST form, not a link. The footer "Your account" column always lists Sign in and Settings.
- Accounts copy (T126): guest data is device-bound until you sign in; password reset is not available (contact form). Do not add copy claiming email verification, reset by email, 2FA or social login (a test rejects it).
- `DEPARTMENT_NAV` (`{ slug, label }`, taxonomy order) is for pages that must not touch the database (the 404 page). It must match `SEED_DEPARTMENTS` (slugs, names, order); `navigation.test.ts` enforces it, so update both together.
- `SEARCH_TIPS` / `POPULAR_SEARCHES` are the /search zero-results help (moved from the search page, CONS-B1). Every popular search must return results on the seeded catalogue (`search-help.test.ts` runs the real search service on a seeded in-memory DB).
- Account deletion copy follows ruling R-7: reviews and helpful votes are removed, questions and answers stay with their text and display name replaced by “[deleted]” (FAQ + privacy policy).
- Topic summaries double as `/help/[topic]` meta descriptions: keep them 70–160 characters (T112 audit).
- Topic icons are a subset of the atoms `ICON_NAMES` (checked by test).

## Rules for editors

- Plain text only: no `<` or `>`, no markdown, no entities (tests enforce this).
- Every internal link (FAQ `relatedHrefs`, nav, footer) must pass `isAllowedInternalHref`. Add a route to `PLANNED_ROUTES` only when the page really exists or is planned.
- Copy must match behaviour (BACKLOG-phase2.md section 7). Shipping prices are checked against `SEED_SHIPPING_METHODS` and test cards against `MOCK_CARDS`; update the copy when those change.
