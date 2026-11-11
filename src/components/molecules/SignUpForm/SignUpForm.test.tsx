import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AUTH_MESSAGES } from "@/app/actions/auth-core";
import { PASSWORD_RULES_TEXT, LENGTH_HINT_TEXT } from "../PasswordField";
import {
  HOSTILE_NEXT,
  HOSTILE_TEXT,
  authFailure,
  controlledAction,
  scriptedAction,
  serverLikeAction,
} from "../SignInForm/auth-test-helpers";
import {
  GUEST_MERGE_NOTE,
  SIGN_UP_FIELD_IDS,
  SIGN_UP_PENDING_LABEL,
  SIGN_UP_SUBMIT_LABEL,
  SignUpForm,
} from "./index";
import { expectFocused, expectNotNull } from "@/test/dom-assertions";

const form = () => document.getElementById("signup-form") as HTMLFormElement;
const nameInput = () => document.getElementById(SIGN_UP_FIELD_IDS.displayName) as HTMLInputElement;
const emailInput = () => document.getElementById(SIGN_UP_FIELD_IDS.email) as HTMLInputElement;
const passwordInput = () => document.getElementById(SIGN_UP_FIELD_IDS.password) as HTMLInputElement;
const submitButton = () => form().querySelector('button[type="submit"]') as HTMLButtonElement;
const summary = () => screen.queryByTestId("signup-error-summary");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function fill(name = "Ada", email = "ada@example.com", password = "quiet birch lantern") {
  fireEvent.change(nameInput(), { target: { value: name } });
  fireEvent.change(emailInput(), { target: { value: email } });
  fireEvent.change(passwordInput(), { target: { value: password } });
}

