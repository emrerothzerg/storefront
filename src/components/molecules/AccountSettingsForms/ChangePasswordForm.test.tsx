import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ACCOUNT_FIELD, type AccountActionState } from "../_contracts/account-actions";
import {
  ACCOUNT_FIELD_IDS,
  CHANGE_PASSWORD_FORM_ID,
  CONFIRM_MISMATCH_HINT,
  ChangePasswordForm,
  FIX_FIELDS_TITLE,
  NEW_PASSWORD_RULES,
  PASSWORD_CHANGED_MESSAGE,
} from "./index";
import {
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

const success: AccountActionState = {
  ok: true,
  kind: "password_changed",
  message: "Your password has been changed. Other devices have been signed out.",
};

const form = () => document.getElementById(CHANGE_PASSWORD_FORM_ID) as HTMLFormElement;
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const current = () => field(ACCOUNT_FIELD_IDS.currentPassword);
const next = () => field(ACCOUNT_FIELD_IDS.newPassword);
const confirm = () => field(ACCOUNT_FIELD_IDS.confirmPassword);
const submit = () => form().querySelector('button[type="submit"]') as HTMLButtonElement;
const hint = () => screen.getByTestId("confirm-mismatch-hint");

function fill(cur: string, nw: string, conf: string) {
  fireEvent.change(current(), { target: { value: cur } });
  fireEvent.change(next(), { target: { value: nw } });
  fireEvent.change(confirm(), { target: { value: conf } });
}

function expectAllEmpty() {
  expect(current().value).toBe("");
  expect(next().value).toBe("");
  expect(confirm().value).toBe("");
}

describe("ChangePasswordForm no-JS markup", () => {
  test("three password inputs with contract names, autocomplete, maxLength 128; rules visible; no dialog", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(<ChangePasswordForm action={action} />);
    const doc = parse(html);
    const f = doc.querySelector("form");
    expect(f?.id).toBe(CHANGE_PASSWORD_FORM_ID);
    expect(f?.hasAttribute("novalidate")).toBe(true);
    expect(f?.getAttribute("aria-label")).toBe("Change password");
    const byName = (n: string) => f?.querySelector(`input[name="${n}"]`);
    const expected: Array<[string, string]> = [
      [ACCOUNT_FIELD.currentPassword, "current-password"],
      [ACCOUNT_FIELD.newPassword, "new-password"],
      [ACCOUNT_FIELD.confirmPassword, "new-password"],
    ];
    for (const [name, autocomplete] of expected) {
      const input = byName(name);
      expect(input?.getAttribute("type")).toBe("password");
      expect(input?.getAttribute("autocomplete")).toBe(autocomplete);
      expect(input?.getAttribute("maxlength")).toBe("128");
      expect(input?.hasAttribute("value")).toBe(false);
      expect(input?.hasAttribute("required")).toBe(true);
    }
    expect(f?.querySelectorAll("input")).toHaveLength(3);
    expect(html).toContain(NEW_PASSWORD_RULES);
    expect(NEW_PASSWORD_RULES).toContain("8 to 128");
    expect(doc.querySelector('[data-testid="confirm-mismatch-hint"]')?.getAttribute("aria-live")).toBe("polite");
    expect(f?.querySelector('button[type="submit"]')?.textContent).toBe("Change password");
    expect(html).not.toContain("<dialog");
  });
});

