import { unstable_rethrow } from "next/navigation";

import type { Suggestion } from "@/server/catalog/search-service";
import type { RateLimiter } from "@/server/security/rate-limiter";

/**
 * Pure logic for `GET /api/search/suggest?q=` (T53). The route file only
 * wires {@link createSuggestHandler} with production dependencies, so this
 * module is testable without Next.js or a running server.
 *
 * Response contract (every response carries {@link BASE_HEADERS}):
 * - 200 `{ suggestions: [] }` for a missing, empty, whitespace-only or
 *   1-code-point `q` (no rate-limit check, no service call);
 * - 400 `{ error: "query_too_long" }` when raw `q` exceeds 100 code points;
 * - 429 `{ error: "rate_limited", retryAfterSeconds }` + `Retry-After`;
 * - 200 `{ suggestions: [{ type, label, href }] }` (at most 8, internal hrefs only);
 * - 500 `{ error: "internal" }` for any thrown error (log line never has the query);
 * - 405 `{ error: "method_not_allowed" }` + `Allow: GET` ({@link methodNotAllowedResponse};
 *   Next answers non-GET methods itself because the route only exports `GET`).
 *
 * Read-only: never writes cookies (SR10). The session id is only read.
 */

export const MAX_Q_LENGTH = 100;
export const MAX_SUGGESTIONS_RESPONSE = 8;
/** Used when the limiter's error carries no usable `retryAfterSeconds`. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

export const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  Vary: "Cookie",
});

export interface SuggestionDto {
  readonly type: Suggestion["type"];
  readonly label: string;
  readonly href: string;
}

export type SuggestBody =
  | { readonly suggestions: readonly SuggestionDto[] }
  | { readonly error: "query_too_long" | "internal" | "method_not_allowed" }
  | { readonly error: "rate_limited"; readonly retryAfterSeconds: number };

export function jsonResponse(
  status: number,
  body: SuggestBody,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extraHeaders } });
}

/** 405 for any non-GET method (documented; Next produces its own 405 for unexported methods). */
export function methodNotAllowedResponse(): Response {
  return jsonResponse(405, { error: "method_not_allowed" }, { Allow: "GET" });
}

export type ParsedQuery =
  | { readonly kind: "empty" }
  | { readonly kind: "too_long" }
  | { readonly kind: "query"; readonly q: string };

function codePointLength(s: string): number {
  return Array.from(s).length;
}

/**
 * Reads the first `q` parameter. Over-length is judged on the raw value in
 * code points (a quick code-unit pre-check avoids iterating huge strings);
 * emptiness on the trimmed value.
 */
export function parseQuery(url: string): ParsedQuery {
  const raw = new URL(url).searchParams.get("q");
  if (raw === null) return { kind: "empty" };
  // A code point is at most 2 code units, so > 200 code units is always > 100 code points.
  if (raw.length > MAX_Q_LENGTH * 2 || codePointLength(raw) > MAX_Q_LENGTH) return { kind: "too_long" };
  const q = raw.trim();
  if (codePointLength(q) < 2) return { kind: "empty" };
  return { kind: "query", q };
}

const SUGGESTION_TYPES: ReadonlySet<string> = new Set(["product", "category", "brand"]);
/** Any Unicode control character: C0, DEL and C1 (U+0080..U+009F). */
const CONTROL_RE = /\p{Cc}/u;

/** Internal path only: starts with one `/`, no `//`, no backslash, no control characters. */
export function isInternalHref(href: unknown): href is string {
  return (
    typeof href === "string" &&
    href.length > 0 &&
    href.length <= 2048 &&
    href.startsWith("/") &&
    !href.startsWith("//") &&
    !href.includes("\\") &&
    !CONTROL_RE.test(href)
  );
}

/** Keeps well-formed suggestions with internal hrefs, copies only the three fields, caps at 8. */
export function sanitizeSuggestions(input: unknown): SuggestionDto[] {
  if (!Array.isArray(input)) return [];
  const out: SuggestionDto[] = [];
  for (const item of input as readonly unknown[]) {
    if (out.length >= MAX_SUGGESTIONS_RESPONSE) break;
    if (typeof item !== "object" || item === null) continue;
    const { type, label, href } = item as { type?: unknown; label?: unknown; href?: unknown };
    if (typeof type !== "string" || !SUGGESTION_TYPES.has(type)) continue;
    if (typeof label !== "string" || label.length === 0) continue;
    if (!isInternalHref(href)) continue;
    out.push({ type: type as Suggestion["type"], label, href });
  }
  return out;
}

function retryAfterOf(details: Readonly<Record<string, unknown>> | undefined): number {
  const value = details?.retryAfterSeconds;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_RETRY_AFTER_SECONDS;
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name.slice(0, 64);
  return typeof error;
}

export interface SuggestDeps {
  readonly suggest: (q: string, limit: number) => readonly Suggestion[];
  readonly getLimiter: () => RateLimiter;
  readonly limit: (limiter: RateLimiter, sessionId: string | null) => ReturnType<RateLimiter["check"]>;
  readonly readSessionId: () => Promise<string | null>;
  readonly logger: Pick<Console, "error">;
}

/** Builds the GET handler over injected dependencies. */
export function createSuggestHandler(deps: SuggestDeps): (request: Request) => Promise<Response> {
  return async function handleSuggest(request: Request): Promise<Response> {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowedResponse();
      const parsed = parseQuery(request.url);
      if (parsed.kind === "too_long") return jsonResponse(400, { error: "query_too_long" });
      if (parsed.kind === "empty") return jsonResponse(200, { suggestions: [] });

      const sessionId = await deps.readSessionId();
      const limited = deps.limit(deps.getLimiter(), sessionId);
      if (!limited.ok) {
        if (limited.error.code !== "RATE_LIMITED") throw new Error("unexpected limiter result");
        const retryAfterSeconds = retryAfterOf(limited.error.details);
        return jsonResponse(
          429,
          { error: "rate_limited", retryAfterSeconds },
          { "Retry-After": String(retryAfterSeconds) },
        );
      }

      const suggestions = sanitizeSuggestions(deps.suggest(parsed.q, MAX_SUGGESTIONS_RESPONSE));
      return jsonResponse(200, { suggestions });
    } catch (error) {
      unstable_rethrow(error);
      try {
        deps.logger.error(`[api/search/suggest] internal error (${errorName(error)})`);
      } catch {
        // Logging must never change the response.
      }
      return jsonResponse(500, { error: "internal" });
    }
  };
}
