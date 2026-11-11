import type {
  ListActionFn,
  ListActionState,
  ListActionSuccess,
  ListAddAllItemResult,
  ListFieldName,
  ListSharingMode,
} from "@/components/molecules/_contracts/list-actions";
import { LIST_FIELD, LIST_INPUT_LIMITS, LIST_SHARING_MODES, sharedListPath } from "@/components/molecules/_contracts/list-actions";
import { appError, type AppError, type Result } from "@/lib/result";
import type { CartService } from "@/server/cart/cart-service";
import type { ListService } from "@/server/lists/list-service";
import { limitAction, type RateLimiter } from "@/server/security/rate-limiter";
import { cleanText } from "@/server/security/text-guard";

/**
 * Framework-free list action logic (T48). `lists.ts` wires these to Next.js
 * (`getOrCreateSessionId`, `readSessionId`, `getListService()`,
 * `getCartService()`, `getRateLimiter()`, `revalidatePath`); tests inject
 * fakes. Contract: `src/components/molecules/_contracts/list-actions.ts`.
 *
 * Order of every action: parse the form (nothing else is read) -> session
 * (`addToList` / `createList`: getOrCreateSessionId, lazily after parsing;
 * all others: readSessionId, no cookie = NOT_FOUND) -> rate limit "list.mutate" -> service -> revalidate.
 * Unexpected exceptions become a generic error state and are logged as an
 * error code + action name only (never ids, input or share tokens).
 */

export interface ListActionDeps {
  readonly lists: ListService;
  readonly cart: Pick<CartService, "addItem">;
  readonly limiter: RateLimiter;
  readonly getOrCreateSessionId: () => Promise<string>;
  readonly readSessionId: () => Promise<string | null>;
  readonly revalidatePath: (path: string, type?: "page" | "layout") => void;
  /** Reserved: the list service and limiter carry their own clocks; currently unused. */
  readonly now?: () => number;
  /** Defaults to `console`. Receives error codes only. */
  readonly logger?: Pick<Console, "error">;
}

export interface ListActions {
  readonly addToList: ListActionFn;
  readonly removeFromList: ListActionFn;
  readonly updateListItem: ListActionFn;
  readonly moveListItem: ListActionFn;
  readonly createList: ListActionFn;
  readonly renameList: ListActionFn;
  readonly deleteList: ListActionFn;
  readonly setListSharing: ListActionFn;
  readonly addAllToCart: ListActionFn;
}

export type ListActionName = keyof ListActions;

/** Matches the service's longest accepted id. */
export const LIST_ID_MAX_LENGTH = 200;
export const PRODUCT_SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;
export const RETURN_TO_MAX_LENGTH = 512;
export const LISTS_PATH = "/lists";
export const CART_PATH = "/cart";

/** Logged (with the action name) when an action hits an unexpected exception. */
export const LIST_ACTION_FAILED = "LIST_ACTION_FAILED";

export const LIST_MESSAGES = {
  added: "Added to your list.",
  alreadyPresent: "This item is already in your list.",
  removed: "Removed from your list.",
  updated: "List item updated.",
  moved: "Item moved.",
  created: "List created.",
  renamed: "List renamed.",
  deleted: "List deleted.",
  sharingEnabled: "Sharing is on. Anyone with the link can view this list.",
  sharingDisabled: "Sharing is off. The old link no longer works.",
  sharingRotated: "A new link was created. The old link no longer works.",
  addAllEmpty: "This list has no items to add.",
  addAllNone: "None of these items could be added to your cart.",
  invalidRequest: "Something was wrong with that request.",
  notFound: "We couldn't find that list or item.",
  productNotFound: "This product is no longer available.",
  listsLimit: `You can have up to ${LIST_INPUT_LIMITS.maxListsPerSession} lists. Delete one to create another.`,
  itemsLimit: `A list can hold up to ${LIST_INPUT_LIMITS.maxItemsPerList} items. Remove one to add another.`,
  quantity: `Please enter a whole number from ${LIST_INPUT_LIMITS.quantityMin} to ${LIST_INPUT_LIMITS.quantityMax}.`,
  priority: "Please choose low, medium or high priority.",
  nameRequired: "Please enter a list name.",
  nameTooLong: `List names can be up to ${LIST_INPUT_LIMITS.nameMax} characters.`,
  noteTooLong: `Notes can be up to ${LIST_INPUT_LIMITS.noteMax} characters.`,
  confirmRequired: "Please confirm that you want to delete this list.",
  forbiddenDelete: "This list can't be deleted. You need at least one other wish list first.",
  forbiddenRename: "This list can't be renamed.",
  forbiddenSharing: "This list can't be shared.",
  forbidden: "This list can't be changed that way.",
  rateLimitedFallback: "Too many requests. Please try again later.",
  unexpected: "Something went wrong. Please try again.",
} as const;

