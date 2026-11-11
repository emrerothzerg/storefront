import { getSearchService } from "@/server/catalog/search-service";
import { getRateLimiter, limitAction } from "@/server/security/rate-limiter";
import { readSessionId } from "@/server/session/session";

import { createSuggestHandler } from "./_lib/suggest";

/**
 * `GET /api/search/suggest?q=` (T53): typeahead suggestions for the header
 * SearchBox. Contract and logic live in `./_lib/suggest.ts`. Only `GET` is
 * exported, so Next answers every other method with 405. Never sets cookies.
 */
const handleSuggest = createSuggestHandler({
  suggest: (q, limit) => getSearchService().suggest(q, limit),
  getLimiter: getRateLimiter,
  limit: (limiter, sessionId) => limitAction(limiter, "search.suggest", sessionId),
  readSessionId,
  logger: console,
});

export async function GET(request: Request): Promise<Response> {
  return handleSuggest(request);
}
