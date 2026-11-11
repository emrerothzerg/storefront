/**
 * Open-redirect guard for `next` parameters (T119, AR4). Pure module: no
 * `next/*` imports, safe for any server or client code.
 *
 * Accepts only a same-origin absolute path:
 * - a string of at most {@link SAFE_NEXT_MAX_LENGTH} chars,
 * - starting with exactly one `/` (never `//` or `/\`),
 * - made only of `A-Z a-z 0-9 / _ - . ~ % ? = & #` (so no scheme `:`, no
 *   backslash, no whitespace or control characters, no non-ASCII),
 * - that still satisfies the same rules after one percent-decode (no `//` or
 *   `/\` prefix, no backslash, no control characters, and no remaining
 *   encoded `/` pair or backslash such as `%2F%2F` / `%5C` from double
 *   encoding), and whose percent-escapes are well formed.
 * Anything else returns `fallback`.
 */

export const SAFE_NEXT_MAX_LENGTH = 512;

export const DEFAULT_SAFE_NEXT = "/account";

const ALLOWED_RE = /^\/(?![/\\])[A-Za-z0-9/_\-.~%?=&#]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ENCODED_TRICK_RE = /%2f%2f|%5c/i;

export function safeNext(raw: unknown, fallback: string = DEFAULT_SAFE_NEXT): string {
  if (typeof raw !== "string") return fallback;
  if (raw.length === 0 || raw.length > SAFE_NEXT_MAX_LENGTH) return fallback;
  if (!ALLOWED_RE.test(raw)) return fallback;
  if (ENCODED_TRICK_RE.test(raw)) return fallback;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.startsWith("/\\")) return fallback;
  if (decoded.includes("\\") || CONTROL_RE.test(decoded) || ENCODED_TRICK_RE.test(decoded)) return fallback;

  return raw;
}