describe("ChangePasswordForm no-JS server action", () => {
  test("real POST multipart form with the three password inputs (D-T128-1)", () => {
    const html = renderToStaticMarkup(<ChangePasswordForm action={serverLikeAction()} />);
    const f = parse(html).querySelector("form");
    expect(() => expectRealPostForm(f)).not.toThrow();
    expect(f?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(f?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(html).not.toContain("javascript:");
    expect(f?.querySelectorAll('input[type="password"]')).toHaveLength(3);
    expect(f?.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(false);
  });
});

describe("ChangePasswordForm interactions", () => {
  test("posts exactly the three fields; success announces in role=status and clears every field", async () => {
    const { action, calls } = scriptedAction([success]);
    render(<ChangePasswordForm action={action} />);
    fill("old-password-1", "new-password-22", "new-password-22");
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      currentPassword: "old-password-1",
      newPassword: "new-password-22",
      confirmPassword: "new-password-22",
    });
    await waitFor(() => expect(screen.getByTestId("password-status").textContent).toContain(PASSWORD_CHANGED_MESSAGE));
    expect(screen.getByTestId("password-status").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByTestId("password-status").querySelector('[role="status"]')).not.toBeNull();
    await waitFor(() => expectAllEmpty());
  });

  test("failure also clears every password field (criterion 1)", async () => {
    const { action } = scriptedAction([
      failure("VALIDATION_FAILED", "Some fields are invalid.", { newPassword: "Password must be at least 8 characters." }),
    ]);
    render(<ChangePasswordForm action={action} />);
    fill("old-password-1", "short", "short");
    fireEvent.submit(form());
    await screen.findByTestId("password-error-summary");
    await waitFor(() => expectAllEmpty());
  });

  test("INVALID_CREDENTIALS lands on the current password field + focused summary with a link to it", async () => {
    const { action } = scriptedAction([
      failure("INVALID_CREDENTIALS", "Your current password is incorrect.", {
        currentPassword: "Your current password is incorrect.",
      }),
    ]);
    render(<ChangePasswordForm action={action} />);
    fill("wrong-password", "new-password-22", "new-password-22");
    fireEvent.submit(form());
    const summary = await screen.findByTestId("password-error-summary");
    expect(summary.getAttribute("role")).toBe("alert");
    expect(summary.textContent).toContain(FIX_FIELDS_TITLE);
    expect(summary.textContent).toContain("Current password: Your current password is incorrect.");
    await waitFor(() => expectFocused(summary));
    await waitFor(() => expect(current().getAttribute("aria-invalid")).toBe("true"));
    expect(next().getAttribute("aria-invalid")).not.toBe("true");
    fireEvent.click(summary.querySelector(`a[href="#${ACCOUNT_FIELD_IDS.currentPassword}"]`) as HTMLAnchorElement);
    expectFocused(current());
  });

  test("policy and confirm errors render on their own fields", async () => {
    const { action } = scriptedAction([
      failure("VALIDATION_FAILED", "Some fields are invalid.", {
        newPassword: "This password is too easy to guess. Choose a less common one.",
        confirmPassword: "The passwords do not match.",
      }),
    ]);
    render(<ChangePasswordForm action={action} />);
    fireEvent.submit(form());
    const summary = await screen.findByTestId("password-error-summary");
    expect(summary.textContent).toContain("New password: This password is too easy to guess.");
    expect(summary.textContent).toContain("Confirm new password: The passwords do not match.");
    await waitFor(() => expect(confirm().getAttribute("aria-invalid")).toBe("true"));
    expect(next().getAttribute("aria-invalid")).toBe("true");
    expect(current().getAttribute("aria-invalid")).not.toBe("true");
  });

  test("RATE_LIMITED (also a locked account, R-10) -> 'Too many attempts. Try again in N minutes.'", async () => {
    const { action } = scriptedAction([
      failure("RATE_LIMITED", "Too many attempts. Try again in 15 minutes.", {}, {}, 900),
      failure("ACCOUNT_LOCKED", "Locked.", {}, {}, 61),
    ]);
    render(<ChangePasswordForm action={action} />);
    fireEvent.submit(form());
    let summary = await screen.findByTestId("password-error-summary");
    expect(summary.textContent).toBe("Too many attempts. Try again in 15 minutes.");
    await waitFor(() => expect(submit().hasAttribute("aria-busy")).toBe(false));
    fireEvent.submit(form());
    await waitFor(() =>
      expect(screen.getByTestId("password-error-summary").textContent).toBe("Too many attempts. Try again in 2 minutes."),
    );
    summary = screen.getByTestId("password-error-summary");
    expect(summary.textContent).not.toContain("Locked");
  });

  test("UNAUTHENTICATED and INTERNAL_ERROR show their messages", async () => {
    const { action } = scriptedAction([
      failure("UNAUTHENTICATED", "Please sign in."),
      failure("INTERNAL_ERROR", "Something went wrong. Please try again."),
    ]);
    render(<ChangePasswordForm action={action} />);
    fireEvent.submit(form());
    await waitFor(() => expect(screen.getByTestId("password-error-summary").textContent).toContain("Please sign in."));
    await waitFor(() => expect(submit().hasAttribute("aria-busy")).toBe(false));
    fireEvent.submit(form());
    await waitFor(() =>
      expect(screen.getByTestId("password-error-summary").textContent).toContain("Password not changed"),
    );
    expect(screen.getByTestId("password-error-summary").textContent).toContain("Something went wrong. Please try again.");
  });

  test("mismatch hint is non-blocking: appears only when confirm differs, and the form still posts", async () => {
    const { action, calls } = scriptedAction([
      failure("VALIDATION_FAILED", "Some fields are invalid.", { confirmPassword: "The passwords do not match." }),
    ]);
    render(<ChangePasswordForm action={action} />);
    expect(hint().textContent).toBe("");
    fireEvent.change(next(), { target: { value: "abcdefgh1" } });
    expect(hint().textContent).toBe("");
    fireEvent.change(confirm(), { target: { value: "abcdefgh" } });
    expect(hint().textContent).toBe(CONFIRM_MISMATCH_HINT);
    fireEvent.change(confirm(), { target: { value: "abcdefgh1" } });
    expect(hint().textContent).toBe("");
    fireEvent.change(next(), { target: { value: "abcdefgh12" } });
    expect(hint().textContent).toBe(CONFIRM_MISMATCH_HINT);
    expect(submit().hasAttribute("disabled")).toBe(false);
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    // Server stays authoritative; after the reset the hint clears.
    await screen.findByTestId("password-error-summary");
    await waitFor(() => expect(hint().textContent).toBe(""));
  });

  test("pending: aria-busy + busy button; double submit sends once; a throwing action releases the guard", async () => {
    const c = controlledAction();
    render(<ChangePasswordForm action={c.action} />);
    fireEvent.submit(form());
    fireEvent.submit(form());
    await waitFor(() => expect(submit().getAttribute("aria-busy")).toBe("true"));
    expect(form().getAttribute("aria-busy")).toBe("true");
    expect(submit().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(submit());
    fireEvent.submit(form());
    await new Promise((r) => setTimeout(r, 20));
    expect(c.calls).toHaveLength(1);
    await act(async () => c.resolve(success));
    await waitFor(() => expect(form().hasAttribute("aria-busy")).toBe(false));
    fireEvent.submit(form());
    await waitFor(() => expect(c.calls).toHaveLength(2));
    await act(async () => c.resolve(success));
  });

  test("sentinel password never appears in attributes, data-*, markup or storage (before and after submit)", async () => {
    const { action } = scriptedAction([
      failure("INVALID_CREDENTIALS", "Your current password is incorrect.", { currentPassword: "Your current password is incorrect." }),
      success,
    ]);
    const { container } = render(<ChangePasswordForm action={action} />);
    fill(SENTINEL, `${SENTINEL}-new`, `${SENTINEL}-new`);
    expect(attributeDump(container)).not.toContain(SENTINEL);
    expect(container.innerHTML).not.toContain(SENTINEL);
    // Toggle visibility: still not in markup.
    for (const button of container.querySelectorAll<HTMLButtonElement>('button[aria-label="Show password"]')) {
      fireEvent.click(button);
    }
    expect(container.innerHTML).not.toContain(SENTINEL);
    fireEvent.submit(form());
    await screen.findByTestId("password-error-summary");
    expect(container.innerHTML).not.toContain(SENTINEL);
    expect(attributeDump(container)).not.toContain(SENTINEL);
    await waitFor(() => expect(submit().hasAttribute("aria-busy")).toBe(false));
    fill(SENTINEL, `${SENTINEL}-new`, `${SENTINEL}-new`);
    fireEvent.submit(form());
    await waitFor(() => expect(screen.getByTestId("password-status").textContent).toContain(PASSWORD_CHANGED_MESSAGE));
    expect(container.innerHTML).not.toContain(SENTINEL);
    expect(attributeDump(container)).not.toContain(SENTINEL);
    expect(document.cookie).not.toContain(SENTINEL);
  });
});
