import type { Database } from "bun:sqlite";
import type { Address, SavedAddress } from "@/lib/types";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import { validateAddress, type FieldError, type FieldErrors } from "@/lib/validation";
import { getDatabase, withTransaction } from "@/server/db/client";
import { cleanText, RAW_LENGTH_FACTOR } from "@/server/security/text-guard";
import { isSessionId } from "@/server/session/session-id";
import { SqliteAddressRepository, type AddressRecord, type AddressRepository } from "./address-repository";

/**
 * Address book rules (server-only, synchronous). See README.md in this folder.
 *
 * - `sessionId` is the OWNER KEY (guest session or user owner_key, UUID v4).
 * - Exactly one default per owner whenever the owner has any address.
 * - Address values are PII: they are never logged. DB failures log only an
 *   error code and are rethrown as `AddressStorageError` (no PII, no cause).
 */

export const MAX_ADDRESSES_PER_SESSION = 10;
export const LABEL_MAX = 40;
export const PHONE_MAX = 20;
/** Minimum digits in a non-empty phone number. */
export const PHONE_MIN_DIGITS = 7;
/** Mirrors the (unexported) per-field cap of `validateAddress`. */
export const ADDRESS_FIELD_MAX = 200;

export interface AddressInput extends Record<keyof Address, unknown> {
  readonly label?: unknown;
  readonly phone?: unknown;
  readonly isDefault?: unknown;
}

/** Field keys that can appear in `details.fields` of a `VALIDATION_FAILED` error. */
export type AddressBookField = Exclude<keyof Address, "email"> | "label" | "phone";

export interface AddressService {
  /** Default first, then newest. Invalid owner key → `[]`. */
  list(sessionId: string): readonly SavedAddress[];
  /** `NOT_FOUND` for unknown, foreign or malformed ids (no distinction); `INVALID_INPUT` for a bad owner key. */
  get(sessionId: string, addressId: string): Result<SavedAddress, AppError>;
  getDefault(sessionId: string): SavedAddress | null;
  create(sessionId: string, input: AddressInput, now?: number): Result<SavedAddress, AppError>;
  update(sessionId: string, addressId: string, input: AddressInput, now?: number): Result<SavedAddress, AppError>;
  remove(sessionId: string, addressId: string): Result<void, AppError>;
  setDefault(sessionId: string, addressId: string): Result<SavedAddress, AppError>;
  countFor(sessionId: string): number;
}

export interface AddressServiceDeps {
  readonly db: Database;
  readonly logger?: Pick<Console, "error" | "warn">;
  /** Clock in epoch ms (defaults to `Date.now`); a per-call `now` argument wins. */
  readonly now?: () => number;
}

/**
 * Thrown when the database fails. Carries only the operation name and the
 * driver error code (e.g. `SQLITE_BUSY`); never the input or the original
 * error message.
 */
export class AddressStorageError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string,
  ) {
    super(`Address book storage failed (${operation}: ${code})`);
    this.name = "AddressStorageError";
  }
}

/** Thrown inside a transaction to roll it back; converted to `Err` outside. */
class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}

/** Longest id we will look up; anything else is NOT_FOUND without a query. */
const ADDRESS_ID_MAX = 64;
/** Placeholder satisfying `validateAddress`'s email rule: the address book stores no email. */
const PLACEHOLDER_EMAIL = "address-book@example.invalid";
/**
 * Characters a phone number may contain (digits, spaces and + - ( )).
 * Exported so the order service applies the identical rule (consistency af).
 */
export const PHONE_ALLOWED = /^[0-9+\-() ]*$/;

const TEXT_FIELDS = ["fullName", "line1", "line2", "city", "region", "postalCode", "country"] as const;
type TextField = (typeof TEXT_FIELDS)[number];

const FIELD_LABELS: Readonly<Record<AddressBookField, string>> = {
  fullName: "Full name",
  line1: "Address line 1",
  line2: "Address line 2",
  city: "City",
  region: "Region",
  postalCode: "Postal code",
  country: "Country",
  label: "Label",
  phone: "Phone",
};

const FIELD_MAX: Readonly<Record<AddressBookField, number>> = {
  fullName: ADDRESS_FIELD_MAX,
  line1: ADDRESS_FIELD_MAX,
  line2: ADDRESS_FIELD_MAX,
  city: ADDRESS_FIELD_MAX,
  region: ADDRESS_FIELD_MAX,
  postalCode: ADDRESS_FIELD_MAX,
  country: ADDRESS_FIELD_MAX,
  label: LABEL_MAX,
  phone: PHONE_MAX,
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddressId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= ADDRESS_ID_MAX;
}

