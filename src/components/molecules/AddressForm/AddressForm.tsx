"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { Button } from "@/components/atoms/Button";
import { Checkbox } from "@/components/atoms/Checkbox";
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Text } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import type { Address, SavedAddress } from "@/lib/types";
import type { AddressField, FieldErrorCode, FieldErrors } from "@/lib/validation";
import { AddressFields } from "../AddressFields";
import {
  ADDRESS_FIELD,
  ADDRESS_MAX_LENGTH,
  initialAddressActionState,
  type AddressActionFn,
  type AddressActionState,
  type AddressEchoValues,
} from "../_contracts/address-actions";

/**
 * Client-side mirror of the address service phone rule (digits, spaces and
 * `+ - ( )` only, at least 7 digits; the 20-character cap is `maxLength`).
 * Written for the HTML `pattern` attribute, which browsers compile with the
 * `v` flag: `(`, `)` and `-` are escaped inside the class so the pattern is
 * valid there (an invalid pattern is silently ignored).
 */
export const PHONE_PATTERN = "(?:[+\\(\\)\\- ]*[0-9]){7}[0-9+\\(\\)\\- ]*";
export const PHONE_TITLE = "Digits, spaces and + - ( ) only, at least 7 digits.";
export const LABEL_HINT = "e.g. Home, Office";
export const DEFAULT_CHECKBOX_LABEL = "Make this my default address";
export const IS_DEFAULT_TEXT = "This is your default address.";

const DEFAULT_ID_PREFIX = "address-form";

/** Echo keys that have a visible control, in form (and summary) order. */
const SUMMARY_ORDER = [
  "fullName",
  "line1",
  "line2",
  "city",
  "region",
  "postalCode",
  "country",
  "label",
  "phone",
  "isDefault",
] as const satisfies ReadonlyArray<keyof AddressEchoValues>;

type EchoKey = (typeof SUMMARY_ORDER)[number];

const FIELD_LABELS: Readonly<Record<EchoKey, string>> = {
  fullName: "Full name",
  line1: "Address line 1",
  line2: "Address line 2",
  city: "City",
  region: "State / province / region",
  postalCode: "Postal code",
  country: "Country",
  label: "Label",
  phone: "Phone",
  isDefault: "Default address",
};

/** The `AddressFields` inputs this form posts (`email` is omitted: the address book stores no email). */
const ADDRESS_INPUTS = ["fullName", "line1", "line2", "city", "region", "postalCode", "country"] as const;
type AddressInput = (typeof ADDRESS_INPUTS)[number];

/** `AddressFields` inputs the address book never renders or posts (D-T98-2). */
const OMITTED_ADDRESS_FIELDS: ReadonlyArray<AddressField> = ["email"];

export type AddressFormIds = Readonly<Record<EchoKey | "form" | "summary", string>>;

/** Element ids for a given prefix; address inputs follow `AddressFields` (`${prefix}-${field}`). */
export function addressFormIds(prefix: string = DEFAULT_ID_PREFIX): AddressFormIds {
  return {
    form: prefix,
    summary: `${prefix}-summary`,
    fullName: `${prefix}-fullName`,
    line1: `${prefix}-line1`,
    line2: `${prefix}-line2`,
    city: `${prefix}-city`,
    region: `${prefix}-region`,
    postalCode: `${prefix}-postalCode`,
    country: `${prefix}-country`,
    label: `${prefix}-label`,
    phone: `${prefix}-phone`,
    isDefault: `${prefix}-isDefault`,
  };
}

/** Ids with the default prefix ("address-form"). Pass `idPrefix` when a page renders more than one form. */
export const ADDRESS_FORM_IDS: AddressFormIds = addressFormIds(DEFAULT_ID_PREFIX);

