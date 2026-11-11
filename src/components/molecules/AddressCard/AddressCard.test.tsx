import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { appError } from "@/lib/result";
import type { SavedAddress } from "@/lib/types";
import type { AddressActionFn, AddressActionState } from "../_contracts/address-actions";
import {
  AddressCard,
  DEFAULT_BADGE_TEXT,
  DELETE_CONFIRM_LABEL,
  DELETE_DIALOG_TITLE,
  addressSummary,
  addressTitle,
  cityLine,
  countryName,
} from "./index";

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

function failure(code: Parameters<typeof appError>[0], message: string): AddressActionState {
  return { ok: false, error: appError(code, message), message, fieldErrors: {}, values: {} };
}

const ADDRESS: SavedAddress = {
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

function noopActions() {
  return { delete: scriptedAction([]).action, setDefault: scriptedAction([]).action };
}

// happy-dom's accessible-name computation puts a space before the sr-only ", Home" suffix.
const named = (verb: string) => new RegExp(`^${verb}\\s*, Home$`);

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("helpers", () => {
  test("addressTitle prefers the label, else the full name", () => {
    expect(addressTitle(ADDRESS)).toBe("Home");
    expect(addressTitle({ ...ADDRESS, label: "  " })).toBe("Jane Doe");
  });

  test("addressSummary and cityLine drop blank parts", () => {
    expect(addressSummary(ADDRESS)).toBe("Home: Jane Doe, 1 Main St, Apt 2, Springfield");
    expect(addressSummary({ ...ADDRESS, label: "", line2: undefined })).toBe("Jane Doe, 1 Main St, Springfield");
    expect(cityLine(ADDRESS)).toBe("Springfield, IL 62704");
    expect(cityLine({ ...ADDRESS, region: "", postalCode: "" })).toBe("Springfield");
  });

  test("countryName maps known codes and falls back to the code", () => {
    expect(countryName("US")).toBe("United States");
    expect(countryName("gb")).toBe("United Kingdom");
    expect(countryName("ZZ")).toBe("ZZ");
  });
});

describe("AddressCard no-JS markup (renderToStaticMarkup)", () => {
  test("article with heading, text lines, set-default form and a two-step delete", () => {
    const html = renderToStaticMarkup(
      <AddressCard address={ADDRESS} actions={noopActions()} editHref="/account/addresses?edit=a-1" />,
    );
    const doc = parse(html);
    const article = doc.querySelector("article");
    const headingId = article?.getAttribute("aria-labelledby") ?? "";
    expect(doc.getElementById(headingId)?.tagName).toBe("H3");
    expect(doc.getElementById(headingId)?.textContent).toBe("Home");
    const text = article?.textContent ?? "";
    for (const part of ["Jane Doe", "1 Main St", "Apt 2", "Springfield, IL 62704", "United States", "Phone: +1 555 123 4567"]) {
      expect({ part, found: text.includes(part) }).toEqual({ part, found: true });
    }
    expect(text).not.toContain(DEFAULT_BADGE_TEXT);

    const forms = [...doc.querySelectorAll("form")];
    expect(forms).toHaveLength(2);
    const [setDefault, del] = forms;
    // Set as default: just the hidden id + submit.
    const sdInputs = [...(setDefault?.querySelectorAll("input[name]") ?? [])];
    expect(sdInputs.map((i) => [i.getAttribute("name"), i.getAttribute("type"), i.getAttribute("value")])).toEqual([
      ["addressId", "hidden", "a-1"],
    ]);
    expect(setDefault?.querySelector('button[type="submit"]')?.textContent).toBe("Set as default, Home");
    // Delete: inside <details>, hidden id + REQUIRED confirm checkbox (no hidden confirm).
    expect(del?.closest("details")).not.toBeNull();
    expect(del?.closest("details")?.querySelector("summary")?.textContent).toContain("Delete…");
    expect(del?.querySelector('input[name="addressId"]')?.getAttribute("value")).toBe("a-1");
    const confirm = del?.querySelectorAll('input[name="confirm"]') ?? [];
    expect(confirm).toHaveLength(1);
    expect(confirm[0]?.getAttribute("type")).toBe("checkbox");
    expect(confirm[0]?.getAttribute("value")).toBe("yes");
    expect(confirm[0]?.hasAttribute("required")).toBe(true);
    expect(del?.textContent).toContain(DELETE_CONFIRM_LABEL);
    expect(del?.querySelector('button[type="submit"]')?.textContent).toBe("Delete, Home");
    // No dialog before hydration.
    expect(doc.querySelector("dialog")).toBeNull();
    // Edit link.
    const edit = [...doc.querySelectorAll("a")].find((a) => a.textContent?.startsWith("Edit"));
    expect(edit?.getAttribute("href")).toBe("/account/addresses?edit=a-1");
    expect(edit?.textContent).toBe("Edit, Home");
  });

  test("default address: badge shown, no set-default form", () => {
    const html = renderToStaticMarkup(<AddressCard address={{ ...ADDRESS, isDefault: true }} actions={noopActions()} />);
    const doc = parse(html);
    expect(doc.querySelector("article")?.textContent).toContain(DEFAULT_BADGE_TEXT);
    expect(doc.querySelectorAll("form")).toHaveLength(1);
    expect(html).not.toContain("Set as default");
  });

  test("hostile address text renders as text and long lines wrap", () => {
    const long = "W".repeat(300);
    const hostile: SavedAddress = {
      ...ADDRESS,
      label: '<img src=x onerror="alert(1)">',
      fullName: "<b>bold</b>",
      line1: long,
      phone: "<i>1</i>",
    };
    const html = renderToStaticMarkup(<AddressCard address={hostile} actions={noopActions()} />);
    const doc = parse(html);
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("b")).toBeNull();
    expect(doc.querySelector("i")).toBeNull();
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    const article = doc.querySelector("article");
    expect(article?.className).toContain("break-words");
    expect(article?.className).toContain("min-w-0");
    const line = [...doc.querySelectorAll("p")].find((p) => p.textContent === long);
    expect(line?.parentElement?.className).toContain("break-words");
  });

  test("no actions: read-only card without forms", () => {
    const html = renderToStaticMarkup(<AddressCard address={ADDRESS} />);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<details");
  });

  test("selectable: a native radio named by the card, and no nested forms", () => {
    const html = renderToStaticMarkup(
      <AddressCard
        address={ADDRESS}
        actions={noopActions()}
        selectable={{ name: "addressId", value: "a-1", checked: true }}
        editHref="/account/addresses?edit=a-1"
      />,
    );
    const doc = parse(html);
    expect(doc.querySelector("form")).toBeNull();
    const radio = doc.querySelector('input[type="radio"]');
    expect(radio?.getAttribute("name")).toBe("addressId");
    expect(radio?.getAttribute("value")).toBe("a-1");
    expect(radio?.hasAttribute("checked")).toBe(true);
    const [choiceId, headingId] = (radio?.getAttribute("aria-labelledby") ?? "").split(" ");
    expect(doc.getElementById(choiceId ?? "")?.textContent).toBe("Deliver to this address");
    expect(doc.getElementById(headingId ?? "")?.textContent).toBe("Home");
    const describedBy = radio?.getAttribute("aria-describedby") ?? "";
    expect(doc.getElementById(describedBy)?.textContent).toContain("1 Main St");
    // The edit link still works.
    expect(html).toContain('href="/account/addresses?edit=a-1"');
  });

  test("headingLevel and compact", () => {
    const html = renderToStaticMarkup(<AddressCard address={ADDRESS} headingLevel={2} compact />);
    const doc = parse(html);
    expect(doc.querySelector("h2")?.textContent).toBe("Home");
    expect(doc.querySelector("article")?.className).toContain("p-3");
  });
});

