import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { appError } from "@/lib/result";
import type { SavedAddress } from "@/lib/types";
import { parseAddressInput, LABEL_MAX, PHONE_MAX, ADDRESS_FIELD_MAX } from "@/server/addresses/address-service";
import {
  ADDRESS_MAX_LENGTH,
  type AddressActionFn,
  type AddressActionState,
  type AddressEchoValues,
} from "../_contracts/address-actions";
import {
  ADDRESS_FORM_IDS,
  AddressForm,
  DEFAULT_CHECKBOX_LABEL,
  IS_DEFAULT_TEXT,
  LABEL_HINT,
  PHONE_PATTERN,
  addressFormIds,
  addressSummaryItems,
  retryAfterText,
  toAddressFieldErrors,
} from "./index";
import { expectFocused, expectNull } from "@/test/dom-assertions";

type Fields = Record<string, string>;

function snapshot(formData: FormData): Fields {
  const out: Fields = {};
  formData.forEach((value, name) => {
    if (typeof value === "string") out[name] = value;
  });
  return out;
}

function scriptedAction(steps: ReadonlyArray<AddressActionState>) {
  const calls: Fields[] = [];
  const action: AddressActionFn = async (_prev, formData) => {
    calls.push(snapshot(formData));
    return steps[calls.length - 1] ?? null;
  };
  return { action, calls };
}

function controlledAction() {
  const calls: Fields[] = [];
  let resolveFn: (s: AddressActionState) => void = () => {};
  const action: AddressActionFn = (_prev, formData) => {
    calls.push(snapshot(formData));
    return new Promise<AddressActionState>((res) => {
      resolveFn = res;
    });
  };
  return { action, calls, resolve: (s: AddressActionState) => resolveFn(s) };
}

function failure(
  code: Parameters<typeof appError>[0],
  message: string,
  fieldErrors: Partial<Record<keyof AddressEchoValues, string>> = {},
  values: AddressEchoValues = {},
  extra: { retryAfterSeconds?: number; details?: Record<string, unknown> } = {},
): AddressActionState {
  const base = { ok: false as const, error: appError(code, message, extra.details), message, fieldErrors, values };
  return extra.retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds: extra.retryAfterSeconds };
}

const created: AddressActionState = { ok: true, kind: "saved", message: "Address saved.", addressId: "a-new" };
const updated: AddressActionState = { ok: true, kind: "saved", message: "Address updated.", addressId: "a-1" };