/** Accepts booleans and the usual form encodings ("on", "true", "1"). */
function readFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "on" || value === "true" || value === "1";
}

type Cleaned = { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly error: FieldError };

/** `undefined`/`null` pass through (validateAddress decides REQUIRED); strings go through `cleanText`. */
function cleanField(raw: unknown, field: AddressBookField): Cleaned {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const result = cleanText(raw, { max: FIELD_MAX[field] });
  if (result.ok) return { ok: true, value: result.value };
  const label = FIELD_LABELS[field];
  if (result.error.code === "TOO_LONG") {
    return { ok: false, error: { code: "TOO_LONG", message: `${label} must be at most ${FIELD_MAX[field]} characters.` } };
  }
  return { ok: false, error: { code: "INVALID_TYPE", message: `${label} must be text.` } };
}

/**
 * The address book's phone rule for an already cleaned, non-empty value:
 * only `PHONE_ALLOWED` characters, at least `PHONE_MIN_DIGITS` digits.
 * `null` when valid. Shared with the order service (`parseOrderPhone`).
 */
export function validatePhone(value: string): FieldError | null {
  if (!PHONE_ALLOWED.test(value)) {
    return { code: "INVALID_CHARACTERS", message: "Phone may contain only digits, spaces and + - ( )." };
  }
  let digits = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0x30 && c <= 0x39) digits++;
  }
  if (digits < PHONE_MIN_DIGITS) {
    return { code: "INVALID_LENGTH", message: `Phone must contain at least ${PHONE_MIN_DIGITS} digits.` };
  }
  return null;
}

/**
 * Turns untrusted input into a storable record or an error:
 * `INVALID_INPUT` (not an object), `TOO_LONG` (a raw field longer than
 * 4x its cap, rejected before scanning), or `VALIDATION_FAILED` with
 * per-field errors from `validateAddress` plus label/phone.
 */
export function parseAddressInput(input: unknown): Result<AddressRecord, AppError> {
  if (!isRecord(input)) return fail("INVALID_INPUT", "Address details are required.");

  const fields = [...TEXT_FIELDS, "label", "phone"] as const;
  for (const field of fields) {
    const raw = input[field];
    if (typeof raw === "string" && raw.length > FIELD_MAX[field] * RAW_LENGTH_FACTOR) {
      return fail("TOO_LONG", `${FIELD_LABELS[field]} must be at most ${FIELD_MAX[field]} characters.`, {
        field,
        max: FIELD_MAX[field],
      });
    }
  }

  const errors: Partial<Record<AddressBookField, FieldError>> = {};
  const cleaned: Partial<Record<TextField, string>> = {};
  for (const field of TEXT_FIELDS) {
    const c = cleanField(input[field], field);
    if (c.ok) {
      if (c.value !== undefined) cleaned[field] = c.value;
    } else {
      errors[field] = c.error;
    }
  }

  let label = "";
  const labelCleaned = cleanField(input.label, "label");
  if (labelCleaned.ok) label = labelCleaned.value ?? "";
  else errors.label = labelCleaned.error;

  let phone: string | null = null;
  const phoneCleaned = cleanField(input.phone, "phone");
  if (!phoneCleaned.ok) {
    errors.phone = phoneCleaned.error;
  } else if (phoneCleaned.value !== undefined && phoneCleaned.value !== "") {
    const phoneError = validatePhone(phoneCleaned.value);
    if (phoneError === null) phone = phoneCleaned.value;
    else errors.phone = phoneError;
  }

  // Fields that failed cleaning are omitted, so validateAddress reports
  // nothing worse than REQUIRED for them; the cleaning error wins below.
  const validated = validateAddress({ ...cleaned, email: PLACEHOLDER_EMAIL });
  if (!validated.ok) {
    for (const [key, error] of Object.entries(validated.error.details.fields)) {
      if (key === "email" || error === undefined) continue;
      const field = key as TextField;
      if (errors[field] === undefined) errors[field] = error;
    }
  }

  if (!validated.ok || Object.keys(errors).length > 0) {
    const out: FieldErrors<AddressBookField> = errors;
    return fail("VALIDATION_FAILED", "Some fields are invalid.", { fields: out });
  }

  const a = validated.value;
  return ok({
    label,
    fullName: a.fullName,
    phone,
    line1: a.line1,
    line2: a.line2 ?? null,
    city: a.city,
    region: a.region,
    postalCode: a.postalCode,
    country: a.country,
  });
}