// ---------------------------------------------------------------------------
// State builders
// ---------------------------------------------------------------------------

type ListActionFailure = Extract<ListActionState, { ok: false }>;
type FieldErrors = Readonly<Record<string, string>>;
type EchoValues = Readonly<Record<string, string>>;

interface FailureExtras {
  readonly fieldErrors?: FieldErrors;
  readonly retryAfterSeconds?: number;
}

/** Expected failure while parsing or from a service, before the echo values are attached. */
interface ActionFailure {
  readonly error: AppError;
  readonly extras: FailureExtras;
}

function failure(error: AppError, extras: FailureExtras = {}): ActionFailure {
  return { error, extras };
}

function toState(f: ActionFailure, values: EchoValues): ListActionFailure {
  const base = { ok: false as const, error: f.error, message: f.error.message };
  const withFields = f.extras.fieldErrors === undefined ? base : { ...base, fieldErrors: f.extras.fieldErrors };
  const withValues = Object.keys(values).length === 0 ? withFields : { ...withFields, values };
  return f.extras.retryAfterSeconds === undefined
    ? withValues
    : { ...withValues, retryAfterSeconds: f.extras.retryAfterSeconds };
}

/** Generic state for unexpected exceptions. No internal detail leaves the server. */
export function unexpectedErrorState(): ListActionFailure {
  return toState(failure(appError("VALIDATION_FAILED", LIST_MESSAGES.unexpected, { reason: "unexpected" })), {});
}

function invalidField(field: ListFieldName, message: string = LIST_MESSAGES.invalidRequest): ActionFailure {
  return failure(appError("INVALID_INPUT", message, { field }));
}

function fieldFailure(code: AppError["code"], field: ListFieldName, message: string, details?: Record<string, unknown>): ActionFailure {
  return failure(appError(code, message, { ...details, field }), { fieldErrors: { [field]: message } });
}

function notFound(): ActionFailure {
  return failure(appError("NOT_FOUND", LIST_MESSAGES.notFound));
}

// ---------------------------------------------------------------------------
// Parsing (only LIST_FIELD names are ever read)
// ---------------------------------------------------------------------------

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: ActionFailure };

function parsed<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function rejected(f: ActionFailure): Parsed<never> {
  return { ok: false, failure: f };
}

/**
 * Reads an id field: a string, trimmed, 1..200 chars. Missing or empty is
 * allowed only when `required` is false (returns null). Anything else is
 * INVALID_INPUT with `details.field`.
 */
export function parseIdField(
  formData: FormData,
  field: "listId" | "toListId" | "productId",
  required: boolean,
): Parsed<string | null> {
  const raw = formData.get(LIST_FIELD[field]);
  if (raw === null) return required ? rejected(invalidField(LIST_FIELD[field])) : parsed(null);
  if (typeof raw !== "string" || raw.length > LIST_ID_MAX_LENGTH * 4) return rejected(invalidField(LIST_FIELD[field]));
  const value = raw.trim();
  if (value.length === 0) return required ? rejected(invalidField(LIST_FIELD[field])) : parsed(null);
  if (value.length > LIST_ID_MAX_LENGTH) return rejected(invalidField(LIST_FIELD[field]));
  return parsed(value);
}

function requiredId(formData: FormData, field: "listId" | "toListId" | "productId"): Parsed<string> {
  const result = parseIdField(formData, field, true);
  if (!result.ok) return result;
  return result.value === null ? rejected(invalidField(LIST_FIELD[field])) : parsed(result.value);
}

const QUANTITY_PATTERN = /^\d{1,2}$/;