const SAVED: SavedAddress = {
  id: "a-1",
  label: "Home",
  fullName: "Jane Doe",
  phone: "+1 555 123 4567",
  line1: "1 Main St",
  line2: "Apt 2",
  city: "Springfield",
  region: "IL",
  postalCode: "62704",
  country: "US",
  isDefault: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const ids = ADDRESS_FORM_IDS;
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const form = () => document.getElementById(ids.form) as HTMLFormElement;

function fillValid() {
  fireEvent.change(input(ids.fullName), { target: { value: "Ada Lovelace" } });
  fireEvent.change(input(ids.line1), { target: { value: "12 Analytical Way" } });
  fireEvent.change(input(ids.city), { target: { value: "London" } });
  fireEvent.change(input(ids.region), { target: { value: "LDN" } });
  fireEvent.change(input(ids.postalCode), { target: { value: "N1 9GU" } });
  fireEvent.change(document.getElementById(ids.country) as HTMLSelectElement, { target: { value: "GB" } });
  fireEvent.change(input(ids.label), { target: { value: "Office" } });
  fireEvent.change(input(ids.phone), { target: { value: "+44 20 7946 0000" } });
}

function parseHtml(html: string) {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("helpers", () => {
  test("caps mirror the address service constants", () => {
    expect(ADDRESS_MAX_LENGTH.label).toBe(LABEL_MAX);
    expect(ADDRESS_MAX_LENGTH.phone).toBe(PHONE_MAX);
    expect(ADDRESS_MAX_LENGTH.fullName).toBe(ADDRESS_FIELD_MAX);
  });

  test("PHONE_PATTERN compiles with the v flag (as browsers do) and agrees with the server phone rule", () => {
    const re = new RegExp(`^(?:${PHONE_PATTERN})$`, "v");
    const base = { fullName: "A B", line1: "1 St", city: "C", region: "R", postalCode: "12345", country: "US" };
    const samples = [
      "+1 (555) 123-4567",
      "1234567",
      "555-1234",
      "(020) 7946 0000",
      "123456",
      "12345678901234567890",
      "abc1234567",
      "((((((((",
      "+44.20.7946.0000",
      "1234567#",
      "  1 2 3 4 5 6 7",
      "1234567٠",
    ];
    for (const phone of samples) {
      const server = parseAddressInput({ ...base, phone });
      const serverOk = server.ok;
      // maxLength stops longer input in the browser; the pattern covers the rest.
      const clientOk = phone.length <= PHONE_MAX && re.test(phone);
      expect({ phone, ok: clientOk }).toEqual({ phone, ok: serverOk });
    }
  });

  test("addressFormIds follow the AddressFields id scheme", () => {
    const p = addressFormIds("edit-a1");
    expect(p.fullName).toBe("edit-a1-fullName");
    expect(p.postalCode).toBe("edit-a1-postalCode");
    expect(p.phone).toBe("edit-a1-phone");
    expect(p.form).toBe("edit-a1");
    expect(ADDRESS_FORM_IDS.label).toBe("address-form-label");
  });

  test("retryAfterText rounds up and falls back", () => {
    expect(retryAfterText(61)).toBe("Try again in 2 minutes.");
    expect(retryAfterText(1)).toBe("Try again in 1 minute.");
    expect(retryAfterText(undefined)).toBe("Try again later.");
    expect(retryAfterText(Number.NaN)).toBe("Try again later.");
  });

  test("addressSummaryItems keeps form order, skips blanks and unlinks hidden controls", () => {
    const f = failure("VALIDATION_FAILED", "m", { phone: "Bad", fullName: "Required", line2: " ", label: "Too long" });
    if (f === null || f.ok) throw new Error("expected failure");
    const all = addressSummaryItems(f, ids, { label: true, isDefault: true });
    expect(all.map((i) => i.field)).toEqual(["fullName", "label", "phone"]);
    expect(all.map((i) => i.id)).toEqual([ids.fullName, ids.label, ids.phone]);
    const noLabel = addressSummaryItems(f, ids, { label: false, isDefault: true });
    expect(noLabel.find((i) => i.field === "label")?.id).toBeNull();
  });

  test("toAddressFieldErrors keeps address fields only and maps codes", () => {
    const f = failure(
      "VALIDATION_FAILED",
      "m",
      { city: "City is required.", phone: "Bad", country: "Pick one" },
      {},
      { details: { fields: { city: "REQUIRED", country: "NOT_A_CODE" } } },
    );
    if (f === null || f.ok) throw new Error("expected failure");
    expect(toAddressFieldErrors(f)).toEqual({
      city: { code: "REQUIRED", message: "City is required." },
      country: { code: "INVALID_TYPE", message: "Pick one" },
    });
    expect(toAddressFieldErrors(null)).toEqual({});
  });
});

describe("AddressForm no-JS markup (renderToStaticMarkup)", () => {
  test("plain create form: every contract field, autocomplete tokens, caps and pattern", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(<AddressForm action={action} />);
    const doc = parseHtml(html);
    const f = doc.querySelector("form");
    expect(f?.id).toBe("address-form");
    expect(f?.getAttribute("aria-label")).toBe("Add an address");
    const one = (n: string) => f?.querySelector(`[name="${n}"]`) ?? null;
    for (const n of ["fullName", "line1", "line2", "city", "region", "postalCode", "country", "label", "phone", "isDefault"]) {
      expect({ n, present: one(n) !== null }).toEqual({ n, present: true });
    }
    expect(one("addressId")).toBeNull();
    // T16 criterion: autocomplete tokens on the composed AddressFields.
    expect(one("fullName")?.getAttribute("autocomplete")).toBe("name");
    expect(one("line1")?.getAttribute("autocomplete")).toBe("address-line1");
    expect(one("line2")?.getAttribute("autocomplete")).toBe("address-line2");
    expect(one("city")?.getAttribute("autocomplete")).toBe("address-level2");
    expect(one("region")?.getAttribute("autocomplete")).toBe("address-level1");
    expect(one("postalCode")?.getAttribute("autocomplete")).toBe("postal-code");
    expect(one("country")?.getAttribute("autocomplete")).toBe("country");
    // Label / phone / default.
    expect(one("label")?.getAttribute("maxlength")).toBe("40");
    expect(one("label")?.hasAttribute("required")).toBe(false);
    expect(one("phone")?.getAttribute("type")).toBe("tel");
    expect(one("phone")?.getAttribute("inputmode")).toBe("tel");
    expect(one("phone")?.getAttribute("autocomplete")).toBe("tel");
    expect(one("phone")?.getAttribute("maxlength")).toBe("20");
    expect(one("phone")?.getAttribute("pattern")).toBe(PHONE_PATTERN);
    expect(one("isDefault")?.getAttribute("type")).toBe("checkbox");
    expect(one("isDefault")?.getAttribute("value")).toBe("on");
    expect(html).toContain(DEFAULT_CHECKBOX_LABEL);
    expect(html).toContain(LABEL_HINT);
    const submit = f?.querySelector('button[type="submit"]');
    expect(submit?.textContent).toBe("Save address");
    expect(html).not.toContain("outline-none");
  });

  test("D-T98-2: no email input or email text at all (AddressFields omit), no CSS hiding", () => {
    const { action } = scriptedAction([]);
    for (const address of [null, SAVED]) {
      const html = renderToStaticMarkup(<AddressForm action={action} address={address} idPrefix="nomail" />);
      const doc = parseHtml(html);
      expect(doc.querySelector('[name="email"]')).toBeNull();
      expect(doc.getElementById("nomail-email")).toBeNull();
      expect(doc.querySelector('input[type="email"]')).toBeNull();
      expect(doc.body.textContent ?? "").not.toMatch(/email/i);
      expect(html).not.toContain("nth-2");
      // Second grid cell is now line 1 (fullName spans both columns, email is gone).
      const grid = doc.querySelector("fieldset")?.children[1];
      expect(grid?.children[1]?.querySelector("input")?.getAttribute("name")).toBe("line1");
    }
  });

  test("D-T98-3: submitContext adds a screen-reader-only suffix; visible text unchanged", () => {
    const { action } = scriptedAction([]);
    const doc = parseHtml(
      renderToStaticMarkup(<AddressForm action={action} address={SAVED} submitContext="  Home  " />),
    );
    const submit = doc.querySelector('button[type="submit"]');
    expect(submit?.textContent).toBe("Update address: Home");
    const hidden = submit?.querySelector(".sr-only");
    expect(hidden?.textContent).toBe(": Home");
    for (const blank of [undefined, "", "   "]) {
      const plain = parseHtml(renderToStaticMarkup(<AddressForm action={action} address={SAVED} submitContext={blank} />));
      expect(plain.querySelector('button[type="submit"]')?.textContent).toBe("Update address");
    }
  });

  test("edit mode posts a hidden addressId and pre-fills (hostile text stays text)", () => {
    const { action } = scriptedAction([]);
    const hostile: SavedAddress = { ...SAVED, label: '<img src=x onerror="alert(1)">', line1: "<script>x</script>" };
    const html = renderToStaticMarkup(<AddressForm action={action} address={hostile} idPrefix="edit" />);
    const doc = parseHtml(html);
    const f = doc.querySelector("form");
    expect(f?.getAttribute("aria-label")).toBe("Edit address");
    const id = f?.querySelector('[name="addressId"]');
    expect(id?.getAttribute("type")).toBe("hidden");
    expect(id?.getAttribute("value")).toBe("a-1");
    expect(f?.querySelector('[name="label"]')?.getAttribute("value")).toBe('<img src=x onerror="alert(1)">');
    expect(f?.querySelector('[name="line1"]')?.getAttribute("value")).toBe("<script>x</script>");
    expect(f?.querySelector('[name="phone"]')?.getAttribute("value")).toBe("+1 555 123 4567");
    expect(doc.querySelector("img")).toBeNull();
    // React's own form-replay <script> is fine; the address text must not become one.
    expect(html).not.toContain("<script>x");
    expect([...doc.querySelectorAll("script")].some((el) => el.textContent === "x")).toBe(false);
    expect(f?.querySelector('button[type="submit"]')?.textContent).toBe("Update address");
    expect(doc.getElementById("edit-fullName")).not.toBeNull();
  });

  test("editing the current default shows a note instead of the checkbox", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(<AddressForm action={action} address={{ ...SAVED, isDefault: true }} />);
    expect(html).not.toContain('name="isDefault"');
    expect(html).toContain(IS_DEFAULT_TEXT);
  });

  test("showLabel / showDefaultCheckbox / submitLabel / compact", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(
      <AddressForm action={action} showLabel={false} showDefaultCheckbox={false} submitLabel="Use this address" compact />,
    );
    expect(html).not.toContain('name="label"');
    expect(html).not.toContain('name="isDefault"');
    expect(html).toContain("Use this address");
    expect(html).toContain('name="phone"');
  });
});

