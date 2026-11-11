// QA (T16): AddressFields, PaymentFields, SummaryRow.
import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { AddressFields } from "@/components/molecules/AddressFields";
import { MOCK_TEST_CARDS, PaymentFields } from "@/components/molecules/PaymentFields";
import { SummaryList, SummaryRow } from "@/components/molecules/SummaryRow";
import { validateAddress, validateCard, type AddressField, type CardField, type FieldErrors } from "@/lib/validation";
// Test-only import (allowed): the component itself must not import server code.
import { MOCK_CARDS } from "@/server/payments/mock-payment-provider";

function addressErrors(): FieldErrors<AddressField> {
  const r = validateAddress({});
  if (r.ok) throw new Error("expected validation failure");
  return r.error.details.fields;
}

function cardErrors(): FieldErrors<CardField> {
  const r = validateCard(
    { number: "4242424242424241", expMonth: "13", expYear: "1999", cvc: "12", nameOnCard: "" },
    new Date("2026-11-06T00:00:00Z"),
  );
  if (r.ok) throw new Error("expected validation failure");
  return r.error.details.fields;
}

type Spec = {
  name: string;
  label: RegExp;
  role: "textbox" | "combobox";
  autocomplete: string;
  inputmode: string | null;
  type: string | null;
};

const ADDRESS_SPEC: Spec[] = [
  { name: "fullName", label: /^Full name/, role: "textbox", autocomplete: "name", inputmode: null, type: null },
  { name: "email", label: /^Email/, role: "textbox", autocomplete: "email", inputmode: "email", type: "email" },
  { name: "line1", label: /^Address line 1/, role: "textbox", autocomplete: "address-line1", inputmode: null, type: null },
  { name: "line2", label: /^Address line 2/, role: "textbox", autocomplete: "address-line2", inputmode: null, type: null },
  { name: "city", label: /^City/, role: "textbox", autocomplete: "address-level2", inputmode: null, type: null },
  { name: "region", label: /^State \/ province \/ region/, role: "textbox", autocomplete: "address-level1", inputmode: null, type: null },
  // Postal codes are alphanumeric in GB/CA, so inputmode "text" (not numeric) is appropriate.
  { name: "postalCode", label: /^Postal code/, role: "textbox", autocomplete: "postal-code", inputmode: "text", type: null },
  { name: "country", label: /^Country/, role: "combobox", autocomplete: "country", inputmode: null, type: null },
];

const CARD_SPEC: Spec[] = [
  { name: "nameOnCard", label: /^Name on card/, role: "textbox", autocomplete: "cc-name", inputmode: null, type: null },
  { name: "number", label: /^Card number/, role: "textbox", autocomplete: "cc-number", inputmode: "numeric", type: "text" },
  { name: "expMonth", label: /^Expiry month/, role: "textbox", autocomplete: "cc-exp-month", inputmode: "numeric", type: "text" },
  { name: "expYear", label: /^Expiry year/, role: "textbox", autocomplete: "cc-exp-year", inputmode: "numeric", type: "text" },
  { name: "cvc", label: /^Security code/, role: "textbox", autocomplete: "cc-csc", inputmode: "numeric", type: "text" },
];

function renderBoth(props: { withErrors?: boolean } = {}) {
  return render(
    <form aria-label="Checkout">
      <AddressFields errors={props.withErrors ? addressErrors() : undefined} />
      <PaymentFields errors={props.withErrors ? cardErrors() : undefined} />
    </form>,
  );
}