/**
 * `quantityDesired`: absent or empty -> undefined (default / unchanged);
 * otherwise 1-2 ASCII digits in 1..99, else INVALID_QUANTITY. Rejects 0, -1,
 * 2.5, "abc", 100.
 */
export function parseQuantityDesired(formData: FormData): Parsed<number | undefined> {
  const raw = formData.get(LIST_FIELD.quantityDesired);
  if (raw === null) return parsed(undefined);
  const bad = rejected(
    fieldFailure("INVALID_QUANTITY", LIST_FIELD.quantityDesired, LIST_MESSAGES.quantity, {
      max: LIST_INPUT_LIMITS.quantityMax,
    }),
  );
  if (typeof raw !== "string" || raw.length > 16) return bad;
  const value = raw.trim();
  if (value.length === 0) return parsed(undefined);
  if (!QUANTITY_PATTERN.test(value)) return bad;
  const n = Number(value);
  return n >= LIST_INPUT_LIMITS.quantityMin && n <= LIST_INPUT_LIMITS.quantityMax ? parsed(n) : bad;
}

/** `priority`: absent or empty -> undefined; "0" | "1" | "2" -> number; else VALIDATION_FAILED. */
export function parsePriority(formData: FormData): Parsed<0 | 1 | 2 | undefined> {
  const raw = formData.get(LIST_FIELD.priority);
  if (raw === null) return parsed(undefined);
  const value = typeof raw === "string" && raw.length <= 16 ? raw.trim() : null;
  if (value === "") return parsed(undefined);
  if (value === "0") return parsed(0);
  if (value === "1") return parsed(1);
  if (value === "2") return parsed(2);
  return rejected(fieldFailure("VALIDATION_FAILED", LIST_FIELD.priority, LIST_MESSAGES.priority));
}

/**
 * `note`: absent -> undefined (unchanged); otherwise cleaned (multiline, max
 * 200): empty after cleaning -> null (clear), too long -> TOO_LONG.
 */
export function parseNote(formData: FormData): Parsed<string | null | undefined> {
  const raw = formData.get(LIST_FIELD.note);
  if (raw === null) return parsed(undefined);
  if (typeof raw !== "string") return rejected(invalidField(LIST_FIELD.note));
  const cleaned = cleanText(raw, { max: LIST_INPUT_LIMITS.noteMax, multiline: true });
  if (!cleaned.ok) {
    return cleaned.error.code === "TOO_LONG"
      ? rejected(fieldFailure("TOO_LONG", LIST_FIELD.note, LIST_MESSAGES.noteTooLong, { max: LIST_INPUT_LIMITS.noteMax }))
      : rejected(invalidField(LIST_FIELD.note));
  }
  return parsed(cleaned.value === "" ? null : cleaned.value);
}

/** `name`: required; cleaned single line, 1..60 chars. */
export function parseName(formData: FormData): Parsed<string> {
  const raw = formData.get(LIST_FIELD.name);
  if (raw === null) return rejected(fieldFailure("VALIDATION_FAILED", LIST_FIELD.name, LIST_MESSAGES.nameRequired));
  if (typeof raw !== "string") return rejected(invalidField(LIST_FIELD.name));
  const cleaned = cleanText(raw, { max: LIST_INPUT_LIMITS.nameMax, min: 1 });
  if (cleaned.ok) return parsed(cleaned.value);
  if (cleaned.error.code === "TOO_LONG") {
    return rejected(fieldFailure("TOO_LONG", LIST_FIELD.name, LIST_MESSAGES.nameTooLong, { max: LIST_INPUT_LIMITS.nameMax }));
  }
  return rejected(fieldFailure("VALIDATION_FAILED", LIST_FIELD.name, LIST_MESSAGES.nameRequired));
}

export function parseMode(formData: FormData): Parsed<ListSharingMode> {
  const raw = formData.get(LIST_FIELD.mode);
  const mode = LIST_SHARING_MODES.find((m) => m === raw);
  return mode === undefined ? rejected(invalidField(LIST_FIELD.mode)) : parsed(mode);
}

/** `confirm` must be exactly "yes". */
export function parseConfirm(formData: FormData): Parsed<true> {
  return formData.get(LIST_FIELD.confirm) === "yes"
    ? parsed(true)
    : rejected(invalidField(LIST_FIELD.confirm, LIST_MESSAGES.confirmRequired));
}

