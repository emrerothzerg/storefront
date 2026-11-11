import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ACCOUNT_FIELD, DELETE_CONFIRM_VALUE } from "../_contracts/account-actions";
import {
  ACCOUNT_FIELD_IDS,
  DELETE_ACCOUNT_FORM_ID,
  DELETE_CONFIRM_MAX_LENGTH,
  DELETE_DIALOG_TITLE,
  DELETE_EXPLANATION,
  DELETE_SUBMIT_LABEL,
  DeleteAccountForm,
} from "./index";
import {
  HOSTILE,
  SENTINEL,
  attributeDump,
  controlledAction,
  expectRealPostForm,
  failure,
  parse,
  scriptedAction,
  serverLikeAction,
} from "./_test-utils";
import { expectFocused } from "@/test/dom-assertions";

const form = () => document.getElementById(DELETE_ACCOUNT_FORM_ID) as HTMLFormElement;
const password = () => document.getElementById(ACCOUNT_FIELD_IDS.password) as HTMLInputElement;
const confirmInput = () => document.getElementById(ACCOUNT_FIELD_IDS.confirm) as HTMLInputElement;
const submit = () => form().querySelector('button[type="submit"]') as HTMLButtonElement;
const dialog = () => document.querySelector("dialog") as HTMLDialogElement;

function pressEscape(d: HTMLDialogElement) {
  // happy-dom does not map Escape -> cancel -> close; dispatch the native sequence.
  if (d.dispatchEvent(new Event("cancel", { cancelable: true }))) d.close();
}

function fill(pw: string, text: string) {
  fireEvent.change(password(), { target: { value: pw } });
  fireEvent.change(confirmInput(), { target: { value: text } });
}

async function openDialog() {
  fireEvent.click(submit());
  await waitFor(() => expect(dialog().open).toBe(true));
}

describe("DeleteAccountForm no-JS markup", () => {
  test("plain form: password + confirm fields, enabled danger submit, explanation, NO dialog", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(<DeleteAccountForm action={action} />);
    const doc = parse(html);
    const f = doc.querySelector("form");
    expect(f?.id).toBe(DELETE_ACCOUNT_FORM_ID);
    expect(f?.hasAttribute("novalidate")).toBe(true);
    expect(f?.getAttribute("aria-label")).toBe("Delete account");
    const pw = f?.querySelector(`input[name="${ACCOUNT_FIELD.password}"]`);
    expect(pw?.getAttribute("type")).toBe("password");
    expect(pw?.getAttribute("autocomplete")).toBe("current-password");
    expect(pw?.hasAttribute("value")).toBe(false);
    const confirm = f?.querySelector(`input[name="${ACCOUNT_FIELD.confirm}"]`);
    expect(confirm?.getAttribute("type")).toBe("text");
    expect(confirm?.getAttribute("autocomplete")).toBe("off");
    expect(confirm?.getAttribute("maxlength")).toBe("6");
    expect(DELETE_CONFIRM_MAX_LENGTH).toBe(DELETE_CONFIRM_VALUE.length);
    expect(doc.querySelector(`label[for="${ACCOUNT_FIELD_IDS.confirm}"]`)?.textContent).toContain("Type DELETE to confirm");
    expect(f?.querySelectorAll("input")).toHaveLength(2);
    const button = f?.querySelector('button[type="submit"]');
    expect(button?.textContent).toBe(DELETE_SUBMIT_LABEL);
    expect(button?.hasAttribute("disabled")).toBe(false);
    expect(button?.className).toContain("bg-danger");
    expect(button?.className).toContain("min-h-touch");
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("alertdialog");
    for (const line of DELETE_EXPLANATION) expect(doc.body.textContent).toContain(line);
    expect(doc.body.textContent).toContain("orders are kept anonymously");
  });
});

