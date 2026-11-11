import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import type { CardField, FieldErrors } from "@/lib/validation";

/**
 * Mock provider test cards, duplicated here so this client-rendered component
 * never imports server code. A test asserts equality with `MOCK_CARDS` in
 * `@/server/payments/mock-payment-provider` so the two cannot drift.
 */
export const MOCK_TEST_CARDS = {
  success: "4242424242424242",
  declined: "4000000000000002",
  insufficientFunds: "4000000000009995",
  processingError: "4000000000000119",
} as const;

const TEST_CARD_ROWS: ReadonlyArray<{ number: string; outcome: string }> = [
  { number: MOCK_TEST_CARDS.success, outcome: "succeeds" },
  { number: MOCK_TEST_CARDS.declined, outcome: "declined" },
  { number: MOCK_TEST_CARDS.insufficientFunds, outcome: "insufficient funds" },
  { number: MOCK_TEST_CARDS.processingError, outcome: "processing error" },
];

export interface PaymentFieldsProps {
  /** Per-field errors, e.g. `result.error.details.fields` from `validateCard`. */
  errors?: FieldErrors<CardField>;
  /**
   * Only the cardholder name can be pre-filled. Card number, expiry and CVC
   * are deliberately NOT accepted and are never rendered back (no `value` or
   * `defaultValue`), even if a caller passes extra keys: after a failed
   * submit the shopper re-types them. Do not add them here.
   */
  defaultValues?: { nameOnCard?: string };
  /** Prefix for element ids (`${idPrefix}-${field}`). Defaults to "card". */
  idPrefix?: string;
  /**
   * Render the "Payment" legend visually hidden (`sr-only`, still in the DOM
   * and still the fieldset's accessible name). Use when a visible "Payment"
   * heading sits right above (checkout card). Default false.
   */
  hideLegend?: boolean;
  className?: string;
}

/**
 * Card fields for the mock payment provider. Presentational and stateless:
 * inputs are uncontrolled, never persisted, and their `name`s match the
 * `CardInput` keys. Numeric fields use `type="text"` + `inputMode="numeric"`
 * (not `type="number"`) so leading zeros, spaces and autofill behave.
 */
export function PaymentFields({
  errors,
  defaultValues,
  idPrefix = "card",
  hideLegend = false,
  className,
}: PaymentFieldsProps) {
  const id = (field: CardField) => `${idPrefix}-${field}`;
  const error = (field: CardField) => errors?.[field]?.message;
  const noticeId = `${idPrefix}-test-mode`;

  return (
    <fieldset className={["flex flex-col gap-4", className].filter(Boolean).join(" ")}>
      <legend className={hideLegend ? "sr-only" : "text-h4 text-text-primary mb-4"}>Payment</legend>
      <div id={noticeId} role="note" className="bg-info-subtle text-info rounded-lg p-4 text-small">
        <p>
          <strong>Test mode:</strong> this is a mock payment. No real card is charged. Use one of these
          test cards with any future expiry and any CVC:
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          {TEST_CARD_ROWS.map((row) => (
            <li key={row.number}>
              <span className="font-mono">{row.number}</span> {row.outcome}
            </li>
          ))}
        </ul>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <FormField id={id("nameOnCard")} label="Name on card" required error={error("nameOnCard")} className="col-span-2">
          {(p) => (
            <Input {...p} name="nameOnCard" autoComplete="cc-name" defaultValue={defaultValues?.nameOnCard} />
          )}
        </FormField>
        <FormField id={id("number")} label="Card number" required error={error("number")} className="col-span-2">
          {(p) => (
            <Input {...p} name="number" type="text" inputMode="numeric" autoComplete="cc-number" spellCheck={false} />
          )}
        </FormField>
        <FormField id={id("expMonth")} label="Expiry month" required error={error("expMonth")}>
          {(p) => (
            <Input
              {...p}
              name="expMonth"
              type="text"
              inputMode="numeric"
              autoComplete="cc-exp-month"
              placeholder="MM"
              maxLength={2}
            />
          )}
        </FormField>
        <FormField id={id("expYear")} label="Expiry year" required error={error("expYear")}>
          {(p) => (
            <Input
              {...p}
              name="expYear"
              type="text"
              inputMode="numeric"
              autoComplete="cc-exp-year"
              placeholder="YYYY"
              maxLength={4}
            />
          )}
        </FormField>
        <FormField id={id("cvc")} label="Security code (CVC)" required error={error("cvc")} className="col-span-2 xs:col-span-1">
          {(p) => (
            <Input {...p} name="cvc" type="text" inputMode="numeric" autoComplete="cc-csc" maxLength={4} />
          )}
        </FormField>
      </div>
    </fieldset>
  );
}
