# src/lib/seo

Site-wide SEO helpers, pure and framework-free (no `next/*` runtime imports,
no database access). Route files in `src/app` call them.

| File | Purpose |
|---|---|
| `site.ts` | `SITE_NAME`, `getSiteUrl()` / `absoluteUrl()` (env `NEXT_PUBLIC_SITE_URL`), manifest colours, `ROBOTS_DISALLOW` |
| `metadata.ts` | `buildMetadata()`: title, description, canonical, Open Graph, Twitter, `noindex` |
| `json-ld.ts` | Typed schema.org builders (Organization, WebSite + SearchAction, BreadcrumbList, ItemList, FAQPage, Product); render with the `JsonLd` molecule |
| `sitemap.ts` | `buildSiteSitemap()` (full sitemap from the policy table + slug sources), legacy `buildSitemapEntries()` |
| `routes.ts` | Route policy table: one entry per `src/app/**/page.tsx` |

Environment: `NEXT_PUBLIC_SITE_URL` (public origin, optionally with a base
path; set at build time and runtime). Default `http://localhost:3000`.

## Route policy table (`routes.ts`)

Each entry: `route`, `file`, `indexing` (`indexable` | `noindex` |
`noindex-follow`), `sitemap`, `sitemapSource` (dynamic sitemap routes),
`canonical` (`self` | `listing` | `search` | `none`), `robotsDisallowed`, and
optional query `variants` with a different indexing class.

Counts: 39 routes = 19 indexable (all in the sitemap), 2 noindex-follow, 18 noindex. robots.txt blocks 17 of them (`/search`, `/compare`, and the account/cart/checkout/lists/orders routes).

| Route | Indexing | Sitemap | Canonical | robots.txt |
|---|---|---|---|---|
| `/` | indexable | yes | self | allowed |
| `/products`, `/deals`, `/best-sellers`, `/new-arrivals`, `/top-rated` | indexable; faceted or re-sorted URL (any sort other than the route default): noindex-follow | yes | listing | allowed |
| `/brands` | indexable | yes | self | allowed |
| `/brand/[slug]` | indexable; faceted: noindex-follow | every brand (`lastModified` = `updated_at`) | listing | allowed |
| `/category/[slug]` | indexable; faceted: noindex-follow | every category, both levels (`lastModified` = `updated_at`) | listing | allowed |
| `/products/[slug]` | indexable (unknown slug: noindex) | every product published now (`lastModified` = `updated_at`) | self | allowed |
| `/help` | indexable; `?q=`: noindex | yes | self (`/help`) | allowed |
| `/help/[topic]` | indexable | the 8 topics | self | allowed |
| `/faq` | indexable | yes | self | allowed |
| `/about`, `/shipping`, `/returns`, `/privacy`, `/terms`, `/accessibility` | indexable | yes | self | allowed |
| `/search` | noindex-follow | no | search (`/search?q=`) | disallowed |
| `/compare` | noindex-follow | no | self | disallowed |
| `/signin`, `/signup`, `/contact` | noindex | no | self | **allowed** (the noindex must be seen; T127 ruling, `/contact` by orchestrator ruling) |
| `/cart`, `/checkout` | noindex | no | self | disallowed |
| `/account`, `/account/{addresses,alerts,contributions,history,messages,settings}` | noindex | no | self | disallowed (`/account`) |
| `/lists` | noindex | no | self | disallowed |
| `/lists/[id]`, `/lists/shared/[token]` | noindex | no | none (private id/token) | disallowed (`/lists`) |
| `/orders` | noindex | no | self | disallowed |
| `/orders/[id]`, `/orders/[id]/invoice` | noindex | no | none (private id) | disallowed (`/orders`) |

Not in the table (no `page.tsx`): `not-found.tsx` (noindex, no canonical),
`/api/*` route handlers (disallowed by `/api/`), the metadata routes.

Canonical rules: `self` = the route's own path, query ignored. `listing` =
plain page 1 -> base, plain page N -> `?page=N`, faceted or re-sorted ->
page-1 base plus `noindex, follow`. `search` = `/search?q=<q>`. `none` = no
canonical and no `og:url`.

### Adding a route

1. Create `src/app/<route>/page.tsx` with `metadata` or `generateMetadata`
   built by `buildMetadata()` (pass `path` unless the URL holds a private
   id; pass `noindex: true` for private pages).
2. Add one entry to `ROUTE_POLICIES` in `routes.ts` (`indexable(...)` or
   `privatePage(...)` helpers, or a literal object).
3. Indexable static routes appear in the sitemap automatically. A dynamic
   indexable route needs a `sitemapSource`; a new source needs a case in
   `buildSiteSitemap()` and loading in `src/app/sitemap.ts`.
4. Private routes: add a prefix to `ROBOTS_DISALLOW` in `site.ts` when the
   route is `robotsDisallowed: true` (never for noindex pages that must stay
   crawlable such as `/signin`, `/signup`, `/contact`; never for `/_next/`,
   CSS/JS or images).
5. Run `bun test src/lib/seo`. `routes.test.ts` fails for a page without an
   entry (or an entry without a page) and when `ROBOTS_DISALLOW` disagrees
   with `robotsDisallowed`; `metadata-audit.test.ts` checks the page's
   metadata against the entry; `json-ld-presence.test.ts` renders every
   indexable page and parses its JSON-LD.

## Audits (T112)

- `metadata-audit.test.ts` (criterion 5): calls every page's `metadata` /
  `generateMetadata` (dynamic indexable routes: every slug the sitemap lists,
  over a seeded `:memory:` DB) and checks robots class vs the table,
  canonical presence/absoluteness/path, and for indexable forms: description
  70-160 chars, Open Graph (`title`, `description`, `url`, `type`,
  `siteName`) and Twitter (`card`, `title`, `description`). Rendered titles
  (`<title> | SITE_NAME`) over 60 chars only `console.warn`. Violations in
  pages owned elsewhere are listed in `KNOWN_VIOLATIONS` (keyed
  `<route> <field>`); the test fails on a new key and on a fixed one.
- `json-ld-presence.test.ts` (criterion 6): home (layout) Organization +
  WebSite with SearchAction; PDP Product + BreadcrumbList; listings ItemList
  + BreadcrumbList; `/faq` FAQPage; every ld+json script on every indexable
  page parses with `JSON.parse`, has `@context`/`@type`, absolute URLs.

## Sitemap size

`/sitemap.xml` is one file. `generateSitemaps` is not used because the
catalogue cannot approach the 50,000-URL protocol limit: it is a seeded store
(125 seeded products of which 123 are published and listed, 32 categories, 12 brands and 23 static/help URLs: 190 URLs) with no
import or admin path that adds products in bulk, and splitting would move
the sitemap to `/sitemap/<id>.xml` without an index at `/sitemap.xml`
(Next does not generate one), breaking `robots.txt` and the T113 checks.
Guards: `src/app/sitemap.test.ts` asserts the count stays under
`SITEMAP_URL_LIMIT`, and `buildSiteSitemap()` caps at the limit and logs
via `console.error` instead of emitting an invalid file. If the catalogue
ever grows past ~45,000 products, switch to `generateSitemaps` plus a
sitemap index route.
