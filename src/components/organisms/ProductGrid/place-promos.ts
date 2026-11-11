/** Most promo tiles one grid page may show (CONTRACTS L-13). */
export const MAX_PROMO_SLOTS = 3;

/** A promo request: show `tile` right after the product at 0-based index `afterIndex`. */
export interface PromoSlot<T> {
  /** 0-based index of the product the tile follows (`2` = after the 3rd product). */
  afterIndex: number;
  tile: T;
}

export interface PlacePromosOptions<T = unknown> {
  /**
   * Current listing page. Promos are placed only when this is exactly 1
   * (CONTRACTS L-14). Defaults to 1; any other value (2, 0, NaN, 1.5) places none.
   */
  page?: number;
  /**
   * Full page size (e.g. `LISTING_PAGE_SIZE`). A tile after the last product is
   * allowed only when the page is full (`items.length >= pageSize`); without
   * a page size a trailing tile is always dropped.
   */
  pageSize?: number;
  /** Optional per-tile validity check (e.g. a non-blank heading); failing tiles are dropped before the cap. */
  isValidTile?: (tile: T) => boolean;
}

export type PlacedEntry<P, T> =
  | { kind: "product"; item: P; index: number }
  | { kind: "promo"; tile: T; afterIndex: number };

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * The slots that will actually render, in placement order. Rules (T156 AC1):
 * - nothing unless `page === 1` and there is at least one item;
 * - `afterIndex` must be an integer in `[0, items.length - 1]` (beyond the
 *   count is dropped);
 * - a tile after the last item is dropped unless the page is full;
 * - two slots at the same index: the first one wins;
 * - at most `MAX_PROMO_SLOTS`, taken in the caller's order (after the drops above).
 */
export function selectPromoSlots<T>(
  itemCount: number,
  slots: readonly PromoSlot<T>[] | null | undefined,
  options: PlacePromosOptions<T> = {},
): PromoSlot<T>[] {
  const page = options.page ?? 1;
  if (page !== 1) return [];
  if (!Number.isInteger(itemCount) || itemCount <= 0) return [];
  if (!Array.isArray(slots) || slots.length === 0) return [];

  const full = isPositiveInteger(options.pageSize) && itemCount >= options.pageSize;
  const lastAllowed = full ? itemCount - 1 : itemCount - 2;
  const seen = new Set<number>();
  const chosen: PromoSlot<T>[] = [];

  for (const slot of slots) {
    if (chosen.length >= MAX_PROMO_SLOTS) break;
    if (slot === null || typeof slot !== "object") continue;
    const { afterIndex, tile } = slot;
    if (typeof afterIndex !== "number" || !Number.isInteger(afterIndex)) continue;
    if (afterIndex < 0 || afterIndex > lastAllowed) continue;
    if (seen.has(afterIndex)) continue;
    if (tile === null || tile === undefined) continue;
    if (options.isValidTile && !options.isValidTile(tile)) continue;
    seen.add(afterIndex);
    chosen.push({ afterIndex, tile });
  }

  return chosen.sort((a, b) => a.afterIndex - b.afterIndex);
}

/**
 * Interleaves products and promo tiles. Products keep their own 0-based
 * `index` (so priority/cardProps/rank ignore promos); a tile follows the
 * product at its `afterIndex`. See `selectPromoSlots` for the drop rules.
 */
export function placePromos<P, T>(
  items: readonly P[],
  slots: readonly PromoSlot<T>[] | null | undefined,
  options: PlacePromosOptions<T> = {},
): PlacedEntry<P, T>[] {
  const chosen = selectPromoSlots(items.length, slots, options);
  const byIndex = new Map<number, PromoSlot<T>>(chosen.map((slot) => [slot.afterIndex, slot]));
  const out: PlacedEntry<P, T>[] = [];
  items.forEach((item, index) => {
    out.push({ kind: "product", item, index });
    const slot = byIndex.get(index);
    if (slot) out.push({ kind: "promo", tile: slot.tile, afterIndex: slot.afterIndex });
  });
  return out;
}
