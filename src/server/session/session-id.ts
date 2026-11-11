/**
 * Session id validation. Pure module: imports nothing from `next/*`, so cart and
 * order services (and their tests) can validate ids without pulling in
 * `next/headers`.
 */

/** Canonical lowercase UUID v4: version nibble `4`, RFC 4122 variant `8|9|a|b`. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Length of a canonical hyphenated UUID. */
const UUID_LENGTH = 36;

/**
 * Type guard for a valid session id (canonical lowercase UUID v4).
 * Repositories should call this before using a session id in any query.
 */
export function isSessionId(value: unknown): value is string {
  // Length check first so huge strings are rejected without running the regex.
  return typeof value === "string" && value.length === UUID_LENGTH && UUID_V4_RE.test(value);
}
