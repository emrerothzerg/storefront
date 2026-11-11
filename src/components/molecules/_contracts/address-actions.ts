import type { AppError } from "@/lib/result";

/**
 * Contract between the address UI (AddressForm / AddressCard T65, AddressBook
 * T84, checkout v2 T93) and the address server actions (T49,
 * `src/app/actions/addresses.ts`).
 *
 * All three actions implement `AddressActionFn` and:
 * - Read ONLY the `ADDRESS_FIELD` names below. Every other field
 *   (`sessionId`, `email`, `id`, `$ACTION_*`, ...) is ignored. A non-string
 *   entry (a `File`) counts as missing.
 * - Take the owner key from the server-side cookie, never from the form.
 *   `saveAddress` without `addressId` creates the guest session if needed (the
 *   first address of a cold visitor); every other operation only reads the
 *   cookie and answers NOT_FOUND when there is none.
 * - Are rate limited (`address.write`, 20 per day per session, shared by
 *   save / delete / set default) before the address book is touched. Input
 *   that fails the local checks (field validation, missing `confirm`,
 *   malformed id) spends no token and sets no cookie.
 * - Never redirect, never put submitted values in a URL or cookie, never log
 *   address values. On success they revalidate `/account/addresses` and
 *   `/checkout`.
 * - Always settle with a plain, JSON-serializable state; `message` and the
 *   `fieldErrors` strings are user-safe and may be shown verbatim.
 *
 * Fields per action:
 * - saveAddress:       addressId (absent or "" = create, else update), label,
 *                      fullName, phone, line1, line2, city, region,
 *                      postalCode, country, isDefault (checkbox; "on"/"true"/"1")
 * - deleteAddress:     addressId, confirm (must be exactly "yes")
 * - setDefaultAddress: addressId
 *
 * Error codes a form should expect (`error.code`):
 * - VALIDATION_FAILED / TOO_LONG: see `fieldErrors`; `error.details.fields`
 *   holds per-field codes (REQUIRED, TOO_LONG, INVALID_COUNTRY, INVALID_TYPE,
 *   INVALID_CHARACTERS, INVALID_LENGTH, ...). A delete without `confirm=yes`
 *   is VALIDATION_FAILED with `details.reason === "confirm_required"` and no
 *   field errors.
 * - LIMIT_REACHED: the book already holds 10 addresses (`details.max`).
 * - DUPLICATE: "You already saved this address."
 * - NOT_FOUND: "Address not found." (unknown, foreign or malformed id, or no session).
 * - RATE_LIMITED: `retryAfterSeconds` is set.
 * - INVALID_INPUT with `details.reason === "unavailable"`: server fault;
 *   `values` are echoed so the user can retry.
 */

/** Form field names. Address keys match the MVP `AddressFields` inputs. */
export const ADDRESS_FIELD = {
  addressId: "addressId",
  label: "label",
  fullName: "fullName",
  phone: "phone",
  line1: "line1",
  line2: "line2",
  city: "city",
  region: "region",
  postalCode: "postalCode",
  country: "country",
  isDefault: "isDefault",
  confirm: "confirm",
} as const;

export type AddressFieldName = (typeof ADDRESS_FIELD)[keyof typeof ADDRESS_FIELD];

/** Value `deleteAddress` requires in the `confirm` field. */
export const ADDRESS_DELETE_CONFIRM_VALUE = "yes";

/**
 * Input caps for `maxLength` (mirror of the address service limits; values
 * longer than this are rejected server-side and echoed truncated).
 */
export const ADDRESS_MAX_LENGTH = {
  label: 40,
  fullName: 200,
  phone: 20,
  line1: 200,
  line2: 200,
  city: 200,
  region: 200,
  postalCode: 200,
  country: 200,
} as const;

/**
 * Values echoed back on failure so the form can re-fill itself without
 * JavaScript. Each value is truncated to `ADDRESS_MAX_LENGTH`; `isDefault` is
 * "on" when the checkbox was ticked and absent otherwise.
 */
export type AddressEchoValues = Readonly<
  Partial<Record<Exclude<keyof typeof ADDRESS_FIELD, "addressId" | "confirm">, string>>
>;

/** `null` = not yet submitted. */
export type AddressActionState =
  | null
  | {
      readonly ok: true;
      readonly kind: "saved" | "deleted" | "default_set";
      readonly message: string;
      readonly addressId?: string;
    }
  | {
      readonly ok: false;
      readonly error: AppError;
      /** User-safe; equal to `error.message`. */
      readonly message: string;
      readonly fieldErrors: Readonly<Partial<Record<keyof AddressEchoValues, string>>>;
      readonly values: AddressEchoValues;
      /** Present only for RATE_LIMITED. */
      readonly retryAfterSeconds?: number;
    };

/** Signature for `useActionState` / `<form action>`. */
export type AddressActionFn = (prev: AddressActionState, formData: FormData) => Promise<AddressActionState>;

export const initialAddressActionState: AddressActionState = null;