describe("T16.1 labels, autocomplete, inputmode", () => {
  for (const spec of [...ADDRESS_SPEC, ...CARD_SPEC]) {
    test(`${spec.name}: labelled, autocomplete="${spec.autocomplete}", inputmode=${String(spec.inputmode)}`, () => {
      renderBoth();
      const el = screen.getByRole(spec.role, { name: spec.label });
      expect(el).toHaveAttribute("name", spec.name);
      expect(el.getAttribute("autocomplete")).toBe(spec.autocomplete);
      expect(el.getAttribute("inputmode")).toBe(spec.inputmode);
      if (spec.type !== null) expect(el.getAttribute("type")).toBe(spec.type);
      // A real <label for> association (not aria-label / placeholder only).
      const label = document.querySelector(`label[for="${el.id}"]`);
      expect(label).not.toBeNull();
      expect(el).not.toHaveAttribute("aria-label");
    });
  }

  test("every form control in both fieldsets is covered by the spec (no unlabelled extras)", () => {
    const { container } = renderBoth();
    const controls = [...container.querySelectorAll("input:not([type=hidden]), select, textarea")];
    expect(controls.map((c) => c.getAttribute("name")).sort()).toEqual(
      [...ADDRESS_SPEC, ...CARD_SPEC].map((s) => s.name).sort(),
    );
    for (const c of controls) {
      expect(c.id).not.toBe("");
      expect(container.querySelector(`label[for="${c.id}"]`)).not.toBeNull();
    }
  });

  test("required fields expose aria-required; optional line2 does not", () => {
    renderBoth();
    expect(screen.getByRole("textbox", { name: /^Full name/ })).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("textbox", { name: /^Card number/ })).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("textbox", { name: /^Address line 2/ })).not.toHaveAttribute("aria-required");
  });

  test("fieldsets have legends (group names)", () => {
    renderBoth();
    expect(screen.getByRole("group", { name: "Shipping address" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Payment" })).toBeInTheDocument();
  });
});

describe("T16.2 field errors next to the field, linked via aria-describedby", () => {
  test("real validateAddress({}) + validateCard(bad) errors: each one adjacent and linked", () => {
    const aErr = addressErrors();
    const cErr = cardErrors();
    expect(Object.keys(aErr).sort()).toEqual(
      ["city", "country", "email", "fullName", "line1", "postalCode", "region"].sort(),
    );
    expect(Object.keys(cErr).sort()).toEqual(["cvc", "expMonth", "expYear", "nameOnCard", "number"].sort());
    renderBoth({ withErrors: true });
    const all: Array<[Spec, string | undefined]> = [
      ...ADDRESS_SPEC.map((s) => [s, aErr[s.name as AddressField]?.message] as [Spec, string | undefined]),
      ...CARD_SPEC.map((s) => [s, cErr[s.name as CardField]?.message] as [Spec, string | undefined]),
    ];
    for (const [spec, message] of all) {
      const el = screen.getByRole(spec.role, { name: spec.label });
      if (message === undefined) {
        expect(el).not.toHaveAttribute("aria-invalid");
        expect(el).not.toHaveAttribute("aria-describedby");
        continue;
      }
      expect(el).toHaveAttribute("aria-invalid", "true");
      const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      const described = ids.map((id) => document.getElementById(id));
      expect(described.every((d) => d !== null)).toBe(true);
      const errEl = described.find((d) => d!.textContent === message);
      expect(errEl).toBeDefined();
      // Adjacent: the error is the control's next element sibling (same field wrapper).
      expect(el.nextElementSibling).toBe(errEl!);
      expect(el).toHaveAccessibleDescription(message);
    }
  });

  test("card errors never echo the card number or CVC", () => {
    const r = validateCard({ number: "4242 4242 4242 4241", expMonth: "1", expYear: "2030", cvc: "9z9", nameOnCard: "A" });
    if (r.ok) throw new Error("expected failure");
    const { container } = render(<PaymentFields errors={r.error.details.fields} />);
    const errText = [...container.querySelectorAll("[id$='-error']")].map((e) => e.textContent).join(" ");
    expect(errText).toContain("Card number is not valid.");
    expect(errText.replace(/\s/g, "")).not.toContain("4242424242424241");
    expect(errText).not.toContain("9z9");
  });

  test("custom idPrefix keeps ids unique when rendered twice", () => {
    const { container } = render(
      <>
        <AddressFields idPrefix="ship" errors={addressErrors()} />
        <AddressFields idPrefix="bill" errors={addressErrors()} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("T16.3 card fields: text + numeric, no persisted values, no name collisions", () => {
  test("number/expMonth/expYear/cvc are type=text inputmode=numeric (never type=number)", () => {
    const { container } = render(<PaymentFields />);
    expect(container.querySelector('input[type="number"]')).toBeNull();
    for (const name of ["number", "expMonth", "expYear", "cvc"]) {
      const el = container.querySelector(`input[name="${name}"]`)!;
      expect(el).toHaveAttribute("type", "text");
      expect(el).toHaveAttribute("inputmode", "numeric");
    }
  });

  test("all names across AddressFields + PaymentFields are unique (and ids too)", () => {
    const { container } = renderBoth();
    const names = [...container.querySelectorAll("[name]")].map((e) => e.getAttribute("name")!);
    expect(names.length).toBe(13);
    expect(new Set(names).size).toBe(names.length);
    const ids = [...container.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("defaultValues with number/cvc/expMonth/expYear (cast) are NOT rendered; nameOnCard is", () => {
    const sneaky = {
      nameOnCard: "Ada Lovelace",
      number: "5555555555554444",
      cvc: "987",
      expMonth: "07",
      expYear: "2031",
    } as unknown as { nameOnCard?: string };
    const { container } = render(<PaymentFields defaultValues={sneaky} />);
    for (const name of ["number", "cvc", "expMonth", "expYear"]) {
      const el = container.querySelector(`input[name="${name}"]`) as HTMLInputElement;
      expect(el.value).toBe("");
      expect(el.hasAttribute("value")).toBe(false);
    }
    expect(container.innerHTML).not.toContain("5555555555554444");
    expect(container.innerHTML).not.toContain("987");
    expect(container.innerHTML).not.toContain("2031");
    expect((container.querySelector('input[name="nameOnCard"]') as HTMLInputElement).value).toBe("Ada Lovelace");
  });

  test("card inputs are uncontrolled: typing does not get echoed elsewhere in the DOM", () => {
    const { container } = render(<PaymentFields />);
    const num = container.querySelector('input[name="number"]') as HTMLInputElement;
    num.value = "4111111111111111";
    expect(container.innerHTML).not.toContain("4111111111111111");
  });
});

describe("T16.4 mock-payment notice", () => {
  test('notice is visible text "Test mode" (not colour-only) and lists all four MOCK_CARDS numbers', () => {
    render(<PaymentFields />);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(/Test mode/);
    expect(note).toHaveTextContent(/mock payment/i);
    expect(note).not.toHaveClass("sr-only");
    expect(note.closest(".sr-only, [hidden], [aria-hidden=true]")).toBeNull();
    for (const n of Object.values(MOCK_CARDS)) {
      expect(within(note).getByText(n)).toBeInTheDocument();
    }
    expect(within(note).getAllByRole("listitem")).toHaveLength(4);
    // Each card carries a text outcome, not just a colour.
    expect(note).toHaveTextContent(/succeeds/);
    expect(note).toHaveTextContent(/declined/);
  });

  test("client-side card list equals the server MOCK_CARDS (no drift)", () => {
    expect({ ...MOCK_TEST_CARDS }).toEqual({ ...MOCK_CARDS });
  });

  test("notice uses a verified token pair", () => {
    render(<PaymentFields />);
    expect(screen.getByRole("note")).toHaveClass("bg-info-subtle", "text-info");
  });
});

describe("SummaryRow / SummaryList", () => {
  test("renders dt/dd pairs inside a labelled dl", () => {
    const { container } = render(
      <SummaryList aria-label="Order summary">
        <SummaryRow label="Subtotal" value="$10.00" />
        <SummaryRow label="Total" value="$12.00" emphasis />
      </SummaryList>,
    );
    const dl = container.querySelector("dl")!;
    expect(dl).toHaveAttribute("aria-label", "Order summary");
    expect([...dl.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Subtotal", "Total"]);
    expect([...dl.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["$10.00", "$12.00"]);
    expect(dl.querySelectorAll(":scope > div > dt + dd")).toHaveLength(2);
    expect(dl.children[1]).toHaveClass("text-h4");
  });
});
