import { LIST_INPUT_LIMITS, LIST_PRIORITY_VALUES } from "../_contracts/list-actions";

/**
 * Client-side mirrors of the list service limits (quantity 1..99 digits only,
 * priority 0/1/2, note <= 200). The server stays authoritative; these only
 * give inline hints before a round trip. Messages match the server's wording.
 */

export const QUANTITY_ERROR = `Please enter a whole number from ${LIST_INPUT_LIMITS.quantityMin} to ${LIST_INPUT_LIMITS.quantityMax}.`;
export const PRIORITY_ERROR = "Please choose low, medium or high priority.";
export const NOTE_ERROR = `Notes can be up to ${LIST_INPUT_LIMITS.noteMax} characters.`;
export const QUANTITY_HINT = `Whole number, ${LIST_INPUT_LIMITS.quantityMin} to ${LIST_INPUT_LIMITS.quantityMax}.`;
export const NOTE_HINT = `Optional, up to ${LIST_INPUT_LIMITS.noteMax} characters.`;

export const PRIORITY_LABELS: Readonly<Record<(typeof LIST_PRIORITY_VALUES)[number], string>> = {
  "0": "Low",
  "1": "Medium",
  "2": "High",
};

/** Mirrors `QUANTITY_PATTERN` in src/app/actions/lists-core.ts exactly (1-2 ASCII digits). */
export const QUANTITY_PATTERN = /^\d{1,2}$/;

export function validateQuantity(raw: string): string | null {
  const value = raw.trim();
  if (!QUANTITY_PATTERN.test(value)) return QUANTITY_ERROR;
  const n = Number(value);
  return n >= LIST_INPUT_LIMITS.quantityMin && n <= LIST_INPUT_LIMITS.quantityMax ? null : QUANTITY_ERROR;
}

export function validatePriority(raw: string): string | null {
  return (LIST_PRIORITY_VALUES as readonly string[]).includes(raw) ? null : PRIORITY_ERROR;
}

export function validateNote(raw: string): string | null {
  return raw.length <= LIST_INPUT_LIMITS.noteMax ? null : NOTE_ERROR;
}

export function priorityLabel(priority: number): string {
  return priority === 2 ? "High" : priority === 1 ? "Medium" : "Low";
}
