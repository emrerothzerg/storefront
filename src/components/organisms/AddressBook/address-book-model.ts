import type { SavedAddress } from "@/lib/types";
// Type-only: organisms never import server code at runtime. `typeof` pins the
// local default to the service constant at compile time (a change there fails
// `bun run typecheck` here).
import type { MAX_ADDRESSES_PER_SESSION } from "@/server/addresses/address-service";

/** Default address-book cap; equal to the service's `MAX_ADDRESSES_PER_SESSION`. */
export const ADDRESS_BOOK_LIMIT: typeof MAX_ADDRESSES_PER_SESSION = 10;

/** Static element ids (one AddressBook per page). Never derived from address data. */
export const ADDRESS_BOOK_HEADING_ID = "address-book-heading";
export const ADDRESS_BOOK_ADD_HEADING_ID = "address-book-add-heading";
export const ADDRESS_BOOK_LIMIT_NOTICE_ID = "address-book-limit";
export const ADDRESS_BOOK_ADD_FORM_PREFIX = "address-form-new";

export const ADDRESS_BOOK_TITLE = "Your addresses";
export const ADD_ADDRESS_TITLE = "Add a new address";
export const EMPTY_ADDRESSES_TEXT = "You haven't saved any addresses yet.";
export const FIRST_ADDRESS_DEFAULT_TEXT = "Your first address will become your default address.";
export const ADDRESS_DELETED_TEXT = "Address deleted.";
export const ADDRESS_SAVED_TEXT = "Address saved.";

/** "You've reached the limit of 10 addresses. Delete one to add another." */
export function limitReachedText(limit: number): string {
  return `You've reached the limit of ${limit} ${limit === 1 ? "address" : "addresses"}. Delete one to add another.`;
}

/** Element id prefix of the edit form at list position `index` (never the address id or any PII). */
export function editFormPrefix(index: number): string {
  return `address-form-${index}`;
}

/** A positive integer limit, else the default. */
export function normaliseLimit(limit: number | undefined): number {
  return typeof limit === "number" && Number.isInteger(limit) && limit >= 1 ? limit : ADDRESS_BOOK_LIMIT;
}

/**
 * Display order: the default first, then the service's order (stable).
 * Exactly one default survives: the first flagged entry keeps `isDefault`,
 * any later flagged entry is shown as a regular address (corrupt data never
 * renders two "Default" badges). No flagged entry -> no default.
 */
export function sortAddresses(addresses: readonly SavedAddress[]): SavedAddress[] {
  const defaultIndex = addresses.findIndex((a) => a.isDefault === true);
  const normalised = addresses.map((a, i) =>
    i === defaultIndex ? a : a.isDefault ? { ...a, isDefault: false } : a,
  );
  if (defaultIndex <= 0) return normalised;
  const first = normalised[defaultIndex];
  return first === undefined
    ? normalised
    : [first, ...normalised.slice(0, defaultIndex), ...normalised.slice(defaultIndex + 1)];
}

export interface ListSnapshot {
  readonly ids: readonly string[];
  readonly defaultId: string | null;
}

export function snapshotOf(sorted: readonly SavedAddress[]): ListSnapshot {
  return { ids: sorted.map((a) => a.id), defaultId: sorted.find((a) => a.isDefault)?.id ?? null };
}

export function sameSnapshot(a: ListSnapshot, b: ListSnapshot): boolean {
  return a.defaultId === b.defaultId && a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i]);
}

/**
 * Where focus goes after the list changed under a JS action (applied only
 * when focus was lost, i.e. the focused control was removed):
 * - "card": heading of the card at `index` in the new list
 * - "heading": the book heading
 * - "limit": the limit notice (falls back to the new card when absent)
 */
export type FocusTarget =
  | { readonly kind: "card"; readonly index: number }
  | { readonly kind: "heading" }
  | { readonly kind: "limit"; readonly fallbackIndex: number };

export interface ChangePlan {
  readonly change: "deleted" | "added" | "default";
  readonly target: FocusTarget;
  /** Text for the polite status region ("" = announce nothing; the molecule announces itself). */
  readonly announcement: string;
}

/**
 * Pure diff of two snapshots.
 * - Deleted: focus the card that took the removed card's place (the next one),
 *   else the new last card, else the heading; announce "Address deleted."
 *   (AddressCard's own success notice unmounts with the card).
 * - Added: the add form stays mounted unless the limit was reached, so focus
 *   the limit notice and announce "Address saved." (the form's notice is gone).
 * - Default changed (same ids): focus the new default card; the card's own
 *   live region announces the result.
 */
export function planAfterChange(prev: ListSnapshot, next: ListSnapshot): ChangePlan | null {
  if (sameSnapshot(prev, next)) return null;
  const nextSet = new Set(next.ids);
  const prevSet = new Set(prev.ids);
  const firstRemoved = prev.ids.findIndex((id) => !nextSet.has(id));
  const added = next.ids.filter((id) => !prevSet.has(id));

  if (firstRemoved !== -1 && added.length === 0) {
    if (next.ids.length === 0) {
      return { change: "deleted", target: { kind: "heading" }, announcement: ADDRESS_DELETED_TEXT };
    }
    const successor = prev.ids.slice(firstRemoved + 1).find((id) => nextSet.has(id));
    const index = successor !== undefined ? next.ids.indexOf(successor) : next.ids.length - 1;
    return { change: "deleted", target: { kind: "card", index }, announcement: ADDRESS_DELETED_TEXT };
  }
  if (added.length > 0) {
    const addedId = added[0];
    const index = addedId === undefined ? 0 : Math.max(0, next.ids.indexOf(addedId));
    return { change: "added", target: { kind: "limit", fallbackIndex: index }, announcement: ADDRESS_SAVED_TEXT };
  }
  if (next.defaultId !== null && next.defaultId !== prev.defaultId) {
    return {
      change: "default",
      target: { kind: "card", index: Math.max(0, next.ids.indexOf(next.defaultId)) },
      announcement: "",
    };
  }
  return null;
}