/** Lower-case, NFKC, letters and digits only (single spaces between words). */
function normaliseWords(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalisePostal(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Duplicate key: normalised full name + line 1 + postal code + country. */
export function duplicateKey(a: Pick<AddressRecord, "fullName" | "line1" | "postalCode" | "country">): string {
  return [normaliseWords(a.fullName), normaliseWords(a.line1), normalisePostal(a.postalCode), a.country.toUpperCase()].join(
    "\u0000",
  );
}

function sameRecord(saved: SavedAddress, record: AddressRecord): boolean {
  return (
    saved.label === record.label &&
    saved.fullName === record.fullName &&
    (saved.phone ?? null) === record.phone &&
    saved.line1 === record.line1 &&
    (saved.line2 ?? null) === record.line2 &&
    saved.city === record.city &&
    saved.region === record.region &&
    saved.postalCode === record.postalCode &&
    saved.country === record.country
  );
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z]{1,64}$/.test(name)) return name;
  }
  return "UNKNOWN";
}

const notFound = (): Result<never, AppError> => fail("NOT_FOUND", "Address not found.");
const invalidSession = (): Result<never, AppError> => fail("INVALID_INPUT", "Invalid session.");

class SqliteAddressService implements AddressService {
  private readonly db: Database;
  private readonly repo: AddressRepository;
  private readonly logger: Pick<Console, "error" | "warn">;
  private readonly clock: () => number;

  constructor(deps: AddressServiceDeps) {
    this.db = deps.db;
    this.repo = new SqliteAddressRepository(deps.db);
    this.logger = deps.logger ?? console;
    this.clock = deps.now ?? Date.now;
  }

  list(sessionId: string): readonly SavedAddress[] {
    if (!isSessionId(sessionId)) return [];
    return this.guard("list", () => this.repo.listBySession(sessionId));
  }

  get(sessionId: string, addressId: string): Result<SavedAddress, AppError> {
    if (!isSessionId(sessionId)) return invalidSession();
    if (!isAddressId(addressId)) return notFound();
    const found = this.guard("get", () => this.repo.findById(sessionId, addressId));
    return found === null ? notFound() : ok(found);
  }

  getDefault(sessionId: string): SavedAddress | null {
    if (!isSessionId(sessionId)) return null;
    return this.guard("getDefault", () => this.repo.findDefault(sessionId));
  }

  countFor(sessionId: string): number {
    if (!isSessionId(sessionId)) return 0;
    return this.guard("countFor", () => this.repo.countBySession(sessionId));
  }

  create(sessionId: string, input: AddressInput, now?: number): Result<SavedAddress, AppError> {
    if (!isSessionId(sessionId)) return invalidSession();
    const parsed = parseAddressInput(input);
    if (!parsed.ok) return parsed;
    const record = parsed.value;
    const wantsDefault = isRecord(input) && readFlag(input.isDefault);
    const nowIso = this.iso(now);

    return this.mutate("create", () => {
      const existing = this.repo.listBySession(sessionId);
      const key = duplicateKey(record);
      if (existing.some((a) => duplicateKey(a) === key)) {
        throw new Abort({ code: "DUPLICATE", message: "This address is already in your address book." });
      }
      if (existing.length >= MAX_ADDRESSES_PER_SESSION) {
        throw new Abort({
          code: "LIMIT_REACHED",
          message: `You can save up to ${MAX_ADDRESSES_PER_SESSION} addresses.`,
          details: { max: MAX_ADDRESSES_PER_SESSION },
        });
      }
      const makeDefault = existing.length === 0 || wantsDefault;
      if (makeDefault) this.repo.clearDefault(sessionId, nowIso);
      const id = crypto.randomUUID();
      this.repo.insert(sessionId, id, record, makeDefault, nowIso);
      return this.mustFind(sessionId, id);
    });
  }

