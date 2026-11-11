import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DISPLAY_NAME_MAX } from "@/server/auth/password-policy";
import { ACCOUNT_FIELD, DISPLAY_NAME_MAX_LENGTH, type AccountActionState } from "../_contracts/account-actions";
import {
  ACCOUNT_FIELD_IDS,
  EMAIL_READ_ONLY_NOTE,
  FIX_FIELDS_TITLE,
  PROFILE_FORM_ID,
  PROFILE_UPDATED_MESSAGE,
  ProfileForm,
} from "./index";
import { HOSTILE, controlledAction, expectRealPostForm, failure, parse, scriptedAction, serverLikeAction } from "./_test-utils";
import { expectFocused } from "@/test/dom-assertions";

const success = (displayName: string): AccountActionState => ({
  ok: true,
  kind: "profile_updated",
  message: "Your display name has been updated.",
  displayName,
});

const form = () => document.getElementById(PROFILE_FORM_ID) as HTMLFormElement;
const nameInput = () => document.getElementById(ACCOUNT_FIELD_IDS.displayName) as HTMLInputElement;
const submit = () => form().querySelector('button[type="submit"]') as HTMLButtonElement;

describe("ProfileForm no-JS markup", () => {
  test("plain form: email as text (no input), displayName input with name/autocomplete/maxLength/required", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(<ProfileForm action={action} displayName="Ada" email="ada@example.com" />);
    const doc = parse(html);
    const f = doc.querySelector("form");
    expect(f?.id).toBe(PROFILE_FORM_ID);
    expect(f?.getAttribute("aria-label")).toBe("Profile");
    expect(f?.hasAttribute("novalidate")).toBe(true);
    expect(f?.querySelectorAll("input")).toHaveLength(1);
    const input = f?.querySelector(`input[name="${ACCOUNT_FIELD.displayName}"]`);
    expect(input?.getAttribute("autocomplete")).toBe("name");
    expect(input?.getAttribute("maxlength")).toBe(String(DISPLAY_NAME_MAX_LENGTH));
    expect(input?.hasAttribute("required")).toBe(true);
    expect(input?.getAttribute("value")).toBe("Ada");
    expect(doc.querySelector('label[for="account-display-name"]')?.textContent).toContain("Display name");
    expect(doc.querySelector('[data-testid="profile-email"]')?.textContent).toBe("ada@example.com");
    expect(html).not.toContain('type="email"');
    expect(html).toContain(EMAIL_READ_ONLY_NOTE);
    const button = f?.querySelector('button[type="submit"]');
    expect(button?.textContent).toBe("Save");
    expect(button?.hasAttribute("disabled")).toBe(false);
    expect(button?.className).toContain("min-h-touch");
    expect(html).not.toContain("<dialog");
  });

  test("no-JS with a server action: real POST multipart form (D-T128-1)", () => {
    const html = renderToStaticMarkup(<ProfileForm action={serverLikeAction()} displayName="Ada" email="a@b.c" />);
    const f = parse(html).querySelector("form");
    expect(() => expectRealPostForm(f)).not.toThrow();
    expect(f?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(f?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(html).not.toContain("javascript:");
    expect(f?.querySelector('input[name="displayName"]')?.getAttribute("value")).toBe("Ada");
    expect(f?.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(false);
  });

  test("maxLength mirrors the server policy", () => {
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(DISPLAY_NAME_MAX);
  });

  test("hostile display name and email render inert", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(<ProfileForm action={action} displayName={HOSTILE} email={`${HOSTILE}@x.io`} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;@x.io");
  });

  test("headingId replaces aria-label", () => {
    const { action } = scriptedAction([]);
    const html = renderToStaticMarkup(<ProfileForm action={action} displayName="A" email="a@b.c" headingId="h" />);
    expect(html).toContain('aria-labelledby="h"');
    expect(html).not.toContain('aria-label="Profile"');
  });
});

describe("ProfileForm interactions", () => {
  test("posts only displayName; success is announced in role=status and the stored name is shown", async () => {
    const { action, calls } = scriptedAction([success("Grace H.")]);
    render(<ProfileForm action={action} displayName="Ada" email="ada@example.com" />);
    fireEvent.change(nameInput(), { target: { value: "  Grace   H. " } });
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ displayName: "  Grace   H. " });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain(PROFILE_UPDATED_MESSAGE);
    expect(status.closest('[aria-live="polite"]')).not.toBeNull();
    await waitFor(() => expect(nameInput().value).toBe("Grace H."));
  });

  test("validation failure: field error + focused alert summary linking to the field; echo renders as value", async () => {
    const { action } = scriptedAction([
      failure("VALIDATION_FAILED", "Some fields are invalid.", { displayName: "Enter a display name." }, { displayName: HOSTILE }),
    ]);
    render(<ProfileForm action={action} displayName="Ada" email="ada@example.com" />);
    fireEvent.submit(form());
    const summary = await screen.findByTestId("profile-error-summary");
    expect(summary.getAttribute("role")).toBe("alert");
    expect(summary.textContent).toContain(FIX_FIELDS_TITLE);
    expect(summary.textContent).toContain("Display name: Enter a display name.");
    await waitFor(() => expectFocused(summary));
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(nameInput().value).toBe(HOSTILE);
    expect(document.querySelector("form img")).toBeNull();
    const link = summary.querySelector('a[href="#account-display-name"]') as HTMLAnchorElement;
    fireEvent.click(link);
    expectFocused(nameInput());
  });

  test("RATE_LIMITED shows 'Too many attempts. Try again in N minutes.'", async () => {
    const { action } = scriptedAction([
      failure("RATE_LIMITED", "Too many attempts. Try again in 3 minutes.", {}, { displayName: "Ada" }, 150),
    ]);
    render(<ProfileForm action={action} displayName="Ada" email="a@b.c" />);
    fireEvent.submit(form());
    const summary = await screen.findByTestId("profile-error-summary");
    expect(summary.textContent).toBe("Too many attempts. Try again in 3 minutes.");
  });

  test("UNAUTHENTICATED shows the message and a sign-in link back to settings", async () => {
    const { action } = scriptedAction([failure("UNAUTHENTICATED", "Please sign in.")]);
    render(<ProfileForm action={action} displayName="Ada" email="a@b.c" />);
    fireEvent.submit(form());
    const summary = await screen.findByTestId("profile-error-summary");
    expect(summary.textContent).toContain("Please sign in.");
    expect(summary.querySelector("a")?.getAttribute("href")).toBe("/signin?next=%2Faccount%2Fsettings");
  });

  test("INTERNAL_ERROR shows the generic message", async () => {
    const { action } = scriptedAction([failure("INTERNAL_ERROR", "Something went wrong. Please try again.")]);
    render(<ProfileForm action={action} displayName="Ada" email="a@b.c" />);
    fireEvent.submit(form());
    const summary = await screen.findByTestId("profile-error-summary");
    expect(summary.textContent).toContain("Profile not saved");
    expect(summary.textContent).toContain("Something went wrong. Please try again.");
  });

  test("pending: aria-busy form + busy button; double submit sends once", async () => {
    const c = controlledAction();
    render(<ProfileForm action={c.action} displayName="Ada" email="a@b.c" />);
    fireEvent.submit(form());
    fireEvent.submit(form());
    await waitFor(() => expect(submit().getAttribute("aria-busy")).toBe("true"));
    expect(submit().getAttribute("aria-disabled")).toBe("true");
    expect(form().getAttribute("aria-busy")).toBe("true");
    expect(submit().textContent).toContain("Saving");
    fireEvent.submit(form());
    expect(c.calls).toHaveLength(1);
    await act(async () => c.resolve(success("Ada")));
    await waitFor(() => expect(form().hasAttribute("aria-busy")).toBe(false));
    // Guard reopens once settled.
    fireEvent.submit(form());
    await waitFor(() => expect(c.calls).toHaveLength(2));
    // Settle the second action too: an unresolved React 19 action is process-global
    // and would stall every later form test in the same bun process (TEST-MEM).
    await act(async () => c.resolve(success("Ada")));
    await waitFor(() => expect(form().hasAttribute("aria-busy")).toBe(false));
  });
});
