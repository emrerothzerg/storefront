# `src/app/search/_lib`: /search page logic

Private folder (not routed). Data loading and pure helpers for `src/app/search/page.tsx`, unit-tested without Next.js over a seeded `:memory:` DB. Shared listing logic lives in `src/app/_listing/listing-page.ts`; zero-result copy in `src/content/search-help.ts`.

| Export | What it does | Tests | Owner |
| --- | --- | --- | --- |
| `loadSearchPage(searchParams, deps?)` | One request: `now` read once, search ids (all pages, capped `MAX_SEARCH_IDS`), ONE `list()` call. Returns `SearchPageView`: `title` (the h1), `params`, `facets`, `result`, `sort`, `labels`, `showFilters`, `didYouMean`, `noResults`, and the v3 fields `relatedSearches`, `promoSlots`, `feedback`, `now` (a `Date` for every card). No cookies, no writes; search failure throws (500). | `search-page.test.ts` | T105, T168 |
| `searchHeading(q)` / `searchTitle(q)` | h1 "Showing results for “q”" (browse: "All results"); the metadata title stays "Results for “q”". | same | T168 |
| `relatedSearchChips(candidates, exclude)` | `{ query }` chips for the template's `relatedSearches` slot (visible label "Related searches"): trimmed, case-insensitive dedupe, never the current query or the did-you-mean suggestion, max `MAX_RELATED_CHIPS` (12). Candidates: with results, the unselected category then brand facet names of the result (most products first; both are FTS-indexed, so every chip finds results); with 0 results, the single terms of a multi-term query that find something (`relatedSearches`, max 5); browse mode: none. | same | T168 |
| `searchPromoSlots(params, total)` | Shared `listingPromoSlots` (T167) with base `/search`: tiles only on page 1, `total >= 8`, no facet and no `dept` (CONTRACTS L-15). | same | T168 |
| `searchFeedbackSuggestions(q)` | Feedback block links: one popular search that is not `q` (`/search?q=…`), `/products`, `/help`. | same | T168 |
| `searchAllIds`, `relatedSearches`, `searchHref` | Service paging, single-term related searches (0-result state), `/search?q=` builder. | same | T105 |
| `searchMetadata(searchParams)` | Always `noindex, follow`; canonical `/search?q=<q>` (facets, sort, page stripped). No DB access. | same, `page.test.tsx` | T105 |

Page (`page.tsx`): passes `relatedSearches`, `promoSlots`, `feedback`, `addToCart` (quick add) and `cardProps={() => ({ now })}` (the loader's single clock) to `ListingTemplate`; did-you-mean stays in the children slot; the 0-result `emptyState` shows "No results" + "Clear filters" (only when filters or `dept` narrowed the results) on a sunken Card, then Cards for search tips, popular searches and departments (chip links).