describe("DeleteAccountForm no-JS server action", () => {
  test("real POST multipart form, enabled submit, no dialog (D-T128-1)", () => {
    const html = renderToStaticMarkup(<DeleteAccountForm action={serverLikeAction()} />);
    const f = parse(html).querySelector("form");
    expect(() => expectRealPostForm(f)).not.toThrow();
    expect(f?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(f?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(html).not.toContain("javascript:");
    expect(f?.querySelector('input[name="password"]')).not.toBeNull();
    expect(f?.querySelector('input[name="confirm"]')).not.toBeNull();
    expect(f?.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(false);
    expect(html).not.toContain("<dialog");
  });
});

describe("DeleteAccountForm interactions (hydrated)", () => {
  test("submit disabled until the text is exactly DELETE (case/whitespace sensitive)", () => {
    const { action } = scriptedAction([]);
    render(<DeleteAccountForm action={action} />);
    expect(submit().disabled).toBe(true);
    for (const bad of ["delete", "DELET", " DELETE", "DELETe", "Delete"]) {
      fireEvent.change(confirmInput(), { target: { value: bad } });
      expect(submit().disabled).toBe(true);
    }
    fireEvent.change(confirmInput(), { target: { value: "DELETE" } });
    expect(submit().disabled).toBe(false);
    expect(submit().getAttribute("aria-haspopup")).toBe("dialog");
  });

  test("submit opens an alert Dialog (no post); focus moves into it; Cancel closes and returns focus to submit", async () => {
    const { action, calls } = scriptedAction([]);
    render(<DeleteAccountForm action={action} />);
    fill("pw-123456", "DELETE");
    await openDialog();
    const d = dialog();
    expect(d.getAttribute("role")).toBe("alertdialog");
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.textContent).toContain(DELETE_DIALOG_TITLE);
    expect(d.contains(form())).toBe(false);
    const cancel = within(d).getByRole("button", { name: "Cancel" });
    await waitFor(() => expectFocused(cancel));
    fireEvent.click(cancel);
    await waitFor(() => expect(d.open).toBe(false));
    expectFocused(submit());
    expect(calls).toHaveLength(0);
  });

  test("Escape closes the dialog without posting and returns focus to submit", async () => {
    const { action, calls } = scriptedAction([]);
    render(<DeleteAccountForm action={action} />);
    fill("pw-123456", "DELETE");
    await openDialog();
    pressEscape(dialog());
    await waitFor(() => expect(dialog().open).toBe(false));
    expectFocused(submit());
    expect(calls).toHaveLength(0);
  });

  test("focus is trapped: the dialog is opened with showModal (native inert background)", async () => {
    const original = HTMLDialogElement.prototype.showModal;
    let modalCalls = 0;
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      modalCalls += 1;
      original.call(this);
    };
    try {
      const { action } = scriptedAction([]);
      render(<DeleteAccountForm action={action} />);
      fill("pw-123456", "DELETE");
      await openDialog();
      expect(modalCalls).toBe(1);
      // Every focusable control inside the open dialog stays inside it.
      const focusables = dialog().querySelectorAll("button");
      expect(focusables.length).toBe(3); // Close, Cancel, Delete
      for (const el of focusables) expect(dialog().contains(el)).toBe(true);
    } finally {
      HTMLDialogElement.prototype.showModal = original;
    }
  });

  test("Enter in the form (no click) also opens the dialog only when DELETE is typed", async () => {
    const { action, calls } = scriptedAction([]);
    render(<DeleteAccountForm action={action} />);
    fill("pw-123456", "delete");
    fireEvent.submit(form());
    await new Promise((r) => setTimeout(r, 20));
    expect(dialog().open).toBe(false);
    expect(calls).toHaveLength(0);
    fireEvent.change(confirmInput(), { target: { value: "DELETE" } });
    fireEvent.submit(form());
    await waitFor(() => expect(dialog().open).toBe(true));
    expect(calls).toHaveLength(0);
  });

  test("confirming Delete posts exactly password + confirm via requestSubmit, once", async () => {
    const c = controlledAction();
    render(<DeleteAccountForm action={c.action} />);
    fill("pw-123456", "DELETE");
    await openDialog();
    const del = within(dialog()).getByRole("button", { name: "Delete" });
    fireEvent.click(del);
    await waitFor(() => expect(c.calls).toHaveLength(1));
    expect(c.calls[0]).toEqual({ password: "pw-123456", confirm: "DELETE" });
    await waitFor(() => expect(dialog().open).toBe(false));
    await waitFor(() => expect(submit().getAttribute("aria-busy")).toBe("true"));
    expect(form().getAttribute("aria-busy")).toBe("true");
    expect(submit().getAttribute("aria-disabled")).toBe("true");
    // While pending: more submits neither open the dialog nor post.
    fireEvent.submit(form());
    fireEvent.click(submit());
    await new Promise((r) => setTimeout(r, 20));
    expect(dialog().open).toBe(false);
    expect(c.calls).toHaveLength(1);
    await act(async () => c.resolve(failure("INTERNAL_ERROR", "Something went wrong. Please try again.")));
    await waitFor(() => expect(form().hasAttribute("aria-busy")).toBe(false));
  });

  test("wrong password: INVALID_CREDENTIALS on the password field, focused summary, fields + gate reset", async () => {
    const { action } = scriptedAction([
      failure("INVALID_CREDENTIALS", "Your password is incorrect.", { password: "Your password is incorrect." }),
    ]);
    render(<DeleteAccountForm action={action} />);
    fill(SENTINEL, "DELETE");
    await openDialog();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));
    const summary = await screen.findByTestId("delete-error-summary");
    expect(summary.getAttribute("role")).toBe("alert");
    expect(summary.textContent).toContain("Password: Your password is incorrect.");
    await waitFor(() => expectFocused(summary));
    await waitFor(() => expect(password().getAttribute("aria-invalid")).toBe("true"));
    expect(password().value).toBe("");
    expect(confirmInput().value).toBe("");
    expect(submit().disabled).toBe(true);
    expect(attributeDump(document.body)).not.toContain(SENTINEL);
    expect(document.body.innerHTML).not.toContain(SENTINEL);
  });

  test("server-side confirm error (the no-JS path) renders on the confirm field", async () => {
    const { action } = scriptedAction([
      failure("VALIDATION_FAILED", "Some fields are invalid.", {
        password: "Enter your password.",
        confirm: "Type DELETE to confirm.",
      }),
    ]);
    render(<DeleteAccountForm action={action} />);
    fill("x", "DELETE");
    await openDialog();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));
    const summary = await screen.findByTestId("delete-error-summary");
    expect(summary.textContent).toContain("Type DELETE to confirm: Type DELETE to confirm.");
    await waitFor(() => expect(confirmInput().getAttribute("aria-invalid")).toBe("true"));
    fireEvent.click(summary.querySelector(`a[href="#${ACCOUNT_FIELD_IDS.confirm}"]`) as HTMLAnchorElement);
    expectFocused(confirmInput());
  });

  test("RATE_LIMITED and UNAUTHENTICATED (second submit after deletion) texts", async () => {
    const { action } = scriptedAction([
      failure("RATE_LIMITED", "Too many attempts. Try again in 60 minutes.", {}, {}, 3600),
      failure("UNAUTHENTICATED", "Please sign in."),
    ]);
    render(<DeleteAccountForm action={action} />);
    fill("pw-123456", "DELETE");
    await openDialog();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.getByTestId("delete-error-summary").textContent).toBe("Too many attempts. Try again in 60 minutes."),
    );
    await waitFor(() => expect(form().hasAttribute("aria-busy")).toBe(false));
    fill("pw-123456", "DELETE");
    await openDialog();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByTestId("delete-error-summary").textContent).toContain("Please sign in."));
  });

  test("hostile server message renders as text", async () => {
    const { action } = scriptedAction([failure("INTERNAL_ERROR", HOSTILE)]);
    render(<DeleteAccountForm action={action} />);
    fill("pw-123456", "DELETE");
    await openDialog();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));
    const summary = await screen.findByTestId("delete-error-summary");
    expect(summary.textContent).toContain(HOSTILE);
    expect(summary.querySelector("img")).toBeNull();
  });
});