  update(sessionId: string, addressId: string, input: AddressInput, now?: number): Result<SavedAddress, AppError> {
    if (!isSessionId(sessionId)) return invalidSession();
    if (!isAddressId(addressId)) return notFound();
    const parsed = parseAddressInput(input);
    if (!parsed.ok) return parsed;
    const record = parsed.value;
    const wantsDefault = isRecord(input) && readFlag(input.isDefault);
    const nowIso = this.iso(now);

    return this.mutate("update", () => {
      const current = this.repo.findById(sessionId, addressId);
      if (current === null) throw new Abort({ code: "NOT_FOUND", message: "Address not found." });
      const becomeDefault = wantsDefault && !current.isDefault;
      if (sameRecord(current, record) && !becomeDefault) return current;

      const key = duplicateKey(record);
      const others = this.repo.listBySession(sessionId).filter((a) => a.id !== addressId);
      if (others.some((a) => duplicateKey(a) === key)) {
        throw new Abort({ code: "DUPLICATE", message: "This address is already in your address book." });
      }
      if (!sameRecord(current, record)) this.repo.update(sessionId, addressId, record, nowIso);
      if (becomeDefault) {
        this.repo.clearDefault(sessionId, nowIso);
        this.repo.markDefault(sessionId, addressId, nowIso);
      }
      return this.mustFind(sessionId, addressId);
    });
  }

  remove(sessionId: string, addressId: string): Result<void, AppError> {
    if (!isSessionId(sessionId)) return invalidSession();
    if (!isAddressId(addressId)) return notFound();
    const nowIso = this.iso();
    return this.mutate("remove", () => {
      const current = this.repo.findById(sessionId, addressId);
      if (current === null) throw new Abort({ code: "NOT_FOUND", message: "Address not found." });
      this.repo.delete(sessionId, addressId);
      if (current.isDefault) {
        const next = this.repo.findMostRecent(sessionId);
        if (next !== null) this.repo.markDefault(sessionId, next.id, nowIso);
      }
      return undefined;
    });
  }

  setDefault(sessionId: string, addressId: string): Result<SavedAddress, AppError> {
    if (!isSessionId(sessionId)) return invalidSession();
    if (!isAddressId(addressId)) return notFound();
    const nowIso = this.iso();
    return this.mutate("setDefault", () => {
      const current = this.repo.findById(sessionId, addressId);
      if (current === null) throw new Abort({ code: "NOT_FOUND", message: "Address not found." });
      if (current.isDefault) return current;
      this.repo.clearDefault(sessionId, nowIso);
      this.repo.markDefault(sessionId, addressId, nowIso);
      return this.mustFind(sessionId, addressId);
    });
  }

  private iso(now?: number): string {
    const requested = new Date(now ?? this.clock());
    // An out-of-range or non-finite `now` falls back to the clock instead of throwing.
    return (Number.isNaN(requested.getTime()) ? new Date(this.clock()) : requested).toISOString();
  }

  private mustFind(sessionId: string, addressId: string): SavedAddress {
    const found = this.repo.findById(sessionId, addressId);
    if (found === null) throw new AddressStorageError("read-back", "MISSING_ROW");
    return found;
  }

  /** Runs `fn` in one transaction; `Abort` → `Err`, DB errors → logged code + `AddressStorageError`. */
  private mutate<T>(operation: string, fn: () => T): Result<T, AppError> {
    try {
      return ok(withTransaction(this.db, () => fn()));
    } catch (error) {
      if (error instanceof Abort) return { ok: false, error: error.error };
      throw this.storageError(operation, error);
    }
  }

  private guard<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw this.storageError(operation, error);
    }
  }

  private storageError(operation: string, error: unknown): AddressStorageError {
    if (error instanceof AddressStorageError) {
      this.logger.error(`[addresses] ${operation} failed: ${error.code}`);
      return error;
    }
    const code = errorCode(error);
    this.logger.error(`[addresses] ${operation} failed: ${code}`);
    return new AddressStorageError(operation, code);
  }
}

export function createAddressService(deps: AddressServiceDeps): AddressService {
  return new SqliteAddressService(deps);
}

const globalForAddresses = globalThis as typeof globalThis & {
  __storefrontAddressService?: { readonly db: Database; readonly service: AddressService };
};

/** App-wide service over `getDatabase()`, cached on `globalThis` (rebuilt if the DB handle changes). */
export function getAddressService(): AddressService {
  const db = getDatabase();
  const cached = globalForAddresses.__storefrontAddressService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createAddressService({ db });
  globalForAddresses.__storefrontAddressService = { db, service };
  return service;
}
