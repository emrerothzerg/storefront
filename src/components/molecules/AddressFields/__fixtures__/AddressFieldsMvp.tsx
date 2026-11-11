/**
 * TEST FIXTURE ONLY: a frozen copy of the MVP `AddressFields` (before the
 * additive `omit` / `legend` / `maxLengths` props). `AddressFields.v2.test.tsx`
 * renders both with `renderToStaticMarkup` and asserts byte-identical output
 * when no new prop is passed. Never import this from application code.
 */
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Select, type SelectOption } from "@/components/atoms/Select";
import type { Address } from "@/lib/types";
import type { AddressField, FieldErrors } from "@/lib/validation";

/** Short default list of ISO 3166-1 alpha-2 country codes. */
const DEFAULT_COUNTRIES: ReadonlyArray<SelectOption> = [
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
  { value: "GB", label: "United Kingdom" },
  { value: "DE", label: "Germany" },
  { value: "FR", label: "France" },
  { value: "TR", label: "Türkiye" },
  { value: "AU", label: "Australia" },
];

interface AddressFieldsProps {
  /** Per-field errors, e.g. `result.error.details.fields` from `validateAddress`. */
  errors?: FieldErrors<AddressField>;
  /** Uncontrolled initial values (`defaultValue`), e.g. to re-fill after a failed submit. */
  defaultValues?: Partial<Address>;
  /** Prefix for element ids (`${idPrefix}-${field}`). Defaults to "address". */
  idPrefix?: string;
  countries?: ReadonlyArray<{ value: string; label: string }>;
  className?: string;
}

/**
 * Shipping address fields. Presentational and stateless: inputs are
 * uncontrolled and their `name`s match the `Address` keys so a parent
 * `<form>` can read them with `FormData`.
 */
export function AddressFieldsMvp({
  errors,
  defaultValues,
  idPrefix = "address",
  countries = DEFAULT_COUNTRIES,
  className,
}: AddressFieldsProps) {
  const id = (field: AddressField) => `${idPrefix}-${field}`;
  const error = (field: AddressField) => errors?.[field]?.message;

  return (
    <fieldset className={["flex flex-col gap-4", className].filter(Boolean).join(" ")}>
      <legend className="text-h4 text-text-primary mb-4">Shipping address</legend>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField id={id("fullName")} label="Full name" required error={error("fullName")} className="sm:col-span-2">
            {(p) => (
              <Input {...p} name="fullName" autoComplete="name" defaultValue={defaultValues?.fullName} />
            )}
          </FormField>
          <FormField id={id("email")} label="Email" required error={error("email")} className="sm:col-span-2">
            {(p) => (
              <Input
                {...p}
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                defaultValue={defaultValues?.email}
              />
            )}
          </FormField>
          <FormField id={id("line1")} label="Address line 1" required error={error("line1")} className="sm:col-span-2">
            {(p) => (
              <Input {...p} name="line1" autoComplete="address-line1" defaultValue={defaultValues?.line1} />
            )}
          </FormField>
          <FormField id={id("line2")} label="Address line 2" error={error("line2")} className="sm:col-span-2">
            {(p) => (
              <Input {...p} name="line2" autoComplete="address-line2" defaultValue={defaultValues?.line2} />
            )}
          </FormField>
          <FormField id={id("city")} label="City" required error={error("city")}>
            {(p) => (
              <Input {...p} name="city" autoComplete="address-level2" defaultValue={defaultValues?.city} />
            )}
          </FormField>
          <FormField id={id("region")} label="State / province / region" required error={error("region")}>
            {(p) => (
              <Input {...p} name="region" autoComplete="address-level1" defaultValue={defaultValues?.region} />
            )}
          </FormField>
          <FormField id={id("postalCode")} label="Postal code" required error={error("postalCode")}>
            {(p) => (
              <Input
                {...p}
                name="postalCode"
                inputMode="text"
                autoComplete="postal-code"
                defaultValue={defaultValues?.postalCode}
              />
            )}
          </FormField>
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
      </div>
    </fieldset>
  );
}
