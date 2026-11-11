/**
 * Strict ISO-8601 date-time parser shared by DeliveryEstimate and ReviewCard.
 *
 * Accepts only `YYYY-MM-DDTHH:mm(:ss(.fff)?)?(Z|±HH:mm)` (1-3 fraction digits).
 * Unlike `Date.parse`, it rejects impossible calendar dates ("2026-02-31"),
 * out-of-range times ("25:00"), date-only strings and anything without an
 * explicit zone (which `Date.parse` would read in local time).
 *
 * Returns epoch milliseconds, or null.
 */
const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

export function parseIsoStrict(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO_PATTERN.exec(value);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s, frac, z, sign, oh, om] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  const millis = frac === undefined ? 0 : Number(frac.padEnd(3, "0"));
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (z === undefined) {
    const offH = Number(oh);
    const offM = Number(om);
    if (offH > 23 || offM > 59) return null;
    offsetMinutes = (sign === "-" ? -1 : 1) * (offH * 60 + offM);
  }

  // Round-trip the wall-clock calendar date: rollover (Feb 31 -> Mar 3) fails.
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, millis);
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) {
    return null;
  }
  const ms = wall.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(ms) ? ms : null;
}
