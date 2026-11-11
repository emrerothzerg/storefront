import type { ListActionState } from "../_contracts/list-actions";

type ListActionFailure = Extract<NonNullable<ListActionState>, { ok: false }>;

/** Narrows a list action state to its failure branch. */
export function isListFailure(state: ListActionState): state is ListActionFailure {
  return state !== null && state.ok === false;
}

/**
 * User-facing text for a failed list action. RATE_LIMITED is rebuilt from
 * `retryAfterSeconds` as whole minutes (rounded up, at least 1); every other
 * code uses the action's user-safe `message`, with a generic fallback when it
 * is blank. Shared by WishlistButton, ListItemRow and ShareListPanel.
 */
export function listErrorMessage(state: ListActionFailure): string {
  if (state.error.code === "RATE_LIMITED") {
    const seconds = state.retryAfterSeconds;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
      const minutes = Math.max(1, Math.ceil(seconds / 60));
      return `Too many requests. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
    }
    return "Too many requests. Please try again later.";
  }
  const message = typeof state.message === "string" ? state.message.trim() : "";
  return message !== "" ? message : "Something went wrong. Please try again.";
}
