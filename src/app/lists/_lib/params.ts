import { DEFAULT_LIST_SORT, isListSort, type ListSort } from "@/server/lists/list-service";

/**
 * Query/route param parsing for the lists pages (T99, page-parser rule):
 * every value is validated here before it reaches the loader or ListView.
 * Pure module: no `next/*`, no DB.
 */

export type SearchParamValue = string | string[] | undefined;
export type SearchParamsRecord = Readonly<Record<string, SearchParamValue>>;

/** Lists are created with `crypto.randomUUID()`: canonical lower-case hyphenated UUID. */
const LIST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIST_ID_LENGTH = 36;

/** Share tokens: 16 random bytes, base64url without padding (service README). */
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const SHARE_TOKEN_LENGTH = 22;

/** Length is checked first so huge values never reach the regex. */
export function isListIdShape(value: unknown): value is string {
  return typeof value === "string" && value.length === LIST_ID_LENGTH && LIST_ID_RE.test(value);
}

export function isShareTokenShape(value: unknown): value is string {
  return typeof value === "string" && value.length === SHARE_TOKEN_LENGTH && SHARE_TOKEN_RE.test(value);
}

/** Single value of a search param; repeated params (`?a=1&a=2`) count as absent. */
export function singleParam(value: SearchParamValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `?sort=` validated against `ListSort`; anything else is the default (criterion 3). */
export function parseListSort(value: SearchParamValue): ListSort {
  const raw = singleParam(value);
  return isListSort(raw) ? raw : DEFAULT_LIST_SORT;
}

/** `?flag=1` is true; any other value (or a repeated param) is false. */
export function parseFlag(value: SearchParamValue): boolean {
  return singleParam(value) === "1";
}

/** Errors the index "Create a list" form can report via `?createError=` (redirect from the adapter). */
export const CREATE_ERROR_MESSAGES = {
  TOO_LONG: "List names can be up to 60 characters.",
  VALIDATION_FAILED: "Enter a name for your list.",
  LIMIT_REACHED: "You have reached the maximum of 20 lists. Delete one to create another.",
  RATE_LIMITED: "Too many changes in a short time. Please try again later.",
  UNKNOWN: "We could not create that list. Please try again.",
} as const;

export type CreateErrorCode = keyof typeof CREATE_ERROR_MESSAGES;

function isCreateErrorCode(value: unknown): value is CreateErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CREATE_ERROR_MESSAGES, value);
}

/** Known code -> itself; any other non-empty value -> "UNKNOWN"; absent -> null. Never echoes input. */
export function parseCreateError(value: SearchParamValue): CreateErrorCode | null {
  const raw = singleParam(value);
  if (raw === undefined || raw === "") return null;
  return isCreateErrorCode(raw) ? raw : "UNKNOWN";
}

export interface ListsIndexParams {
  readonly deleted: boolean;
  readonly created: boolean;
  readonly createError: CreateErrorCode | null;
}

export function parseIndexParams(params: SearchParamsRecord): ListsIndexParams {
  return {
    deleted: parseFlag(params.deleted),
    created: parseFlag(params.created),
    createError: parseCreateError(params.createError),
  };
}
