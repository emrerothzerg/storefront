import { isAllowedInternalHref } from "@/content/routes";

/** One link tab of a tabbed ProductRail ("Top picks"). */
export interface ProductRailTab {
  /** Stable id, e.g. "deals". Also the `?rail=` value the caller parses. */
  id: string;
  /** Visible text (rendered as text, never HTML). */
  label: string;
  /** Caller-built link, e.g. `/?rail=deals#top-picks`. Must pass `isAllowedInternalHref`. */
  href: string;
}

/** Longest `?rail=` value worth comparing; anything longer is never a tab id. */
export const RAIL_PARAM_MAX_LENGTH = 64;

/**
 * Resolves a raw `?rail=` search param to a known tab id. Only a single,
 * exact match of one of `ids` is accepted; missing, empty, repeated
 * (`rail=a&rail=b`), unknown, prototype-like (`__proto__`) or over-long values
 * fall back to `defaultId`. Never throws.
 */
export function resolveRailTab(
  raw: string | readonly string[] | null | undefined,
  ids: readonly string[],
  defaultId: string,
): string {
  if (typeof raw !== "string") return defaultId;
  if (raw === "" || raw.length > RAIL_PARAM_MAX_LENGTH) return defaultId;
  return ids.includes(raw) ? raw : defaultId;
}

export interface ValidTabs {
  tabs: ProductRailTab[];
  /** Id of the current tab: `activeId` when valid, else the first tab. Null when no tab is left. */
  activeId: string | null;
  /** Human-readable reasons for dropped tabs (dev warnings). */
  dropped: string[];
}

/**
 * Keeps tabs with a non-empty id and label, an allowed internal href and an
 * id not seen before (first wins), in caller order.
 */
export function validRailTabs(tabs: readonly ProductRailTab[] | undefined, activeId: string | undefined): ValidTabs {
  const out: ProductRailTab[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const tab of tabs ?? []) {
    const id = typeof tab.id === "string" ? tab.id.trim() : "";
    const label = typeof tab.label === "string" ? tab.label.trim() : "";
    const href = typeof tab.href === "string" ? tab.href : "";
    if (id === "" || label === "") {
      dropped.push(`tab ${JSON.stringify(id)} has an empty id or label`);
      continue;
    }
    if (seen.has(id)) {
      dropped.push(`duplicate tab id ${JSON.stringify(id)}`);
      continue;
    }
    if (!isAllowedInternalHref(href)) {
      dropped.push(`tab ${JSON.stringify(id)} href is not an allowed internal link`);
      continue;
    }
    seen.add(id);
    out.push({ id, label, href });
  }
  const first = out[0];
  const current =
    activeId !== undefined && out.some((tab) => tab.id === activeId) ? activeId : first !== undefined ? first.id : null;
  return { tabs: out, activeId: current, dropped };
}