/** Optional `productSlug`: returned only when it matches `^[a-z0-9-]{1,100}$`, else null (never an error). */
export function parseProductSlug(formData: FormData): string | null {
  const raw = formData.get(LIST_FIELD.productSlug);
  if (typeof raw !== "string" || raw.length > 100) return null;
  return PRODUCT_SLUG_PATTERN.test(raw) ? raw : null;
}

/** Path characters allowed in `returnTo` (RFC 3986 pchar + "/", no "\" or controls). */
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;

/**
 * Optional `returnTo`: a same-origin absolute path ("/products/x?y#z" -> "/products/x").
 * Protocol-relative ("//host"), backslashes, schemes, dot segments and control
 * characters are rejected (null, never an error). Used for revalidation only.
 */
export function parseReturnTo(formData: FormData): string | null {
  const raw = formData.get(LIST_FIELD.returnTo);
  if (typeof raw !== "string" || raw.length === 0 || raw.length > RETURN_TO_MAX_LENGTH) return null;
  const path = raw.split(/[?#]/, 1)[0] ?? "";
  if (!SAFE_PATH_PATTERN.test(path) || path.startsWith("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.startsWith("//") || decoded.includes("\\") || /\p{Cc}/u.test(decoded)) return null;
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return path;
}

/** Cuts to `max` UTF-16 units without leaving a dangling high surrogate. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Echo of `name` / `note` for re-filling the form after an error: control
 * characters removed (line breaks kept in notes), truncated to the field limit.
 */
export function echoValues(formData: FormData, fields: readonly ("name" | "note")[]): EchoValues {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const raw = formData.get(LIST_FIELD[field]);
    if (typeof raw !== "string" || raw.length === 0) continue;
    const max = field === "name" ? LIST_INPUT_LIMITS.nameMax : LIST_INPUT_LIMITS.noteMax;
    const head = raw.slice(0, max * 4);
    const stripped = field === "note" ? head.replace(/(?![\n\r])\p{Cc}/gu, "") : head.replace(/\p{Cc}/gu, " ");
    out[LIST_FIELD[field]] = truncate(stripped, max);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function readPositiveInt(details: AppError["details"], key: string): number | undefined {
  const value = details?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.ceil(value);
}

export function rateLimitedMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return LIST_MESSAGES.rateLimitedFallback;
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many requests. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

const NAME_ACTIONS: ReadonlySet<ListActionName> = new Set(["createList", "renameList"]);

function forbiddenMessage(action: ListActionName): string {
  switch (action) {
    case "deleteList":
      return LIST_MESSAGES.forbiddenDelete;
    case "renameList":
      return LIST_MESSAGES.forbiddenRename;
    case "setListSharing":
      return LIST_MESSAGES.forbiddenSharing;
    default:
      return LIST_MESSAGES.forbidden;
  }
}

/**
 * Maps a service or limiter error to a user-safe failure. `details` is rebuilt
 * from a whitelist so raw input (ids, names) never reaches the client, and
 * every NOT_FOUND carries the same message (no existence oracle).
 */
export function mapError(action: ListActionName, error: AppError): ActionFailure {
  switch (error.code) {
    case "RATE_LIMITED": {
      const retryAfterSeconds = readPositiveInt(error.details, "retryAfterSeconds");
      const message = rateLimitedMessage(retryAfterSeconds);
      return retryAfterSeconds === undefined
        ? failure(appError("RATE_LIMITED", message))
        : failure(appError("RATE_LIMITED", message, { retryAfterSeconds }), { retryAfterSeconds });
    }
    case "NOT_FOUND":
    case "LIST_NOT_FOUND":
      return notFound();
    case "PRODUCT_NOT_FOUND":
      return failure(appError("PRODUCT_NOT_FOUND", LIST_MESSAGES.productNotFound));
    case "LIMIT_REACHED":
      return action === "createList"
        ? failure(appError("LIMIT_REACHED", LIST_MESSAGES.listsLimit, { max: LIST_INPUT_LIMITS.maxListsPerSession }))
        : failure(appError("LIMIT_REACHED", LIST_MESSAGES.itemsLimit, { max: LIST_INPUT_LIMITS.maxItemsPerList }));
    case "FORBIDDEN":
      return failure(appError("FORBIDDEN", forbiddenMessage(action)));
    case "INVALID_QUANTITY":
      return fieldFailure("INVALID_QUANTITY", LIST_FIELD.quantityDesired, LIST_MESSAGES.quantity, {
        max: LIST_INPUT_LIMITS.quantityMax,
      });
    case "TOO_LONG":
      return NAME_ACTIONS.has(action)
        ? fieldFailure("TOO_LONG", LIST_FIELD.name, LIST_MESSAGES.nameTooLong, { max: LIST_INPUT_LIMITS.nameMax })
        : fieldFailure("TOO_LONG", LIST_FIELD.note, LIST_MESSAGES.noteTooLong, { max: LIST_INPUT_LIMITS.noteMax });
    case "VALIDATION_FAILED":
      if (error.details?.field === "priority") {
        return fieldFailure("VALIDATION_FAILED", LIST_FIELD.priority, LIST_MESSAGES.priority);
      }
      return NAME_ACTIONS.has(action)
        ? fieldFailure("VALIDATION_FAILED", LIST_FIELD.name, LIST_MESSAGES.nameRequired)
        : failure(appError("VALIDATION_FAILED", LIST_MESSAGES.invalidRequest));
    default:
      return failure(appError(error.code, LIST_MESSAGES.invalidRequest));
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Thrown inside an action body to return an expected failure (never escapes `settled`). */
class Stop extends Error {
  constructor(readonly failure: ActionFailure) {
    super("stop");
  }
}

function take<T>(result: Parsed<T>): T {
  if (!result.ok) throw new Stop(result.failure);
  return result.value;
}

function readNonNegativeInt(details: AppError["details"], key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function createListActions(deps: ListActionDeps): ListActions {
  const { lists, cart, limiter, getOrCreateSessionId, readSessionId, revalidatePath } = deps;
  const logger = deps.logger ?? console;

  function logFailure(action: ListActionName | "addAllToCart.item"): void {
    // Error code + action name only: exceptions may carry ids, input or tokens.
    logger.error(`[lists] ${LIST_ACTION_FAILED} action=${action}`);
  }

  function unwrap<T>(action: ListActionName, result: Result<T>): T {
    if (!result.ok) throw new Stop(mapError(action, result.error));
    return result.value;
  }

  /** Existing session only; no cookie -> NOT_FOUND (nothing created). Then the rate limit. */
  async function existingSession(action: ListActionName): Promise<string> {
    const sessionId = await readSessionId();
    if (sessionId === null) throw new Stop(notFound());
    unwrap(action, limitAction(limiter, "list.mutate", sessionId));
    return sessionId;
  }

  function revalidateLists(listIds: readonly string[]): void {
    revalidatePath(LISTS_PATH);
    for (const id of new Set(listIds)) revalidatePath(`${LISTS_PATH}/${id}`);
  }

  /** Product page and `returnTo` path, when posted and valid. */
  function revalidateExtras(formData: FormData): void {
    const slug = parseProductSlug(formData);
    if (slug !== null) revalidatePath(`/products/${slug}`);
    const returnTo = parseReturnTo(formData);
    if (returnTo !== null) revalidatePath(returnTo);
  }

  /** The cart page renders the save-for-later list; revalidate it when that list changed. */
  function revalidateCartIfSaveForLater(sessionId: string, listIds: readonly string[]): void {
    let touches: boolean;
    try {
      touches = lists.listLists(sessionId).some((l) => l.kind === "save_for_later" && listIds.includes(l.id));
    } catch {
      touches = true;
    }
    if (touches) revalidatePath(CART_PATH);
  }

  function settled(
    action: ListActionName,
    echo: readonly ("name" | "note")[],
    body: (formData: FormData) => Promise<ListActionSuccess>,
  ): ListActionFn {
    return async (_prevState, formData) => {
      try {
        return await body(formData);
      } catch (e) {
        if (e instanceof Stop) return toState(e.failure, echoValues(formData, echo));
        logFailure(action);
        return unexpectedErrorState();
      }
    };
  }

  const addToList = settled("addToList", ["note"], async (formData) => {
    const productId = take(requiredId(formData, "productId"));
    const listId = take(parseIdField(formData, "listId", false));
    const quantityDesired = take(parseQuantityDesired(formData));
    const priority = take(parsePriority(formData));
    const note = take(parseNote(formData));

    const sessionId = await getOrCreateSessionId();
    unwrap("addToList", limitAction(limiter, "list.mutate", sessionId));
    const result = unwrap(
      "addToList",
      lists.addItem(sessionId, listId, productId, { quantityDesired, priority, note }),
    );
    if (!result.alreadyPresent) {
      revalidateLists([result.listId]);
      revalidateCartIfSaveForLater(sessionId, [result.listId]);
    }
    revalidateExtras(formData);
    return result.alreadyPresent
      ? { ok: true, kind: "already_present", message: LIST_MESSAGES.alreadyPresent, listId: result.listId }
      : { ok: true, kind: "added", message: LIST_MESSAGES.added, listId: result.listId };
  });

  const removeFromList = settled("removeFromList", [], async (formData) => {
    const listId = take(requiredId(formData, "listId"));
    const productId = take(requiredId(formData, "productId"));
    const sessionId = await existingSession("removeFromList");
    unwrap("removeFromList", lists.removeItem(sessionId, listId, productId));
    revalidateLists([listId]);
    revalidateCartIfSaveForLater(sessionId, [listId]);
    revalidateExtras(formData);
    return { ok: true, kind: "removed", message: LIST_MESSAGES.removed, listId };
  });

  const updateListItem = settled("updateListItem", ["note"], async (formData) => {
    const listId = take(requiredId(formData, "listId"));
    const productId = take(requiredId(formData, "productId"));
    const quantityDesired = take(parseQuantityDesired(formData));
    const priority = take(parsePriority(formData));
    const note = take(parseNote(formData));
    const sessionId = await existingSession("updateListItem");
    unwrap("updateListItem", lists.updateItem(sessionId, listId, productId, { quantityDesired, priority, note }));
    revalidateLists([listId]);
    revalidateCartIfSaveForLater(sessionId, [listId]);
    revalidateExtras(formData);
    return { ok: true, kind: "updated", message: LIST_MESSAGES.updated, listId };
  });

  const moveListItem = settled("moveListItem", [], async (formData) => {
    const fromListId = take(requiredId(formData, "listId"));
    const toListId = take(requiredId(formData, "toListId"));
    const productId = take(requiredId(formData, "productId"));
    const sessionId = await existingSession("moveListItem");
    unwrap("moveListItem", lists.moveItem(sessionId, fromListId, toListId, productId));
    revalidateLists([fromListId, toListId]);
    revalidateCartIfSaveForLater(sessionId, [fromListId, toListId]);
    revalidateExtras(formData);
    return { ok: true, kind: "moved", message: LIST_MESSAGES.moved, listId: toListId };
  });

  const createList = settled("createList", ["name"], async (formData) => {
    const name = take(parseName(formData));
    const sessionId = await getOrCreateSessionId(); // first interaction allowed (ruling 2026-11-07)
    unwrap("createList", limitAction(limiter, "list.mutate", sessionId));
    const list = unwrap("createList", lists.createList(sessionId, name));
    revalidateLists([list.id]);
    revalidateExtras(formData);
    return { ok: true, kind: "created", message: LIST_MESSAGES.created, listId: list.id };
  });

  const renameList = settled("renameList", ["name"], async (formData) => {
    const listId = take(requiredId(formData, "listId"));
    const name = take(parseName(formData));
    const sessionId = await existingSession("renameList");
    unwrap("renameList", lists.renameList(sessionId, listId, name));
    revalidateLists([listId]);
    revalidateExtras(formData);
    return { ok: true, kind: "renamed", message: LIST_MESSAGES.renamed, listId };
  });

  const deleteList = settled("deleteList", [], async (formData) => {
    const listId = take(requiredId(formData, "listId"));
    take(parseConfirm(formData));
    const sessionId = await existingSession("deleteList");
    unwrap("deleteList", lists.deleteList(sessionId, listId));
    revalidateLists([listId]);
    revalidateExtras(formData);
    return { ok: true, kind: "deleted", message: LIST_MESSAGES.deleted, listId };
  });

  const setListSharing = settled("setListSharing", [], async (formData) => {
    const listId = take(requiredId(formData, "listId"));
    const mode = take(parseMode(formData));
    const sessionId = await existingSession("setListSharing");
    const { shareToken } = unwrap("setListSharing", lists.setSharing(sessionId, listId, mode));
    revalidateLists([listId]);
    revalidateExtras(formData);
    const message =
      mode === "disable"
        ? LIST_MESSAGES.sharingDisabled
        : mode === "rotate"
          ? LIST_MESSAGES.sharingRotated
          : LIST_MESSAGES.sharingEnabled;
    return {
      ok: true,
      kind: "sharing",
      message,
      listId,
      sharePath: shareToken === null ? null : sharedListPath(shareToken),
    };
  });

  /** One item, atomic (each `cart.addItem` is its own transaction). Never throws. */
  function addOneToCart(
    sessionId: string,
    productId: string,
    quantity: number,
  ): { result: ListAddAllItemResult; addedAny: boolean } {
    try {
      const first = cart.addItem(sessionId, productId, quantity);
      if (first.ok) return { result: "added", addedAny: true };
      switch (first.error.code) {
        case "OUT_OF_STOCK":
          return { result: "out_of_stock", addedAny: false };
        case "PRODUCT_NOT_FOUND":
          return { result: "unavailable", addedAny: false };
        case "INSUFFICIENT_STOCK": {
          const available = readNonNegativeInt(first.error.details, "available");
          if (available === undefined || available < 1) return { result: "capped", addedAny: false };
          const retry = cart.addItem(sessionId, productId, Math.min(available, quantity));
          if (retry.ok) return { result: "capped", addedAny: true };
          if (retry.error.code === "OUT_OF_STOCK") return { result: "out_of_stock", addedAny: false };
          if (retry.error.code === "PRODUCT_NOT_FOUND") return { result: "unavailable", addedAny: false };
          return { result: "capped", addedAny: false };
        }
        case "INVALID_QUANTITY":
          // The cart line would exceed the per-line maximum: the cart already holds the most allowed.
          return { result: "capped", addedAny: false };
        default:
          return { result: "unavailable", addedAny: false };
      }
    } catch {
      logFailure("addAllToCart.item");
      return { result: "unavailable", addedAny: false };
    }
  }

  const addAllToCart = settled("addAllToCart", [], async (formData) => {
    const listId = take(requiredId(formData, "listId"));
    const sessionId = await existingSession("addAllToCart");
    const view = unwrap("addAllToCart", lists.getList(sessionId, listId));

    const perItem: { productId: string; result: ListAddAllItemResult }[] = [];
    let addedCount = 0;
    let cappedCount = 0;
    let skippedCount = 0;
    for (const item of view.items) {
      const outcome: { result: ListAddAllItemResult; addedAny: boolean } =
        item.product === null
          ? { result: "unavailable", addedAny: false }
          : !item.available
            ? { result: "out_of_stock", addedAny: false }
            : addOneToCart(sessionId, item.productId, item.quantityDesired);
      perItem.push({ productId: item.productId, result: outcome.result });
      if (outcome.addedAny) addedCount++;
      if (outcome.result === "capped") cappedCount++;
      if (outcome.result === "out_of_stock" || outcome.result === "unavailable") skippedCount++;
    }

    if (addedCount > 0) {
      revalidatePath(CART_PATH);
      revalidatePath("/", "layout"); // header cart count
    }
    revalidateExtras(formData);
    return { ok: true, kind: "add_all", message: addAllMessage(view.items.length, addedCount, cappedCount, skippedCount), listId, perItem };
  });

  return {
    addToList,
    removeFromList,
    updateListItem,
    moveListItem,
    createList,
    renameList,
    deleteList,
    setListSharing,
    addAllToCart,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function addAllMessage(total: number, added: number, capped: number, skipped: number): string {
  if (total === 0) return LIST_MESSAGES.addAllEmpty;
  if (added === 0) return LIST_MESSAGES.addAllNone;
  const parts = [`Added ${plural(added, "item", "items")} to your cart.`];
  if (capped > 0) parts.push("Some quantities were limited by available stock.");
  if (skipped > 0) parts.push(`${plural(skipped, "unavailable item was", "unavailable items were")} skipped.`);
  return parts.join(" ");
}
