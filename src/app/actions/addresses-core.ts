import type {
  AddressActionFn,
  AddressActionState,
  AddressEchoValues,
} from "@/components/molecules/_contracts/address-actions";
import {
  ADDRESS_DELETE_CONFIRM_VALUE,
  ADDRESS_FIELD,
  ADDRESS_MAX_LENGTH,
} from "@/components/molecules/_contracts/address-actions";
import { appError, type AppError } from "@/lib/result";
import {
  AddressStorageError,
  MAX_ADDRESSES_PER_SESSION,
  parseAddressInput,
  type AddressInput,
  type AddressService,
} from "@/server/addresses/address-service";
import { limitAction, type RateLimiter } from "@/server/security/rate-limiter";

/**
 * Framework-free address action logic (T49). `addresses.ts` wires it to
 * Next.js (`getOrCreateSessionId`, `readSessionId`, `getAddressService()`,
 * `getRateLimiter()`, `revalidatePath`); tests inject fakes.
 *
 * Flow of every action:
 * 1. Read only the `ADDRESS_FIELD` strings (a `File` counts as missing).
 * 2. Local checks that need no DB: id shape, `confirm=yes` (delete), and the
 *    service's own pure `parseAddressInput` (save). A failure returns a state
 *    without touching the cookie, the limiter or the service.
 * 3. Owner key: `getOrCreateSessionId()` only for a create; update, delete and
 *    set-default use `readSessionId()` and answer NOT_FOUND when it is null.
 * 4. `limitAction("address.write")` (20/day per session), then the service.
 * 5. Success revalidates `/account/addresses` and `/checkout`.
 *
 * Every outcome is a state. Exceptions (incl. `AddressStorageError`) become a
 * generic error state and one log line holding only an error code: no ids,
 * no address values, no exception message. No redirects.
 */

export interface AddressActionDeps {
  readonly service: AddressService;
  readonly limiter: RateLimiter;
  readonly getOrCreateSessionId: () => Promise<string>;
  readonly readSessionId: () => Promise<string | null>;
  readonly revalidatePath: (path: string, type?: "page" | "layout") => void;
  /** Epoch milliseconds passed to `create`/`update`; service clock when absent. */
  readonly now?: () => number;
  /** Receives only `ADDRESS_ACTION_FAILED` lines; defaults to `console`. */
  readonly logger?: Pick<Console, "error">;
}

export interface AddressActions {
  /** Create when `addressId` is absent or empty, else update. */
  readonly saveAddress: AddressActionFn;
  /** Requires `confirm=yes`. */
  readonly deleteAddress: AddressActionFn;
  readonly setDefaultAddress: AddressActionFn;
}

export const ACCOUNT_ADDRESSES_PATH = "/account/addresses";
export const CHECKOUT_PATH = "/checkout";

/** Logged when an action hits an unexpected exception. */
export const ADDRESS_ACTION_FAILED = "ADDRESS_ACTION_FAILED";

/** Longest id forwarded to the service (mirrors its own cap); longer = NOT_FOUND locally. */
export const ADDRESS_ID_MAX = 64;

export const ADDRESS_MESSAGES = {
  created: "Address saved.",
  updated: "Address updated.",
  deleted: "Address deleted.",
  defaultSet: "Default address updated.",
  invalid: "Some fields are invalid.",
  tooLong: "Some fields are too long.",
  confirmRequired: "Please confirm that you want to delete this address.",
  limitReached: `You can save up to ${MAX_ADDRESSES_PER_SESSION} addresses. Delete one to add another.`,
  duplicate: "You already saved this address.",
  notFound: "Address not found.",
  unavailable: "We could not update your address book. Please try again.",
  rateLimitedFallback: "You have changed your addresses many times today. Please try again later.",
} as const;