describe("AddressCard interactions (hydrated)", () => {
  test("Delete opens a confirm dialog with the summary; Cancel closes without posting", async () => {
    const del = scriptedAction([]);
    render(<AddressCard address={ADDRESS} actions={{ delete: del.action, setDefault: scriptedAction([]).action }} />);
    expect(document.querySelector("details")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: named("Delete") }));
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    await waitFor(() => expect(dialog.open).toBe(true));
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.textContent).toContain(DELETE_DIALOG_TITLE);
    expect(dialog.textContent).toContain("Home: Jane Doe, 1 Main St, Apt 2, Springfield");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog.open).toBe(false));
    expect(del.calls).toHaveLength(0);
  });

  test("confirming posts addressId + confirm=yes; a failure closes the dialog and shows an alert", async () => {
    const del = scriptedAction([failure("NOT_FOUND", "Address not found.")]);
    render(<AddressCard address={ADDRESS} actions={{ delete: del.action, setDefault: scriptedAction([]).action }} />);
    fireEvent.click(screen.getByRole("button", { name: named("Delete") }));
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    await waitFor(() => expect(dialog.open).toBe(true));
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(del.calls).toHaveLength(1));
    expect(del.calls[0]).toEqual({ addressId: "a-1", confirm: "yes" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Address not found.");
    await waitFor(() => expect(dialog.open).toBe(false));
  });

  test("delete pending shows a busy Delete button; success is announced politely", async () => {
    const del = controlledAction();
    render(<AddressCard address={ADDRESS} actions={{ delete: del.action, setDefault: scriptedAction([]).action }} />);
    fireEvent.click(screen.getByRole("button", { name: named("Delete") }));
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    await waitFor(() => expect(dialog.open).toBe(true));
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
    await waitFor(() => {
      const submit = dialog.querySelector('button[type="submit"]');
      expect(submit?.getAttribute("aria-busy")).toBe("true");
    });
    del.resolve({ ok: true, kind: "deleted", message: "Address deleted.", addressId: "a-1" });
    const notice = await screen.findByText("Address deleted.");
    expect(notice.closest('[aria-live="polite"]')).not.toBeNull();
  });

  test("Set as default posts the id, shows pending, then a success notice", async () => {
    const sd = controlledAction();
    render(<AddressCard address={ADDRESS} actions={{ delete: scriptedAction([]).action, setDefault: sd.action }} />);
    const button = screen.getByRole("button", { name: named("Set as default") });
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    await waitFor(() => expect(sd.calls).toHaveLength(1));
    expect(sd.calls[0]).toEqual({ addressId: "a-1" });
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    sd.resolve({ ok: true, kind: "default_set", message: "Default address updated.", addressId: "a-1" });
    await screen.findByText("Default address updated.");
  });

  test("Set as default failure shows a role=alert message", async () => {
    const sd = scriptedAction([failure("RATE_LIMITED", "Too many changes. Try again in 5 minutes.")]);
    render(<AddressCard address={ADDRESS} actions={{ delete: scriptedAction([]).action, setDefault: sd.action }} />);
    fireEvent.submit(screen.getByRole("button", { name: named("Set as default") }).closest("form") as HTMLFormElement);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Too many changes.");
  });

  test("onEdit renders a button (wins over editHref)", () => {
    const onEdit = mock(() => {});
    render(<AddressCard address={ADDRESS} onEdit={onEdit} editHref="/x" />);
    fireEvent.click(screen.getByRole("button", { name: named("Edit") }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a[href="/x"]')).toBeNull();
  });
});