export interface AddressFormProps {
  /** `saveAddress` server action (or anything matching `AddressActionFn`). Pass it unwrapped so the form posts without JS. */
  action: AddressActionFn;
  /** Edit mode when given: posts a hidden `addressId` and pre-fills the fields. */
  address?: SavedAddress | null;
  /** Show "Make this my default address". Defaults to true. Replaced by a note when editing the current default. */
  showDefaultCheckbox?: boolean;
  /** Show the optional "Label" input. Defaults to true. */
  showLabel?: boolean;
  /** Submit text. Defaults to "Save address" (create) / "Update address" (edit). */
  submitLabel?: string;
  /**
   * Screen-reader-only context appended to the submit's accessible name as
   * `": <context>"` (visible text unchanged), so several edit forms on one
   * page have distinct names, e.g. "Update address: Home". Blank = none.
   */
  submitContext?: string;
  /** Called on the client after each successful save with the action state. */
  onSaved?: (state: Extract<NonNullable<AddressActionState>, { ok: true }>) => void;
  /** Prefix for element ids. Defaults to "address-form"; must be unique per page. */
  idPrefix?: string;
  /** Tighter spacing and a regular-size submit, for use inside checkout. */
  compact?: boolean;
  /** Accessible name of the form. Defaults to "Add an address" / "Edit address". */
  formLabel?: string;
  className?: string;
}