describe("AddressForm interactions", () => {
  test("posts the contract fields only (no email)", async () => {
    const { action, calls } = scriptedAction([created]);
    render(<AddressForm action={action} />);
    fillValid();
    fireEvent.click(screen.getByLabelText(DEFAULT_CHECKBOX_LABEL));
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      fullName: "Ada Lovelace",
      line1: "12 Analytical Way",
      line2: "",
      city: "London",
      region: "LDN",
      postalCode: "N1 9GU",
      country: "GB",
      label: "Office",
      phone: "+44 20 7946 0000",
      isDefault: "on",
    });
  });

  test("field errors: summary links to fields, aria-invalid + aria-describedby, values persist", async () => {
    const values: AddressEchoValues = { fullName: "", line1: "1 Way", city: "X", phone: "abc", label: "Lab", isDefault: "on" };
    const { action } = scriptedAction([
      failure(
        "VALIDATION_FAILED",
        "Some fields are invalid.",
        { fullName: "Full name is required.", phone: "Phone may contain only digits." },
        values,
      ),
    ]);
    render(<AddressForm action={action} />);
    fireEvent.submit(form());
    const summary = await screen.findByTestId("address-error-summary");
    expect(summary.getAttribute("role")).toBe("alert");
    const links = summary.querySelectorAll("a");
    expect([...links].map((a) => a.getAttribute("href"))).toEqual([`#${ids.fullName}`, `#${ids.phone}`]);
    await waitFor(() => expectFocused(summary));

    const name = input(ids.fullName);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe(`${ids.fullName}-error`);
    expect(document.getElementById(`${ids.fullName}-error`)?.textContent).toBe("Full name is required.");
    const phone = input(ids.phone);
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    expect(phone.getAttribute("aria-describedby")).toContain(`${ids.phone}-error`);
    expect(phone.value).toBe("abc");
    expect(input(ids.line1).value).toBe("1 Way");
    expect(input(ids.label).value).toBe("Lab");
    expect(input(ids.isDefault).checked).toBe(true);

    fireEvent.click(links[1] as HTMLAnchorElement);
    expectFocused(phone);
  });

  test.each([
    ["LIMIT_REACHED", "You can save up to 10 addresses. Delete one to add another.", "Address book full"],
    ["DUPLICATE", "You already saved this address.", "Address not saved"],
    ["NOT_FOUND", "Address not found.", "Address not saved"],
    ["INVALID_INPUT", "Something went wrong. Try again.", "Address not saved"],
  ] as const)("%s shows its notice and keeps the values", async (code, message, title) => {
    const { action } = scriptedAction([failure(code, message, {}, { line1: "Kept St" })]);
    render(<AddressForm action={action} />);
    fireEvent.submit(form());
    const summary = await screen.findByTestId("address-error-summary");
    expect(summary.textContent).toContain(title);
    expect(summary.textContent).toContain(message);
    expect(input(ids.line1).value).toBe("Kept St");
  });

  test("RATE_LIMITED shows the retry hint once", async () => {
    const { action } = scriptedAction([
      failure("RATE_LIMITED", "Too many changes. Try again in 5 minutes.", {}, {}, { retryAfterSeconds: 290 }),
    ]);
    render(<AddressForm action={action} />);
    fireEvent.submit(form());
    const summary = await screen.findByTestId("address-error-summary");
    expect(summary.textContent).toContain("Too many address changes");
    expect(summary.textContent).toContain("Try again in 5 minutes.");
    expect(summary.textContent?.match(/Try again/g)?.length).toBe(1);
  });

  test("create success: live-region notice, fields reset, onSaved called", async () => {
    const saved: AddressActionState[] = [];
    const { action } = scriptedAction([created]);
    render(<AddressForm action={action} onSaved={(s) => saved.push(s)} />);
    fillValid();
    fireEvent.submit(form());
    const notice = await screen.findByText("Address saved.");
    expect(notice.closest('[aria-live="polite"]')).not.toBeNull();
    // onSaved runs in a passive effect, which may flush after the notice is visible.
    await waitFor(() => expect(saved).toEqual([created]));
    expect(input(ids.fullName).value).toBe("");
    expect(input(ids.phone).value).toBe("");
  });

  test("edit success keeps the fields", async () => {
    const { action, calls } = scriptedAction([updated]);
    render(<AddressForm action={action} address={SAVED} />);
    fireEvent.change(input(ids.city), { target: { value: "Shelbyville" } });
    fireEvent.submit(form());
    await screen.findByText("Address updated.");
    expect(calls[0]?.addressId).toBe("a-1");
    expect(calls[0]?.city).toBe("Shelbyville");
    expect(input(ids.fullName).value).toBe("Jane Doe");
  });

  test("pending: submit shows Saving… with aria-busy and a second submit is swallowed", async () => {
    const { action, calls, resolve } = controlledAction();
    render(<AddressForm action={action} />);
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    const button = await screen.findByRole("button", { name: /saving/i });
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.submit(form());
    expect(calls).toHaveLength(1);
    resolve(created);
    await screen.findByText("Address saved.");
  });

  test("a failure after a success replaces the success notice", async () => {
    const { action, calls } = scriptedAction([created, failure("DUPLICATE", "You already saved this address.")]);
    render(<AddressForm action={action} />);
    fireEvent.submit(form());
    // Wait for the first attempt to fully settle: action called once, notice
    // shown and the submit button back to its idle label.
    await waitFor(() => {
      expect(calls).toHaveLength(1);
      expect(screen.getByText("Address saved.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save address" }).getAttribute("aria-busy")).toBeNull();
    });
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(2));
    const summary = await screen.findByTestId("address-error-summary");
    expect(summary.textContent).toContain("You already saved this address.");
    await waitFor(() => expectNull(screen.queryByText("Address saved.")));
  });

  test("resubmitting right after a settled attempt is not swallowed by the double-submit guard", async () => {
    const { action, calls } = scriptedAction([created, created]);
    render(<AddressForm action={action} />);
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    await screen.findByText("Address saved.");
    // Immediately, without letting passive effects flush first.
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(2));
  });
});

describe("AddressForm: no-JS submission with a server action (consistency ai)", () => {
  // Mimics what a Next server reference exposes to React's SSR: `$$FORM_ACTION`,
  // kept across `.bind` (useActionState binds the previous state).
  function serverLikeAction(): AddressActionFn {
    const formFields = () => ({
      name: "$ACTION_REF_1",
      action: "",
      encType: "multipart/form-data",
      method: "POST",
      data: null,
    });
    return Object.assign(async (): Promise<AddressActionState> => null, {
      $$FORM_ACTION: formFields,
      bind(): unknown {
        return Object.assign(async () => null, { $$FORM_ACTION: formFields });
      },
    });
  }

  test("create and edit server markup are real POST forms (method, multipart enctype, no javascript: action)", () => {
    for (const element of [
      <AddressForm key="create" action={serverLikeAction()} />,
      <AddressForm key="edit" action={serverLikeAction()} address={SAVED} idPrefix="edit" />,
    ]) {
      const form = parseHtml(renderToStaticMarkup(element)).querySelector("form");
      expect(form).not.toBeNull();
      expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
      expect(form?.getAttribute("enctype")).toBe("multipart/form-data");
      expect(form?.getAttribute("action") ?? "").not.toContain("javascript:");
    }
  });
});
