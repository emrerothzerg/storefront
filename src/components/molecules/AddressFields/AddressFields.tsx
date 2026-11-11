import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Select, type SelectOption } from "@/components/atoms/Select";
import type { Address } from "@/lib/types";
import type { AddressField, FieldErrors } from "@/lib/validation";

/** Short default list of ISO 3166-1 alpha-2 country codes. */
export const DEFAULT_COUNTRIES: ReadonlyArray<SelectOption> = [
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
  { value: "GB", label: "United Kingdom" },
  { value: "DE", label: "Germany" },
  { value: "FR", label: "France" },
  { value: "TR", label: "Türkiye" },
  { value: "AU", label: "Australia" },
];

export interface AddressFieldsProps {
  /** Per-field errors, e.g. `result.error.details.fields` from `validateAddress`. */
  errors?: FieldErrors<AddressField>;
  /** Uncontrolled initial values (`defaultValue`), e.g. to re-fill after a failed submit. */
  defaultValues?: Partial<Address>;
  /** Prefix for element ids (`${idPrefix}-${field}`). Defaults to "address". */
  idPrefix?: string;
  countries?: ReadonlyArray<{ value: string; label: string }>;
  /**
   * Fields not to render at all (e.g. `["email"]` for the address book or a
   * signed-in checkout that already knows the email). Default: none.
   */
  omit?: ReadonlyArray<AddressField>;
  /** Fieldset legend. Defaults to "Shipping address". */
  legend?: string;
  /**
   * Render the legend visually hidden (`sr-only`, still in the DOM and still
   * the fieldset's accessible name). Use when a visible heading right above
   * already says the same thing (e.g. the checkout "Delivery address" card). Default false.
   */
  hideLegend?: boolean;
  /**
   * `maxLength` per text input (mirror of the server caps, e.g.
   * `ADDRESS_MAX_LENGTH`). Ignored for `country` (a select). Default: none.
   */
  maxLengths?: Partial<Record<AddressField, number>>;
  className?: string;
}

/**
 * Shipping address fields. Presentational and stateless: inputs are
 * uncontrolled and their `name`s match the `Address` keys so a parent
 * `<form>` can read them with `FormData`.
 */
export function AddressFields({
  errors,
  defaultValues,
  idPrefix = "address",
  countries = DEFAULT_COUNTRIES,
  omit,
  legend = "Shipping address",
  hideLegend = false,
  maxLengths,
  className,
}: AddressFieldsProps) {
  const id = (field: AddressField) => `${idPrefix}-${field}`;
  const error = (field: AddressField) => errors?.[field]?.message;
  const shown = (field: AddressField) => omit?.includes(field) !== true;
  // undefined renders no attribute, so the default markup is unchanged.
  const max = (field: AddressField) => maxLengths?.[field];

  return (
    <fieldset className={["flex flex-col gap-4", className].filter(Boolean).join(" ")}>
      <legend className={hideLegend ? "sr-only" : "text-h4 text-text-primary mb-4"}>{legend}</legend>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {shown("fullName") ? (
          <FormField id={id("fullName")} label="Full name" required error={error("fullName")} className="sm:col-span-2">
            {(p) => (
              <Input {...p} maxLength={max("fullName")} name="fullName" autoComplete="name" defaultValue={defaultValues?.fullName} />
            )}
          </FormField>
        ) : null}
        {shown("email") ? (
          <FormField id={id("email")} label="Email" required error={error("email")} className="sm:col-span-2">
            {(p) => (
              <Input
                {...p}
                maxLength={max("email")}
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                defaultValue={defaultValues?.email}
              />
            )}
          </FormField>
        ) : null}
        {shown("line1") ? (
          <FormField id={id("line1")} label="Address line 1" required error={error("line1")} className="sm:col-span-2">
            {(p) => (
              <Input {...p} maxLength={max("line1")} name="line1" autoComplete="address-line1" defaultValue={defaultValues?.line1} />
            )}
          </FormField>
        ) : null}
        {shown("line2") ? (
          <FormField id={id("line2")} label="Address line 2" error={error("line2")} className="sm:col-span-2">
            {(p) => (
              <Input {...p} maxLength={max("line2")} name="line2" autoComplete="address-line2" defaultValue={defaultValues?.line2} />
            )}
          </FormField>
        ) : null}
        {shown("city") ? (
          <FormField id={id("city")} label="City" required error={error("city")}>
            {(p) => (
              <Input {...p} maxLength={max("city")} name="city" autoComplete="address-level2" defaultValue={defaultValues?.city} />
            )}
          </FormField>
        ) : null}
        {shown("region") ? (
          <FormField id={id("region")} label="State / province / region" required error={error("region")}>
            {(p) => (
              <Input {...p} maxLength={max("region")} name="region" autoComplete="address-level1" defaultValue={defaultValues?.region} />
            )}
          </FormField>
        ) : null}
        {shown("postalCode") ? (
          <FormField id={id("postalCode")} label="Postal code" required error={error("postalCode")}>
            {(p) => (
              <Input
                {...p}
                maxLength={max("postalCode")}
                name="postalCode"
                inputMode="text"
                autoComplete="postal-code"
                defaultValue={defaultValues?.postalCode}
              />
            )}
          </FormField>
        ) : null}
        {shown("country") ? (
          <FormField id={id("country")} label="Country" required error={error("country")}>
            {(p) => (
              <Select
                {...p}
                name="country"
                autoComplete="country"
                options={countries}
                placeholder="Select a country"
                defaultValue={defaultValues?.country?.toUpperCase()}
              />
            )}
          </FormField>
        ) : null}
      </div>
    </fieldset>
  );
}