export function rateLimitedMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return ADDRESS_MESSAGES.rateLimitedFallback;
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  if (minutes < 120) {
    return `You have changed your addresses many times today. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  const hours = Math.ceil(minutes / 60);
  return `You have changed your addresses many times today. Please try again in ${hours} hours.`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type EchoKey = keyof AddressEchoValues;
type TextKey = Exclude<EchoKey, "isDefault">;

const TEXT_KEYS: readonly TextKey[] = [
  "label",
  "fullName",
  "phone",
  "line1",
  "line2",
  "city",
  "region",
  "postalCode",
  "country",
];
const ECHO_KEYS: readonly EchoKey[] = [...TEXT_KEYS, "isDefault"];
const ECHO_KEY_SET: ReadonlySet<string> = new Set(ECHO_KEYS);

export interface ParsedAddressForm {
  /** `undefined` = create. A non-empty value is forwarded only if it is well formed. */
  readonly addressId: string | undefined;
  /** True when `addressId` was posted but is not a usable id (a `File`, too long). */
  readonly addressIdMalformed: boolean;
  readonly fields: Readonly<Partial<Record<TextKey, string>>>;
  readonly isDefault: string | undefined;
  readonly confirm: string | undefined;
}

function readString(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Reads only the contract fields. Never throws for any FormData content. */
export function parseAddressForm(formData: FormData): ParsedAddressForm {
  const rawId = formData.get(ADDRESS_FIELD.addressId);
  let addressId: string | undefined;
  let addressIdMalformed = false;
  if (rawId !== null) {
    if (typeof rawId !== "string") addressIdMalformed = true;
    else if (rawId.trim() === "") addressId = undefined;
    else if (rawId.length > ADDRESS_ID_MAX) addressIdMalformed = true;
    else addressId = rawId;
  }
  const fields: Partial<Record<TextKey, string>> = {};
  for (const key of TEXT_KEYS) {
    const value = readString(formData, ADDRESS_FIELD[key]);
    if (value !== undefined) fields[key] = value;
  }
  return {
    addressId,
    addressIdMalformed,
    fields,
    isDefault: readString(formData, ADDRESS_FIELD.isDefault),
    confirm: readString(formData, ADDRESS_FIELD.confirm),
  };
}

/** Matches the service's checkbox encodings. */
function isTicked(value: string | undefined): boolean {
  return value === "on" || value === "true" || value === "1";
}

/** Cuts to `max` UTF-16 units without leaving a dangling high surrogate. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Values to re-fill the form with, truncated to the input caps. */
export function echoValues(parsed: ParsedAddressForm): AddressEchoValues {
  const out: { -readonly [K in EchoKey]?: string } = {};
  for (const key of TEXT_KEYS) {
    const value = parsed.fields[key];
    if (value !== undefined) out[key] = truncate(value, ADDRESS_MAX_LENGTH[key]);
  }
  if (isTicked(parsed.isDefault)) out.isDefault = "on";
  return out;
}

/** The service input. `email` is not part of the address book; `line2` absent = undefined. */
export function toAddressInput(parsed: ParsedAddressForm): AddressInput {
  const f = parsed.fields;
  return {
    fullName: f.fullName,
    email: undefined,
    line1: f.line1,
    line2: f.line2,
    city: f.city,
    region: f.region,
    postalCode: f.postalCode,
    country: f.country,
    label: f.label,
    phone: f.phone,
    isDefault: parsed.isDefault,
  };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function errorState(error: AppError, values: AddressEchoValues, retryAfterSeconds?: number): AddressActionState {
  const base = { ok: false as const, error, message: error.message, fieldErrors: {}, values };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

/** Generic state for unexpected failures. No internal detail leaves the server. */
export function unexpectedErrorState(values: AddressEchoValues = {}): AddressActionState {
  return errorState(appError("INVALID_INPUT", ADDRESS_MESSAGES.unavailable, { reason: "unavailable" }), values);
}

/**
 * Builds the field-error state from `{ [field]: { code, message } }` (the
 * service's `details.fields`). Only known fields with a string message are
 * kept; `error.details.fields` carries codes only.
 */
export function fieldErrorState(source: unknown, values: AddressEchoValues): AddressActionState {
  const fieldErrors: Partial<Record<EchoKey, string>> = {};
  const codes: Partial<Record<EchoKey, string>> = {};
  if (isRecord(source)) {
    for (const key of ECHO_KEYS) {
      const entry = source[key];
      if (!isRecord(entry)) continue;
      const { code, message } = entry;
      if (typeof code !== "string" || !CODE_PATTERN.test(code) || typeof message !== "string") continue;
      fieldErrors[key] = message;
      codes[key] = code;
    }
  }
  const all = Object.values(codes);
  const allTooLong = all.length > 0 && all.every((c) => c === "TOO_LONG");
  const error = allTooLong
    ? appError("TOO_LONG", ADDRESS_MESSAGES.tooLong, { fields: codes })
    : appError("VALIDATION_FAILED", ADDRESS_MESSAGES.invalid, { fields: codes });
  return { ok: false, error, message: error.message, fieldErrors, values };
}

function readPositiveInt(details: AppError["details"], key: string): number | undefined {
  const value = details?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.ceil(value);
}

export function notFoundState(values: AddressEchoValues = {}): AddressActionState {
  return errorState(appError("NOT_FOUND", ADDRESS_MESSAGES.notFound), values);
}

/**
 * Maps any service/limiter error to a user-safe state. `details` is rebuilt
 * from a whitelist so raw input never reaches the client.
 */
export function toErrorState(error: AppError, values: AddressEchoValues): AddressActionState {
  switch (error.code) {
    case "VALIDATION_FAILED":
      return fieldErrorState(error.details?.fields, values);
    case "TOO_LONG": {
      // Top-level TOO_LONG: `details: { field, max }` (raw value over 4x its cap).
      const field = error.details?.field;
      if (typeof field === "string" && ECHO_KEY_SET.has(field)) {
        return fieldErrorState({ [field]: { code: "TOO_LONG", message: error.message } }, values);
      }
      return errorState(appError("TOO_LONG", ADDRESS_MESSAGES.tooLong), values);
    }
    case "RATE_LIMITED": {
      const retryAfterSeconds = readPositiveInt(error.details, "retryAfterSeconds");
      const message = rateLimitedMessage(retryAfterSeconds);
      return retryAfterSeconds === undefined
        ? errorState(appError("RATE_LIMITED", message), values)
        : errorState(appError("RATE_LIMITED", message, { retryAfterSeconds }), values, retryAfterSeconds);
    }
    case "LIMIT_REACHED":
      return errorState(appError("LIMIT_REACHED", ADDRESS_MESSAGES.limitReached, { max: MAX_ADDRESSES_PER_SESSION }), values);
    case "DUPLICATE":
      return errorState(appError("DUPLICATE", ADDRESS_MESSAGES.duplicate), values);
    case "NOT_FOUND":
      return notFoundState(values);
    default:
      return unexpectedErrorState(values);
  }
}

/** Only a code-shaped string from an `AddressStorageError`; never the message. */
function failureCode(error: unknown): string {
  if (error instanceof AddressStorageError && CODE_PATTERN.test(error.code)) return error.code;
  return "UNEXPECTED";
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type ActionName = "save" | "delete" | "setDefault";

export function createAddressActions(deps: AddressActionDeps): AddressActions {
  const { service, limiter, getOrCreateSessionId, readSessionId, revalidatePath, now } = deps;
  const logger = deps.logger ?? console;

  function revalidate(): void {
    revalidatePath(ACCOUNT_ADDRESSES_PATH);
    revalidatePath(CHECKOUT_PATH);
  }

  function logFailure(action: ActionName, error: unknown): void {
    // Error code only: the exception may carry ids or submitted text.
    logger.error(`[addresses] ${ADDRESS_ACTION_FAILED} action=${action} code=${failureCode(error)}`);
  }

  const saveAddress: AddressActionFn = async (_prev, formData) => {
    let values: AddressEchoValues = {};
    try {
      const parsed = parseAddressForm(formData);
      values = echoValues(parsed);
      if (parsed.addressIdMalformed) return notFoundState(values);

      const input = toAddressInput(parsed);
      // Pure validation first: a typo spends no rate-limit token and sets no cookie.
      const local = parseAddressInput(input);
      if (!local.ok) return toErrorState(local.error, values);

      const addressId = parsed.addressId;
      let sessionId: string;
      if (addressId === undefined) {
        sessionId = await getOrCreateSessionId();
      } else {
        const owner = await readSessionId();
        if (owner === null) return notFoundState(values);
        sessionId = owner;
      }

      const limited = limitAction(limiter, "address.write", sessionId);
      if (!limited.ok) return toErrorState(limited.error, values);

      const result =
        addressId === undefined
          ? service.create(sessionId, input, now?.())
          : service.update(sessionId, addressId, input, now?.());
      if (!result.ok) return toErrorState(result.error, values);

      revalidate();
      return {
        ok: true,
        kind: "saved",
        message: addressId === undefined ? ADDRESS_MESSAGES.created : ADDRESS_MESSAGES.updated,
        addressId: result.value.id,
      };
    } catch (error) {
      logFailure("save", error);
      return unexpectedErrorState(values);
    }
  };

  const deleteAddress: AddressActionFn = async (_prev, formData) => {
    try {
      const parsed = parseAddressForm(formData);
      const addressId = parsed.addressId;
      if (parsed.addressIdMalformed || addressId === undefined) return notFoundState();
      if (parsed.confirm !== ADDRESS_DELETE_CONFIRM_VALUE) {
        return errorState(
          appError("VALIDATION_FAILED", ADDRESS_MESSAGES.confirmRequired, { reason: "confirm_required" }),
          {},
        );
      }

      const sessionId = await readSessionId();
      if (sessionId === null) return notFoundState();

      const limited = limitAction(limiter, "address.write", sessionId);
      if (!limited.ok) return toErrorState(limited.error, {});

      const result = service.remove(sessionId, addressId);
      if (!result.ok) return toErrorState(result.error, {});

      revalidate();
      return { ok: true, kind: "deleted", message: ADDRESS_MESSAGES.deleted, addressId };
    } catch (error) {
      logFailure("delete", error);
      return unexpectedErrorState();
    }
  };

  const setDefaultAddress: AddressActionFn = async (_prev, formData) => {
    try {
      const parsed = parseAddressForm(formData);
      const addressId = parsed.addressId;
      if (parsed.addressIdMalformed || addressId === undefined) return notFoundState();

      const sessionId = await readSessionId();
      if (sessionId === null) return notFoundState();

      const limited = limitAction(limiter, "address.write", sessionId);
      if (!limited.ok) return toErrorState(limited.error, {});

      const result = service.setDefault(sessionId, addressId);
      if (!result.ok) return toErrorState(result.error, {});

      revalidate();
      return { ok: true, kind: "default_set", message: ADDRESS_MESSAGES.defaultSet, addressId: result.value.id };
    } catch (error) {
      logFailure("setDefault", error);
      return unexpectedErrorState();
    }
  };

  return { saveAddress, deleteAddress, setDefaultAddress };
}