describe("SignUpForm no-JS markup", () => {
  test("plain form: contract names, autocomplete, caps, rules, note, links; no script", () => {
    const html = renderToStaticMarkup(<SignUpForm action={serverLikeAction()} next="/orders" />);
    const doc = parse(html);
    const f = doc.querySelector("form") as HTMLFormElement;
    expect(f.hasAttribute("novalidate")).toBe(true);
    expect(f.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(f.getAttribute("enctype")).toBe("multipart/form-data");
    expect(f.getAttribute("action") ?? "").not.toContain("javascript:");
    const dn = f.querySelector('[name="displayName"]') as HTMLInputElement;
    expect(dn.getAttribute("autocomplete")).toBe("name");
    expect(dn.getAttribute("maxlength")).toBe("50");
    const email = f.querySelector('[name="email"]') as HTMLInputElement;
    expect(email.getAttribute("type")).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("email");
    expect(email.getAttribute("maxlength")).toBe("254");
    const pw = f.querySelector('[name="password"]') as HTMLInputElement;
    expect(pw.getAttribute("type")).toBe("password");
    expect(pw.getAttribute("autocomplete")).toBe("new-password");
    expect(pw.getAttribute("maxlength")).toBe("128");
    expect(pw.getAttribute("minlength")).toBe("8");
    expect(pw.hasAttribute("value")).toBe(false);
    for (const el of [dn, email, pw]) expect(el.hasAttribute("required")).toBe(true);
    const names = [...f.querySelectorAll("[name]")]
      .map((el) => el.getAttribute("name") ?? "")
      .filter((n) => !n.startsWith("$ACTION"));
    expect(names.sort()).toEqual(["displayName", "email", "next", "password"]);
    expect(f.querySelector('[name="next"]')?.getAttribute("value")).toBe("/orders");
    expect(f.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(f.querySelector('button[type="submit"]')?.textContent).toBe(SIGN_UP_SUBMIT_LABEL);
    // Rules visible, length hint region present (empty), merge note, policy links.
    expect(doc.getElementById(`${SIGN_UP_FIELD_IDS.password}-helper`)?.textContent).toBe(PASSWORD_RULES_TEXT);
    expect(doc.getElementById(`${SIGN_UP_FIELD_IDS.password}-length`)?.getAttribute("role")).toBe("status");
    expect(html).toContain(GUEST_MERGE_NOTE);
    expect(GUEST_MERGE_NOTE).toContain("cart");
    expect(GUEST_MERGE_NOTE).toContain("orders");
    const hrefs = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/privacy");
    expect(hrefs).toContain("/terms");
    expect(hrefs).toContain("/signin?next=%2Forders");
    expect(doc.querySelector('a[href^="/signin"]')?.textContent).toBe("Sign in");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("autofocus");
  });

  test.each(HOSTILE_NEXT.map((n) => [JSON.stringify(n), n] as const))("hostile next %s is never rendered", (_l, raw) => {
    const html = renderToStaticMarkup(<SignUpForm action={serverLikeAction()} next={raw} />);
    const doc = parse(html);
    expect(doc.querySelector('[name="next"]')).toBeNull();
    expect(doc.querySelector('a[href^="/signin"]')?.getAttribute("href")).toBe("/signin");
    expect(html).not.toContain("evil");
    expect(html).not.toContain("javascript:");
    for (const a of doc.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      expect(href.startsWith("/") && !href.startsWith("//")).toBe(true);
    }
  });
});

describe("SignUpForm interactions", () => {
  test("posts exactly displayName, email, password and the safe next", async () => {
    const { action, calls } = scriptedAction([authFailure("EMAIL_TAKEN")]);
    render(<SignUpForm action={action} next="/account/settings?x=1" />);
    fill();
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      displayName: "Ada",
      email: "ada@example.com",
      password: "quiet birch lantern",
      next: "/account/settings?x=1",
    });
  });

  test("EMAIL_TAKEN: constant text, sign-in link carrying next, focus, password cleared, values re-filled", async () => {
    const { action, calls } = scriptedAction([
      authFailure("EMAIL_TAKEN", { message: AUTH_MESSAGES.emailTaken, values: { email: "ada@example.com", displayName: "Ada" } }),
    ]);
    render(<SignUpForm action={action} next="/orders" />);
    fill();
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expectNotNull(summary()));
    const s = summary() as HTMLElement;
    expect(s.getAttribute("role")).toBe("alert");
    expect(s.textContent).toContain("An account with this email already exists. Sign in instead.");
    expect(s.querySelector("a")?.getAttribute("href")).toBe("/signin?next=%2Forders");
    await waitFor(() => expectFocused(s));
    expect(passwordInput().value).toBe("");
    expect(emailInput().value).toBe("ada@example.com");
    expect(nameInput().value).toBe("Ada");
  });

  test("TOO_MANY_ATTEMPTS shows the R-10 text", async () => {
    const { action, calls } = scriptedAction([authFailure("TOO_MANY_ATTEMPTS", { retryAfterSeconds: 3600 })]);
    render(<SignUpForm action={action} />);
    fill();
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(summary()?.textContent).toContain("Too many attempts. Try again in 60 minutes."));
  });

  test("VALIDATION_FAILED: links in form order, inline errors, password cleared, length hint reset", async () => {
    const { action, calls } = scriptedAction([
      authFailure("VALIDATION_FAILED", {
        fieldErrors: {
          password: "This password is too easy to guess. Choose a less common one.",
          displayName: "Enter a display name.",
        },
        values: { email: "ada@example.com", displayName: "" },
      }),
    ]);
    render(<SignUpForm action={action} />);
    fill("", "ada@example.com", "password");
    expect(document.getElementById(`${SIGN_UP_FIELD_IDS.password}-length`)?.textContent).toBe(LENGTH_HINT_TEXT.ok);
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expectNotNull(summary()));
    const links = [...(summary() as HTMLElement).querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual([`#${SIGN_UP_FIELD_IDS.displayName}`, `#${SIGN_UP_FIELD_IDS.password}`]);
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(passwordInput().getAttribute("aria-invalid")).toBe("true");
    expect(passwordInput().getAttribute("aria-describedby")?.split(" ")).toEqual([
      `${SIGN_UP_FIELD_IDS.password}-helper`,
      `${SIGN_UP_FIELD_IDS.password}-error`,
    ]);
    expect(passwordInput().value).toBe("");
    expect(document.getElementById(`${SIGN_UP_FIELD_IDS.password}-length`)?.textContent).toBe("");
  });

  test("hostile echoed name/email render inert", async () => {
    const { action, calls } = scriptedAction([
      authFailure("VALIDATION_FAILED", {
        fieldErrors: { email: "Enter a valid email address." },
        values: { email: HOSTILE_TEXT, displayName: HOSTILE_TEXT },
      }),
    ]);
    const { container } = render(<SignUpForm action={action} />);
    fill();
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(nameInput().value).toBe(HOSTILE_TEXT));
    expect(emailInput().value).toBe(HOSTILE_TEXT);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  test("pending: 'Creating account…', aria-busy; double submit sends once; guard released on settle", async () => {
    const { action, calls, resolve } = controlledAction();
    render(<SignUpForm action={action} />);
    fill();
    fireEvent.submit(form());
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(submitButton().textContent).toContain(SIGN_UP_PENDING_LABEL));
    expect(submitButton().getAttribute("aria-busy")).toBe("true");
    fireEvent.click(submitButton());
    expect(calls).toHaveLength(1);
    await act(async () => resolve(authFailure("EMAIL_TAKEN")));
    fill();
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => resolve(authFailure("EMAIL_TAKEN")));
    await waitFor(() => expect(submitButton().textContent).toBe(SIGN_UP_SUBMIT_LABEL));
  });

  test("exactly one primary button; no autofocus; every control named; 320px-safe classes", () => {
    const { container } = render(<SignUpForm action={scriptedAction([]).action} />);
    const primary = [...container.querySelectorAll("button, a")].filter((el) =>
      (el.getAttribute("class") ?? "").split(/\s+/).includes("bg-accent"),
    );
    expect(primary).toHaveLength(1);
    expect(container.querySelector("[autofocus]")).toBeNull();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
    for (const control of container.querySelectorAll("input:not([type=hidden]), button")) {
      expect(control).toHaveAccessibleName();
    }
    const tokens = [...container.querySelectorAll("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    const fixedWidths = tokens.filter((t) => /^(w|min-w)-(\d+|screen|\[.*\])$/.test(t) && t !== "min-w-0");
    expect(fixedWidths).toEqual([]);
  });
});