/** "Try again in N minutes" (rounded up, at least 1), or a generic hint when unknown. */
export function retryAfterText(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return "Try again later.";
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

type Failure = Extract<NonNullable<AddressActionState>, { ok: false }>;

export interface AddressSummaryItem {
  readonly field: EchoKey;
  /** Target element id, or null when the field has no visible control. */
  readonly id: string | null;
  readonly label: string;
  readonly message: string;
}

/** Field errors in form order; skips blank or non-string messages. */
export function addressSummaryItems(
  failure: Failure,
  ids: AddressFormIds,
  visible: { readonly label: boolean; readonly isDefault: boolean },
): AddressSummaryItem[] {
  const fieldErrors = failure.fieldErrors ?? {};
  return SUMMARY_ORDER.flatMap((field) => {
    const message = fieldErrors[field];
    if (typeof message !== "string" || message.trim() === "") return [];
    const hasControl = field === "label" ? visible.label : field === "isDefault" ? visible.isDefault : true;
    return [{ field, id: hasControl ? ids[field] : null, label: FIELD_LABELS[field], message }];
  });
}

const FIELD_ERROR_CODES: ReadonlySet<string> = new Set<FieldErrorCode>([
  "REQUIRED",
  "INVALID_TYPE",
  "TOO_LONG",
  "INVALID_EMAIL",
  "INVALID_COUNTRY",
  "INVALID_CHARACTERS",
  "INVALID_LENGTH",
  "FAILED_CHECKSUM",
  "INVALID_MONTH",
  "INVALID_YEAR",
  "EXPIRED",
  "INVALID_CVC",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldErrorCode(value: unknown): value is FieldErrorCode {
  return typeof value === "string" && FIELD_ERROR_CODES.has(value);
}

/** Converts the action's string field errors into the `AddressFields` `errors` shape (codes from `error.details.fields`). */
export function toAddressFieldErrors(failure: Failure | null): FieldErrors<AddressField> {
  if (!failure) return {};
  const details = failure.error.details?.fields;
  const codes: Readonly<Record<string, unknown>> = isRecord(details) ? details : {};
  const out: Partial<Record<AddressField, { code: FieldErrorCode; message: string }>> = {};
  for (const field of ADDRESS_INPUTS) {
    const message = failure.fieldErrors?.[field];
    if (typeof message !== "string" || message.trim() === "") continue;
    const code = codes[field];
    out[field] = { code: isFieldErrorCode(code) ? code : "INVALID_TYPE", message };
  }
  return out;
}

function addressDefaults(source: Readonly<Partial<Record<AddressInput, string | undefined>>>): Partial<Address> {
  const out: { -readonly [K in AddressInput]?: string } = {};
  for (const field of ADDRESS_INPUTS) {
    const value = source[field];
    if (typeof value === "string") out[field] = value;
  }
  return out;
}

function focusField(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return; // native fragment navigation
  event.preventDefault();
  target.focus();
  target.scrollIntoView?.({ block: "center" });
}

const summaryLink = "inline-flex min-h-touch items-center break-words";

/**
 * Create / edit form for the address book. Composes `AddressFields` (name and
 * postal inputs; `email` is omitted because the address book stores no
 * email) with an optional label, phone and default checkbox. Posts without
 * JavaScript via `useActionState`; with JS it adds pending state, a focused
 * error summary and a double-submit guard.
 */
export function AddressForm({
  action,
  address = null,
  showDefaultCheckbox = true,
  showLabel = true,
  submitLabel,
  submitContext,
  onSaved,
  idPrefix = DEFAULT_ID_PREFIX,
  compact = false,
  formLabel,
  className,
}: AddressFormProps) {
  const [state, formAction, pending] = useActionState(action, initialAddressActionState);
  const isEdit = address !== null;
  const ids = addressFormIds(idPrefix);

  // Remount the fields after every settled attempt so defaults come back from
  // the echoed values (failure) or empty (create success). An edit success
  // keeps the mounted fields (they already show what was saved).
  const [seenState, setSeenState] = useState<AddressActionState>(state);
  const [attempt, setAttempt] = useState(0);
  if (seenState !== state) {
    setSeenState(state);
    if (!(state?.ok === true && isEdit)) setAttempt((n) => n + 1);
  }

  const summaryRef = useRef<HTMLDivElement>(null);
  // Double-submit guard. Remembers the state the in-flight submit started
  // from: once a new state has rendered, `state` differs and the guard opens
  // during that same render, without waiting for a passive effect (an
  // effect-only reset raced with fast resubmits under load). The effect below
  // still clears it as a fallback (e.g. an action returning the previous state).
  const inFlight = useRef<{ readonly from: AddressActionState } | null>(null);
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  });

  useEffect(() => {
    if (!pending) inFlight.current = null;
  }, [pending, state]);

  useEffect(() => {
    if (state === null) return;
    if (!state.ok) summaryRef.current?.focus();
    else if (state.kind === "saved") onSavedRef.current?.(state);
  }, [state]);

  const failure = state !== null && !state.ok ? state : null;
  const values: AddressEchoValues = failure?.values ?? {};
  const fieldErrors = failure?.fieldErrors ?? {};
  const fieldError = (field: EchoKey): string | undefined => {
    const message = fieldErrors[field];
    return typeof message === "string" && message.trim() !== "" ? message : undefined;
  };

  const editingDefault = isEdit && address.isDefault;
  const renderCheckbox = showDefaultCheckbox && !editingDefault;

  const addressValues: Partial<Address> = failure
    ? addressDefaults(values)
    : isEdit
      ? addressDefaults(address)
      : {};
  const labelValue = failure ? (values.label ?? "") : (address?.label ?? "");
  const phoneValue = failure ? (values.phone ?? "") : (address?.phone ?? "");
  const defaultChecked = failure ? values.isDefault === "on" : false;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (pending || (inFlight.current !== null && inFlight.current.from === state)) {
      event.preventDefault();
      return;
    }
    inFlight.current = { from: state };
  };

  let summary = null;
  if (failure) {
    const code = failure.error.code;
    const items = addressSummaryItems(failure, ids, { label: showLabel, isDefault: renderCheckbox });
    let tone: "danger" | "warning" = "danger";
    let title: string;
    let body;
    if (code === "RATE_LIMITED") {
      tone = "warning";
      title = "Too many address changes";
      body = <p>{retryAfterText(failure.retryAfterSeconds)}</p>;
    } else if (code === "LIMIT_REACHED") {
      tone = "warning";
      title = "Address book full";
      body = <p>{failure.message}</p>;
    } else if (code === "DUPLICATE") {
      tone = "warning";
      title = "Address not saved";
      body = <p>{failure.message}</p>;
    } else if (items.length > 0) {
      title = "Please fix the following";
      body = (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.field} className="break-words">
              {item.id !== null ? (
                <Link
                  href={`#${item.id}`}
                  className={summaryLink}
                  onClick={(e) => focusField(e, item.id ?? "")}
                >
                  {`${item.label}: ${item.message}`}
                </Link>
              ) : (
                `${item.label}: ${item.message}`
              )}
            </li>
          ))}
        </ul>
      );
    } else {
      title = "Address not saved";
      body = <p>{failure.message}</p>;
    }
    summary = (
      <Notice
        ref={summaryRef}
        id={ids.summary}
        tone={tone}
        tabIndex={-1}
        title={title}
        data-testid="address-error-summary"
        className="break-words"
      >
        {body}
      </Notice>
    );
  }

  const gap = compact ? "gap-3" : "gap-4";
  const resolvedSubmit = submitLabel ?? (isEdit ? "Update address" : "Save address");
  const context = typeof submitContext === "string" ? submitContext.trim() : "";

  return (
    <form
      id={ids.form}
      action={formAction}
      onSubmit={onSubmit}
      noValidate
      aria-label={formLabel ?? (isEdit ? "Edit address" : "Add an address")}
      className={["flex min-w-0 flex-col", gap, className].filter(Boolean).join(" ")}
    >
      {summary}
      <div aria-live="polite" aria-atomic="true">
        {state?.ok === true ? <Notice tone="success">{state.message}</Notice> : null}
      </div>
      {isEdit ? <input type="hidden" name={ADDRESS_FIELD.addressId} value={address.id} /> : null}
      <div key={`fields-${attempt}`} className={["flex min-w-0 flex-col", gap].join(" ")}>
        {/* The address book stores no email: AddressFields does not render (or post) one. */}
        <AddressFields
          idPrefix={idPrefix}
          errors={toAddressFieldErrors(failure)}
          defaultValues={addressValues}
          omit={OMITTED_ADDRESS_FIELDS}
          className="min-w-0"
        />
        <div className={["grid grid-cols-1 sm:grid-cols-2", gap].join(" ")}>
          {showLabel ? (
            <FormField id={ids.label} label={FIELD_LABELS.label} hint={LABEL_HINT} error={fieldError("label")}>
              {(p) => (
                <Input
                  {...p}
                  name={ADDRESS_FIELD.label}
                  maxLength={ADDRESS_MAX_LENGTH.label}
                  autoComplete="off"
                  defaultValue={labelValue}
                />
              )}
            </FormField>
          ) : null}
          <FormField id={ids.phone} label={FIELD_LABELS.phone} hint="Optional" error={fieldError("phone")}>
            {(p) => (
              <Input
                {...p}
                name={ADDRESS_FIELD.phone}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={ADDRESS_MAX_LENGTH.phone}
                pattern={PHONE_PATTERN}
                title={PHONE_TITLE}
                defaultValue={phoneValue}
              />
            )}
          </FormField>
        </div>
        {renderCheckbox ? (
          <div className="flex flex-col gap-1">
            <Checkbox
              id={ids.isDefault}
              name={ADDRESS_FIELD.isDefault}
              value="on"
              label={DEFAULT_CHECKBOX_LABEL}
              defaultChecked={defaultChecked}
              invalid={fieldError("isDefault") !== undefined}
              aria-describedby={fieldError("isDefault") ? `${ids.isDefault}-error` : undefined}
            />
            {fieldError("isDefault") ? (
              <p id={`${ids.isDefault}-error`} role="alert" className="text-small text-danger">
                {fieldError("isDefault")}
              </p>
            ) : null}
          </div>
        ) : editingDefault && showDefaultCheckbox ? (
          <Text variant="small" tone="secondary">
            {IS_DEFAULT_TEXT}
          </Text>
        ) : null}
      </div>
      <div>
        <Button type="submit" size={compact ? "md" : "lg"} loading={pending} className="w-full xs:w-auto">
          {pending ? "Saving…" : resolvedSubmit}
          {context !== "" ? <VisuallyHidden>{`: ${context}`}</VisuallyHidden> : null}
        </Button>
      </div>
    </form>
  );
}
