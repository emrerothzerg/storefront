import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// T129a QA: accounts UI molecules (T123 PasswordField, T124 SignInForm /
// SignUpForm, T125 + FIX-T125-nojs AccountSettingsForms).
//
// No `mock.module` in this file: every action is a local fake (scripted,
// controlled, or the `$$FORM_ACTION` server-like fixture), so nothing here
// reaches next/* or the database. Page-level and real-action checks live in
// tests/accounts/pages-auth.qa.test.tsx.
//
// Criteria (T129a brief): 1 no-JS shape, 2 open redirect (molecule half),
// 3 R-10 uniform responses in the UI, 4 hostile display name/email,
// 5 secrets never in markup/logs (molecule half), 7 interaction states.
// ---------------------------------------------------------------------------

import { PasswordField, SHOW_PASSWORD_LABEL, HIDE_PASSWORD_LABEL } from "@/components/molecules/PasswordField";
import { SignInForm, SIGN_IN_FIELD_IDS, SIGN_IN_PENDING_LABEL } from "@/components/molecules/SignInForm";
import { SignUpForm, SIGN_UP_FIELD_IDS, SIGN_UP_PENDING_LABEL } from "@/components/molecules/SignUpForm";
import {
  ACCOUNT_FIELD_IDS,
  ChangePasswordForm,
  DeleteAccountForm,
  PASSWORD_CHANGED_MESSAGE,
  PROFILE_UPDATED_MESSAGE,
  ProfileForm,
  SETTINGS_SIGN_IN_HREF,
} from "@/components/molecules/AccountSettingsForms";
import { AUTH_FORM_MESSAGES, toSafeNext } from "@/components/molecules/SignInForm/auth-form-helpers";
import {
  authFailure,
  controlledAction as authControlled,
  scriptedAction as authScripted,
  serverLikeAction as authServerLike,
} from "@/components/molecules/SignInForm/auth-test-helpers";
import {
  controlledAction as accountControlled,
  failure as accountFailure,
  scriptedAction as accountScripted,
  serverLikeAction as accountServerLike,
} from "@/components/molecules/AccountSettingsForms/_test-utils";
import type { AccountActionState } from "@/components/molecules/_contracts/account-actions";
import type { AuthActionState } from "@/components/molecules/_contracts/auth-actions";
import { isAllowedInternalHref } from "@/content/routes";
import { safeNext } from "@/server/session/safe-next";
import { consoleCapture, SecretRegistry } from "./_fixtures";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const HOSTILE_NAME = '<img src=x onerror="alert(1)">';
const RTL_50 = "אבגדה".repeat(10); // 50 Hebrew letters
const BIDI = "Eve‮live‬⁦x⁩"; // RLO + PDF + LRI/PDI
const MEGA = "N".repeat(1024 * 1024); // 1 MB display name
const PW_A = "Qa-Sentinel-Pw-Alpha!";
const PW_B = "Qa-Sentinel-Pw-Bravo!";
const PW_C = "Qa-Sentinel-Pw-Charlie!";

const secrets = new SecretRegistry();
secrets.add(PW_A, PW_B, PW_C);
const capture = consoleCapture();
const setItemSpy = spyOn(Storage.prototype, "setItem");

afterAll(() => {
  capture.restore();
  setItemSpy.mockRestore();
});

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * Short string for a DOM node (or null). Assertions compare these instead of
 * the nodes: a FAILING `expect(node)` makes bun serialise the whole happy-dom
 * object graph (window, document) — multi-GB in a shared process (TEST-MEM).
 */
function tagOf(node: Element | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  const testId = node.getAttribute("data-testid");
  return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${testId ? `[data-testid=${testId}]` : ""} ${node.outerHTML.slice(0, 120)}`;
}

/** Focus check as strings (see tagOf). */
function expectFocused(node: Element | null | undefined): void {
  expect(tagOf(document.activeElement)).toBe(tagOf(node));
}

function ssr(el: ReactElement): { html: string; doc: Document } {
  const html = renderToStaticMarkup(el);
  return { html, doc: parse(html) };
}

/** Every attribute as `name=value`, one per line (DOM subtree). */
function attributes(root: Element): string[] {
  const out: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attr of Array.from(el.attributes)) out.push(`${attr.name}=${attr.value}`);
  }
  return out;
}

/** Attribute names (other than `value`) whose value contains `needle`. */
function attrsContaining(root: Element, needle: string): string[] {
  return attributes(root).filter((a) => !a.startsWith("value=") && a.slice(a.indexOf("=") + 1).includes(needle));
}

const ACTION_FIELD = /^\$ACTION/;
/** Explicit bound for every waitFor/findBy (fail fast, never poll for long). */
const WAIT = { timeout: 2_000 } as const;

interface FormSpec {
  readonly name: string;
  readonly render: () => ReactElement;
  /** Contract field name -> expected autocomplete. */
  readonly fields: Readonly<Record<string, string | readonly string[]>>;
  readonly hidden?: readonly string[];
}

const NOJS_FORMS: readonly FormSpec[] = [
  {
    name: "SignInForm",
    render: () => <SignInForm action={authServerLike()} next="/orders" />,
    fields: { email: ["email", "username"], password: "current-password" },
    hidden: ["next"],
  },
  {
    name: "SignUpForm",
    render: () => <SignUpForm action={authServerLike()} next="/orders" />,
    fields: { displayName: ["name", "nickname"], email: ["email", "username"], password: "new-password" },
    hidden: ["next"],
  },
  {
    name: "ProfileForm",
    render: () => <ProfileForm action={accountServerLike()} displayName="Quinn Ruby" email="quinn@example.test" />,
    fields: { displayName: ["name", "nickname"] },
  },
  {
    name: "ChangePasswordForm",
    render: () => <ChangePasswordForm action={accountServerLike()} />,
    fields: { currentPassword: "current-password", newPassword: "new-password", confirmPassword: "new-password" },
  },
  {
    name: "DeleteAccountForm",
    render: () => <DeleteAccountForm action={accountServerLike()} />,
    fields: { password: "current-password", confirm: "off" },
  },
];

function labelText(doc: Document, input: Element): string {
  const id = input.getAttribute("id");
  const byFor = id ? doc.querySelector(`label[for="${id}"]`) : null;
  if (byFor) return byFor.textContent ?? "";
  const wrapping = input.closest("label");
  if (wrapping) return wrapping.textContent ?? "";
  const labelledBy = input.getAttribute("aria-labelledby");
  if (labelledBy) return labelledBy.split(/\s+/).map((ref) => doc.getElementById(ref)?.textContent ?? "").join(" ");
  return "";
}

/** Every IDREF used by for / aria-* attributes resolves to exactly one element. */
function danglingRefs(root: Document | Element): string[] {
  const scope: Document = root.nodeType === 9 ? (root as Document) : (root as Element).ownerDocument;
  const out: string[] = [];
  const els = root.querySelectorAll("[for], [aria-describedby], [aria-labelledby], [aria-controls], [aria-errormessage]");
  for (const el of Array.from(els)) {
    for (const attr of ["for", "aria-describedby", "aria-labelledby", "aria-controls", "aria-errormessage"]) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      for (const ref of value.split(/\s+/).filter(Boolean)) {
        if (scope.querySelectorAll(`[id="${ref}"]`).length !== 1) out.push(`${attr}->${ref}`);
      }
    }
  }
  return out;
}

function duplicateIds(root: Document | Element): string[] {
  const seen = new Map<string, number>();
  for (const el of Array.from(root.querySelectorAll("[id]"))) {
    const id = el.getAttribute("id") ?? "";
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Criterion 1: no-JS shape for every molecule form
// ---------------------------------------------------------------------------

describe("criterion 1: no-JS shape (server-like action, $$FORM_ACTION fixture)", () => {
  for (const spec of NOJS_FORMS) {
    test(`${spec.name}: POST multipart, contract names only, labels, autocomplete, submit enabled, no pre-filled password`, () => {
      const { html, doc } = ssr(spec.render());
      const forms = doc.querySelectorAll("form");
      expect(forms).toHaveLength(1);
      const f = forms[0] as HTMLFormElement;
      expect(f.getAttribute("method")?.toLowerCase()).toBe("post");
      expect(f.getAttribute("enctype")).toBe("multipart/form-data");
      expect(html).not.toContain("javascript:");
      expect(tagOf(f.querySelector("form"))).toBeNull();

      const named = Array.from(f.querySelectorAll("[name]")).filter((el) => !ACTION_FIELD.test(el.getAttribute("name") ?? ""));
      const names = named.map((el) => el.getAttribute("name") ?? "");
      expect([...names].sort()).toEqual([...Object.keys(spec.fields), ...(spec.hidden ?? [])].sort());

      // Hidden inputs: only `next` (+ React's $ACTION_* plumbing). No identity fields.
      for (const hidden of Array.from(f.querySelectorAll('input[type="hidden"]'))) {
        const name = hidden.getAttribute("name") ?? "";
        expect(ACTION_FIELD.test(name) || name === "next").toBe(true);
      }
      for (const banned of ["userId", "ownerKey", "sessionId", "token", "role", "verified"]) {
        expect(tagOf(f.querySelector(`[name="${banned}"]`))).toBeNull();
      }
      // `email` only as a typed field where the contract requires it (sign-in / sign-up).
      const emailInputs = Array.from(f.querySelectorAll('[name="email"]'));
      for (const e of emailInputs) expect(e.getAttribute("type")).toBe("email");

      for (const [field, ac] of Object.entries(spec.fields)) {
        const input = f.querySelector(`[name="${field}"]`) as HTMLInputElement;
        const allowed = typeof ac === "string" ? [ac] : ac;
        expect([field, allowed.includes(input.getAttribute("autocomplete") ?? "")]).toEqual([field, true]);
        expect([field, labelText(doc, input).trim().length > 0]).toEqual([field, true]);
        if (input.getAttribute("type") === "password") {
          expect(input.hasAttribute("value")).toBe(false);
          expect(input.getAttribute("maxlength")).toBe("128");
        }
      }

      const submits = f.querySelectorAll('button[type="submit"], input[type="submit"]');
      expect(submits).toHaveLength(1);
      expect(submits[0]?.hasAttribute("disabled")).toBe(false);
      expect(submits[0]?.getAttribute("aria-disabled")).not.toBe("true");
      // Pre-hydration the password toggles never submit and never block (type=button).
      for (const btn of Array.from(f.querySelectorAll("button:not([type])"))) expect(tagOf(btn)).toBeNull();
      expect(danglingRefs(doc)).toEqual([]);
      expect(duplicateIds(doc)).toEqual([]);
      expect(html).not.toContain("autofocus");
      expect(html).not.toContain("<script");
    });
  }

  test("PasswordField alone in a server-like form: plain type=password input that submits (toggle inert, type=button)", () => {
    const action = accountServerLike();
    const { doc } = ssr(
      <form action={action.bind(null, null) as unknown as (fd: FormData) => void}>
        <PasswordField name="password" label="Password" autoComplete="current-password" />
      </form>,
    );
    const input = doc.querySelector('input[name="password"]') as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("password");
    expect(input.hasAttribute("value")).toBe(false);
    expect(input.hasAttribute("disabled")).toBe(false);
    const toggle = doc.querySelector("button") as HTMLButtonElement;
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("aria-label")).toBe(SHOW_PASSWORD_LABEL);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 (molecule half): hostile `next` handed straight to the forms
// ---------------------------------------------------------------------------

const HOSTILE_NEXT: readonly unknown[] = [
  "//evil.com",
  "https://evil.com",
  "http:/evil.com",
  "///evil.com",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,x",
  "/\\evil.com",
  "\\\\evil.com",
  "/%5Cevil.com",
  "%2F%2Fevil.com",
  "/%2F/evil.com",
  "/%2f%2fevil.com",
  "/\t/evil.com",
  "/\n/evil.com",
  "/orders\u0000",
  "/orders%00",
  "/orders%0d%0aSet-Cookie",
  " //evil.com",
  "evil.com",
  "",
  `/${"a".repeat(2047)}`,
  "/café",
  ["/orders", "/cart"],
  ["//evil.com"],
  42,
  null,
];

const SAFE_NEXT: readonly [string, string][] = [
  ["/orders", "%2Forders"],
  ["/orders?page=2", "%2Forders%3Fpage%3D2"],
  ["/account/settings", "%2Faccount%2Fsettings"],
  ["/products/canvas-tote-bag#reviews", "%2Fproducts%2Fcanvas-tote-bag%23reviews"],
];

describe("criterion 2: hostile next on SignInForm / SignUpForm (molecule)", () => {
  test("toSafeNext mirrors the server safeNext for every hostile and safe value", () => {
    for (const raw of [...HOSTILE_NEXT, ...SAFE_NEXT.map(([v]) => v)]) {
      const server = safeNext(raw, "");
      expect([raw, toSafeNext(raw)]).toEqual([raw, server === "" ? null : server]);
    }
  });

  for (const [label, render] of [
    ["SignInForm", (next: unknown) => <SignInForm action={authServerLike()} next={next as string} />],
    ["SignUpForm", (next: unknown) => <SignUpForm action={authServerLike()} next={next as string} />],
  ] as const) {
    test(`${label}: every hostile next is dropped (no hidden next, plain cross-link, no evil/javascript anywhere)`, () => {
      for (const raw of HOSTILE_NEXT) {
        const { html, doc } = ssr(render(raw));
        expect([raw, tagOf(doc.querySelector('input[name="next"]'))]).toEqual([raw, null]);
        const hrefs = Array.from(doc.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
        for (const href of hrefs) {
          expect([raw, href, isAllowedInternalHref(href)]).toEqual([raw, href, true]);
          expect(href.includes("next=")).toBe(false);
        }
        expect(html.toLowerCase()).not.toContain("evil");
        expect(html.toLowerCase()).not.toContain("javascript:");
        expect(html.toLowerCase()).not.toContain("data:text");
      }
    });

    test(`${label}: safe next is kept in the hidden input and percent-encoded in the cross-link`, () => {
      for (const [raw, encoded] of SAFE_NEXT) {
        const { doc } = ssr(render(raw));
        expect(doc.querySelector('input[name="next"]')?.getAttribute("value")).toBe(raw);
        const cross = label === "SignInForm" ? "/signup" : "/signin";
        const link = Array.from(doc.querySelectorAll("a[href]"))
          .map((a) => a.getAttribute("href") ?? "")
          .find((h) => h.startsWith(cross));
        expect(link).toBe(`${cross}?next=${encoded}`);
        expect(decodeURIComponent(new URL(link ?? "", "http://x.test").searchParams.get("next") ?? "")).toBe(raw);
        expect(isAllowedInternalHref(link ?? "")).toBe(true);
      }
    });
  }

  test("the settings sign-in link carries next=%2Faccount%2Fsettings and is allow-listed", () => {
    expect(SETTINGS_SIGN_IN_HREF).toBe("/signin?next=%2Faccount%2Fsettings");
    expect(isAllowedInternalHref(SETTINGS_SIGN_IN_HREF)).toBe(true);
    expect(new URL(SETTINGS_SIGN_IN_HREF, "http://x.test").searchParams.get("next")).toBe("/account/settings");
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: R-10 uniform responses in the UI (scripted states)
// ---------------------------------------------------------------------------

function signInEls() {
  return {
    form: document.getElementById("signin-form") as HTMLFormElement,
    email: document.getElementById(SIGN_IN_FIELD_IDS.email) as HTMLInputElement,
    password: document.getElementById(SIGN_IN_FIELD_IDS.password) as HTMLInputElement,
  };
}

async function failSignInWith(state: AuthActionState, email = "kate@example.test"): Promise<string> {
  const { action, calls } = authScripted([state]);
  const view = render(<SignInForm action={action} />);
  const els = signInEls();
  fireEvent.change(els.email, { target: { value: email } });
  fireEvent.change(els.password, { target: { value: PW_A } });
  fireEvent.submit(els.form);
  await waitFor(() => expect(screen.getByTestId("signin-error-summary")).toBeInTheDocument(), WAIT);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.password).toBe(PW_A);
  const after = signInEls();
  expect(after.password.value).toBe("");
  expect(after.email.value).toBe(email);
  await waitFor(() => expectFocused(screen.getByTestId("signin-error-summary")), WAIT);
  const html = (document.getElementById("signin-form") as HTMLFormElement).outerHTML;
  view.unmount();
  return html;
}

describe("criterion 3: R-10 uniform responses (SignInForm / SignUpForm)", () => {
  test("wrong password and unknown email (same INVALID_CREDENTIALS state) render byte-identical markup", async () => {
    const st = (): AuthActionState =>
      authFailure("INVALID_CREDENTIALS", { message: AUTH_FORM_MESSAGES.invalidCredentials, values: { email: "kate@example.test" } });
    const wrong = await failSignInWith(st());
    const unknown = await failSignInWith(st());
    expect(wrong).toBe(unknown);
    expect(wrong).toContain(AUTH_FORM_MESSAGES.invalidCredentials);
    expect(wrong).not.toContain(PW_A);
  }, 30_000);

  test("locked (ACCOUNT_LOCKED) and rate-limited (RATE_LIMITED) render identical markup; server message is never shown", async () => {
    const locked = await failSignInWith(
      authFailure("TOO_MANY_ATTEMPTS", {
        errorCode: "ACCOUNT_LOCKED",
        message: "Account locked: kate@example.test has 10 failures",
        values: { email: "kate@example.test" },
        retryAfterSeconds: 900,
      }),
    );
    const limited = await failSignInWith(
      authFailure("TOO_MANY_ATTEMPTS", {
        errorCode: "RATE_LIMITED",
        message: "rate limit bucket auth.signin.email",
        values: { email: "kate@example.test" },
        retryAfterSeconds: 900,
      }),
    );
    expect(locked).toBe(limited);
    expect(locked).toContain("Too many attempts. Try again in 15 minutes.");
    expect(locked).not.toContain("locked");
    expect(locked).not.toContain("bucket");
  }, 30_000);

  test("retryAfterSeconds that round to the same minute render identical markup (no seconds leak)", async () => {
    const mk = (s: number): AuthActionState =>
      authFailure("TOO_MANY_ATTEMPTS", { values: { email: "kate@example.test" }, retryAfterSeconds: s });
    const a = await failSignInWith(mk(841));
    const b = await failSignInWith(mk(899));
    expect(a).toBe(b);
    expect(a).not.toMatch(/\b8(41|99)\b/);
  }, 30_000);

  test("sign-up EMAIL_TAKEN (AR2: the one place existence may show) clears the password, re-fills name/email, focuses the summary, offers sign-in", async () => {
    const { action } = authScripted([
      authFailure("EMAIL_TAKEN", {
        message: AUTH_FORM_MESSAGES.emailTaken,
        values: { email: "taken@example.test", displayName: "Taken Person" },
      }),
    ]);
    render(<SignUpForm action={action} next="/orders" />);
    fireEvent.change(document.getElementById(SIGN_UP_FIELD_IDS.displayName) as HTMLInputElement, { target: { value: "Taken Person" } });
    fireEvent.change(document.getElementById(SIGN_UP_FIELD_IDS.email) as HTMLInputElement, { target: { value: "taken@example.test" } });
    fireEvent.change(document.getElementById(SIGN_UP_FIELD_IDS.password) as HTMLInputElement, { target: { value: PW_B } });
    fireEvent.submit(document.getElementById("signup-form") as HTMLFormElement);
    const summary = await screen.findByTestId("signup-error-summary", undefined, WAIT);
    await waitFor(() => expectFocused(summary), WAIT);
    expect(summary).toHaveAttribute("role", "alert");
    expect(summary).toHaveTextContent(AUTH_FORM_MESSAGES.emailTaken);
    expect(within(summary).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin?next=%2Forders");
    expect((document.getElementById(SIGN_UP_FIELD_IDS.password) as HTMLInputElement).value).toBe("");
    expect((document.getElementById(SIGN_UP_FIELD_IDS.email) as HTMLInputElement).value).toBe("taken@example.test");
    expect((document.getElementById(SIGN_UP_FIELD_IDS.displayName) as HTMLInputElement).value).toBe("Taken Person");
    expect(document.body.innerHTML).not.toContain(PW_B);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Criterion 4: hostile display name and email
// ---------------------------------------------------------------------------

const HOSTILE_VALUES: readonly [string, string][] = [
  ["img onerror", HOSTILE_NAME],
  ["50 RTL chars", RTL_50],
  ["bidi overrides", BIDI],
  ["quote breakout", '" autofocus onfocus="alert(1)'],
];

describe("criterion 4: hostile display name / email are escaped, only ever in value", () => {
  for (const [label, value] of HOSTILE_VALUES) {
    test(`SignUpForm echo (${label}): text only, no element injected, never outside value`, async () => {
      const { action } = authScripted([
        authFailure("VALIDATION_FAILED", {
          message: AUTH_FORM_MESSAGES.invalid,
          fieldErrors: { email: "Enter a valid email address." },
          values: { displayName: value, email: `${value}@example.test` },
        }),
      ]);
      const { container } = render(<SignUpForm action={action} />);
      fireEvent.submit(document.getElementById("signup-form") as HTMLFormElement);
      await screen.findByTestId("signup-error-summary", undefined, WAIT);
      expect(tagOf(container.querySelector("img"))).toBeNull();
      expect(tagOf(container.querySelector("[onerror], [onfocus], [autofocus]"))).toBeNull();
      expect((document.getElementById(SIGN_UP_FIELD_IDS.displayName) as HTMLInputElement).value).toBe(value);
      expect(attrsContaining(container, value)).toEqual([]);
    }, 30_000);

    test(`ProfileForm (${label}): name only in the input value, email as a text node`, () => {
      const email = `${value.replace(/\s/g, "")}@example.test`;
      const { doc } = ssr(<ProfileForm action={accountServerLike()} displayName={value} email={email} />);
      const f = doc.querySelector("form") as HTMLFormElement;
      expect(tagOf(f.querySelector("img"))).toBeNull();
      expect(tagOf(f.querySelector("[onerror], [onfocus], [autofocus]"))).toBeNull();
      expect(f.querySelector('input[name="displayName"]')?.getAttribute("value")).toBe(value);
      expect(f.querySelector('[data-testid="profile-email"]')?.textContent).toBe(email);
      expect(attrsContaining(f, value)).toEqual([]);
      expect(attrsContaining(f, email)).toEqual([]);
    });
  }

  test("1 MB display name in an echo/stored value renders without throwing and stays inside value (maxlength 50 on the input)", async () => {
    const { doc } = ssr(<ProfileForm action={accountServerLike()} displayName={MEGA} email="mega@example.test" />);
    const input = doc.querySelector('input[name="displayName"]') as HTMLInputElement;
    expect(input.getAttribute("maxlength")).toBe("50");
    expect(input.getAttribute("value")?.length).toBe(MEGA.length);
    const { action } = authScripted([
      authFailure("VALIDATION_FAILED", { fieldErrors: { displayName: "Too long." }, values: { displayName: MEGA } }),
    ]);
    render(<SignUpForm action={action} />);
    fireEvent.submit(document.getElementById("signup-form") as HTMLFormElement);
    await screen.findByTestId("signup-error-summary", undefined, WAIT);
    const name = document.getElementById(SIGN_UP_FIELD_IDS.displayName) as HTMLInputElement;
    expect(name.getAttribute("maxlength")).toBe("50");
  }, 30_000);

  test("hostile field-error messages from the server render as text in the summary and under the field", async () => {
    const { action } = accountScripted([
      accountFailure("VALIDATION_FAILED", "x", { displayName: HOSTILE_NAME }, { displayName: HOSTILE_NAME }),
    ]);
    const { container } = render(<ProfileForm action={action} displayName="Quinn" email="quinn@example.test" />);
    fireEvent.submit(document.getElementById("account-profile-form") as HTMLFormElement);
    await screen.findByTestId("profile-error-summary", undefined, WAIT);
    expect(tagOf(container.querySelector("img"))).toBeNull();
    expect(container.textContent).toContain(HOSTILE_NAME);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Criterion 5 (molecule half): passwords never leave the live input value
// ---------------------------------------------------------------------------

describe("criterion 5: passwords never in attributes, storage, posted state echoes or console", () => {
  test("typed passwords in all five forms never appear in any attribute or storage; posted only under contract names", async () => {
    const signIn = authControlled();
    const signUp = authControlled();
    const change = accountControlled();
    const del = accountControlled();
    const { container } = render(
      <>
        <SignInForm action={signIn.action} />
        <SignUpForm action={signUp.action} />
        <ChangePasswordForm action={change.action} />
        <DeleteAccountForm action={del.action} />
      </>,
    );
    fireEvent.change(document.getElementById(SIGN_IN_FIELD_IDS.password) as HTMLInputElement, { target: { value: PW_A } });
    fireEvent.change(document.getElementById(SIGN_UP_FIELD_IDS.password) as HTMLInputElement, { target: { value: PW_B } });
    fireEvent.change(document.getElementById(ACCOUNT_FIELD_IDS.currentPassword) as HTMLInputElement, { target: { value: PW_A } });
    fireEvent.change(document.getElementById(ACCOUNT_FIELD_IDS.newPassword) as HTMLInputElement, { target: { value: PW_B } });
    fireEvent.change(document.getElementById(ACCOUNT_FIELD_IDS.confirmPassword) as HTMLInputElement, { target: { value: PW_C } });
    fireEvent.change(document.getElementById(ACCOUNT_FIELD_IDS.password) as HTMLInputElement, { target: { value: PW_C } });
    // Show then hide every toggle: still never an attribute.
    for (const t of screen.getAllByRole("button", { name: SHOW_PASSWORD_LABEL })) fireEvent.click(t);
    const dump = attributes(container).join("\n");
    for (const pw of [PW_A, PW_B, PW_C]) expect(dump).not.toContain(pw);
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    for (const t of screen.getAllByRole("button", { name: HIDE_PASSWORD_LABEL })) fireEvent.click(t);

    fireEvent.submit(document.getElementById("account-password-form") as HTMLFormElement);
    await waitFor(() => expect(change.calls).toHaveLength(1), WAIT);
    expect(Object.keys(change.calls[0] ?? {}).filter((k) => !ACTION_FIELD.test(k)).sort()).toEqual([
      "confirmPassword",
      "currentPassword",
      "newPassword",
    ]);
    await act(async () => change.resolve(accountFailure("VALIDATION_FAILED", "x", { confirmPassword: "Passwords do not match." })));
    for (const id of [ACCOUNT_FIELD_IDS.currentPassword, ACCOUNT_FIELD_IDS.newPassword, ACCOUNT_FIELD_IDS.confirmPassword]) {
      expect((document.getElementById(id) as HTMLInputElement).value).toBe("");
    }
    expect(container.innerHTML).not.toContain(PW_A);
    expect(container.innerHTML).not.toContain(PW_B);
  }, 30_000);

  test("console stayed free of every password used in this file (checked after all tests above)", () => {
    const joined = capture.lines.join("\n");
    expect(secrets.find(joined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 7: interaction states, a11y wiring, 320px, ids
// ---------------------------------------------------------------------------

interface InteractiveSpec {
  readonly name: string;
  readonly formId: string;
  readonly mount: (action: unknown) => ReactElement;
  readonly fill: () => void;
  readonly pendingLabel: RegExp;
  readonly kind: "auth" | "account";
  readonly submitViaDialog?: boolean;
}

function typeInto(id: string, value: string): void {
  fireEvent.change(document.getElementById(id) as HTMLInputElement, { target: { value } });
}

const INTERACTIVE: readonly InteractiveSpec[] = [
  {
    name: "SignInForm",
    formId: "signin-form",
    kind: "auth",
    mount: (a) => <SignInForm action={a as Parameters<typeof SignInForm>[0]["action"]} />,
    fill: () => {
      typeInto(SIGN_IN_FIELD_IDS.email, "kate@example.test");
      typeInto(SIGN_IN_FIELD_IDS.password, PW_A);
    },
    pendingLabel: new RegExp(SIGN_IN_PENDING_LABEL),
  },
  {
    name: "SignUpForm",
    formId: "signup-form",
    kind: "auth",
    mount: (a) => <SignUpForm action={a as Parameters<typeof SignUpForm>[0]["action"]} />,
    fill: () => {
      typeInto(SIGN_UP_FIELD_IDS.displayName, "Kate");
      typeInto(SIGN_UP_FIELD_IDS.email, "kate@example.test");
      typeInto(SIGN_UP_FIELD_IDS.password, PW_B);
    },
    pendingLabel: new RegExp(SIGN_UP_PENDING_LABEL),
  },
  {
    name: "ProfileForm",
    formId: "account-profile-form",
    kind: "account",
    mount: (a) => <ProfileForm action={a as Parameters<typeof ProfileForm>[0]["action"]} displayName="Quinn" email="quinn@example.test" />,
    fill: () => typeInto(ACCOUNT_FIELD_IDS.displayName, "Quinn Two"),
    pendingLabel: /Saving/,
  },
  {
    name: "ChangePasswordForm",
    formId: "account-password-form",
    kind: "account",
    mount: (a) => <ChangePasswordForm action={a as Parameters<typeof ChangePasswordForm>[0]["action"]} />,
    fill: () => {
      typeInto(ACCOUNT_FIELD_IDS.currentPassword, PW_A);
      typeInto(ACCOUNT_FIELD_IDS.newPassword, PW_B);
      typeInto(ACCOUNT_FIELD_IDS.confirmPassword, PW_B);
    },
    pendingLabel: /Changing password/,
  },
  {
    name: "DeleteAccountForm",
    formId: "account-delete-form",
    kind: "account",
    submitViaDialog: true,
    mount: (a) => <DeleteAccountForm action={a as Parameters<typeof DeleteAccountForm>[0]["action"]} />,
    fill: () => {
      typeInto(ACCOUNT_FIELD_IDS.password, PW_C);
      typeInto(ACCOUNT_FIELD_IDS.confirm, "DELETE");
    },
    pendingLabel: /Deleting account/,
  },
];

async function startSubmit(spec: InteractiveSpec): Promise<void> {
  const formEl = document.getElementById(spec.formId) as HTMLFormElement;
  fireEvent.submit(formEl);
  if (spec.submitViaDialog) {
    const dialog = await screen.findByRole("alertdialog", { hidden: true }, WAIT);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete", hidden: true }));
  }
}

describe("criterion 7: pending state, double submit, focus, field errors", () => {
  for (const spec of INTERACTIVE) {
    test(`${spec.name}: pending -> aria-busy + pending label; 2nd submit and click swallowed; settles cleanly`, async () => {
      const ctl = spec.kind === "auth" ? authControlled() : accountControlled();
      render(spec.mount(ctl.action));
      spec.fill();
      await startSubmit(spec);
      await waitFor(() => expect(ctl.calls).toHaveLength(1), WAIT);
      const formEl = document.getElementById(spec.formId) as HTMLFormElement;
      const submit = formEl.querySelector('button[type="submit"]') as HTMLButtonElement;
      await waitFor(() => expect(submit).toHaveAttribute("aria-busy", "true"), WAIT);
      expect(submit.textContent ?? "").toMatch(spec.pendingLabel);
      fireEvent.submit(formEl);
      fireEvent.click(submit);
      fireEvent.submit(formEl);
      await act(async () => {
        await Promise.resolve();
      });
      expect(ctl.calls).toHaveLength(1);
      await act(async () => {
        if (spec.kind === "auth") (ctl as ReturnType<typeof authControlled>).resolve(authFailure("INTERNAL_ERROR"));
        else (ctl as ReturnType<typeof accountControlled>).resolve(accountFailure("INTERNAL_ERROR", "Something went wrong. Please try again."));
      });
      await waitFor(() => expect(submit).not.toHaveAttribute("aria-busy"), WAIT);
    }, 30_000);
  }

  const FIELD_ERRORS: readonly { name: string; mount: (s: unknown) => ReactElement; formId: string; summaryId: string; errors: Record<string, string> }[] = [
    {
      name: "SignInForm",
      formId: "signin-form",
      summaryId: "signin-error-summary",
      mount: (a) => <SignInForm action={a as Parameters<typeof SignInForm>[0]["action"]} />,
      errors: { [SIGN_IN_FIELD_IDS.email]: "Enter a valid email address.", [SIGN_IN_FIELD_IDS.password]: "Enter your password." },
    },
    {
      name: "SignUpForm",
      formId: "signup-form",
      summaryId: "signup-error-summary",
      mount: (a) => <SignUpForm action={a as Parameters<typeof SignUpForm>[0]["action"]} />,
      errors: {
        [SIGN_UP_FIELD_IDS.displayName]: "Enter a display name.",
        [SIGN_UP_FIELD_IDS.email]: "Enter a valid email address.",
        [SIGN_UP_FIELD_IDS.password]: "Use at least 8 characters.",
      },
    },
    {
      name: "ProfileForm",
      formId: "account-profile-form",
      summaryId: "profile-error-summary",
      mount: (a) => <ProfileForm action={a as Parameters<typeof ProfileForm>[0]["action"]} displayName="Q" email="q@example.test" />,
      errors: { [ACCOUNT_FIELD_IDS.displayName]: "Enter a display name." },
    },
    {
      name: "ChangePasswordForm",
      formId: "account-password-form",
      summaryId: "password-error-summary",
      mount: (a) => <ChangePasswordForm action={a as Parameters<typeof ChangePasswordForm>[0]["action"]} />,
      errors: {
        [ACCOUNT_FIELD_IDS.currentPassword]: "Current password is incorrect.",
        [ACCOUNT_FIELD_IDS.newPassword]: "Choose a less common password.",
        [ACCOUNT_FIELD_IDS.confirmPassword]: "Passwords do not match.",
      },
    },
  ];

  const ID_TO_FIELD: Record<string, string> = {
    [SIGN_IN_FIELD_IDS.email]: "email",
    [SIGN_IN_FIELD_IDS.password]: "password",
    [SIGN_UP_FIELD_IDS.displayName]: "displayName",
    [SIGN_UP_FIELD_IDS.email]: "email",
    [SIGN_UP_FIELD_IDS.password]: "password",
    [ACCOUNT_FIELD_IDS.displayName]: "displayName",
    [ACCOUNT_FIELD_IDS.currentPassword]: "currentPassword",
    [ACCOUNT_FIELD_IDS.newPassword]: "newPassword",
    [ACCOUNT_FIELD_IDS.confirmPassword]: "confirmPassword",
  };

  for (const spec of FIELD_ERRORS) {
    test(`${spec.name}: every field error -> aria-invalid + aria-describedby to the message; summary focused with in-page links`, async () => {
      const fieldErrors = Object.fromEntries(Object.entries(spec.errors).map(([id, msg]) => [ID_TO_FIELD[id], msg]));
      const isAuth = spec.formId.startsWith("sign");
      const state: unknown = isAuth
        ? authFailure("VALIDATION_FAILED", { message: AUTH_FORM_MESSAGES.invalid, fieldErrors })
        : accountFailure("VALIDATION_FAILED", "Some fields are invalid.", fieldErrors);
      const { action } = isAuth ? authScripted([state as AuthActionState]) : accountScripted([state as AccountActionState]);
      render(spec.mount(action));
      fireEvent.submit(document.getElementById(spec.formId) as HTMLFormElement);
      const summary = await screen.findByTestId(spec.summaryId, undefined, WAIT);
      await waitFor(() => expectFocused(summary), WAIT);
      expect(summary).toHaveAttribute("role", "alert");
      expect(summary).toHaveAttribute("tabindex", "-1");
      for (const [id, message] of Object.entries(spec.errors)) {
        const input = document.getElementById(id) as HTMLInputElement;
        expect([id, input.getAttribute("aria-invalid")]).toEqual([id, "true"]);
        const described = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
        const texts = described.map((ref) => document.getElementById(ref)?.textContent ?? "");
        expect([id, texts.some((t) => t.includes(message))]).toEqual([id, true]);
        const link = within(summary).getByRole("link", { name: new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
        expect(link.getAttribute("href")).toBe(`#${id}`);
        fireEvent.click(link);
        expectFocused(input);
      }
      expect(danglingRefs(document)).toEqual([]);
    }, 30_000);
  }

  test("DeleteAccountForm: wrong password -> field error linked, both fields cleared, confirm gate re-armed", async () => {
    const { action } = accountScripted([
      accountFailure("INVALID_CREDENTIALS", "Password is incorrect.", { password: "Password is incorrect." }),
    ]);
    render(<DeleteAccountForm action={action} />);
    typeInto(ACCOUNT_FIELD_IDS.password, PW_C);
    typeInto(ACCOUNT_FIELD_IDS.confirm, "DELETE");
    await startSubmit(INTERACTIVE[4] as InteractiveSpec);
    const summary = await screen.findByTestId("delete-error-summary", undefined, WAIT);
    await waitFor(() => expectFocused(summary), WAIT);
    const pw = document.getElementById(ACCOUNT_FIELD_IDS.password) as HTMLInputElement;
    expect(pw.value).toBe("");
    expect((document.getElementById(ACCOUNT_FIELD_IDS.confirm) as HTMLInputElement).value).toBe("");
    expect(pw.getAttribute("aria-invalid")).toBe("true");
    const submit = (document.getElementById("account-delete-form") as HTMLFormElement).querySelector('button[type="submit"]');
    expect(submit).toBeDisabled();
    expect(danglingRefs(document)).toEqual([]);
  }, 30_000);

  test("R-10 on settings forms: RATE_LIMITED and ACCOUNT_LOCKED render identical summaries; UNAUTHENTICATED links to the sign-in page with next", async () => {
    const html: string[] = [];
    for (const code of ["RATE_LIMITED", "ACCOUNT_LOCKED"] as const) {
      const { action } = accountScripted([accountFailure(code, `server detail ${code}`, {}, {}, 600)]);
      const view = render(<ChangePasswordForm action={action} />);
      fireEvent.submit(document.getElementById("account-password-form") as HTMLFormElement);
      const s = await screen.findByTestId("password-error-summary", undefined, WAIT);
      await waitFor(() => expectFocused(s), WAIT);
      html.push(s.outerHTML);
      view.unmount();
    }
    expect(html[0]).toBe(html[1]);
    expect(html[0]).toContain("Too many attempts. Try again in 10 minutes.");
    expect(html[0]).not.toContain("server detail");

    const { action } = accountScripted([accountFailure("UNAUTHENTICATED", "Please sign in.")]);
    render(<ProfileForm action={action} displayName="Q" email="q@example.test" />);
    fireEvent.submit(document.getElementById("account-profile-form") as HTMLFormElement);
    const s = await screen.findByTestId("profile-error-summary", undefined, WAIT);
    expect(within(s).getByRole("link", { name: /sign in again/i })).toHaveAttribute("href", "/signin?next=%2Faccount%2Fsettings");
  }, 30_000);

  test("success states: ProfileForm and ChangePasswordForm announce through role=status; password fields cleared", async () => {
    const { action: profile } = accountScripted([
      { ok: true, kind: "profile_updated", message: "Your display name has been updated.", displayName: "Quinn Two" },
    ]);
    const { action: pw } = accountScripted([{ ok: true, kind: "password_changed", message: "Password changed." }]);
    render(
      <>
        <ProfileForm action={profile} displayName="Quinn" email="quinn@example.test" />
        <ChangePasswordForm action={pw} />
      </>,
    );
    typeInto(ACCOUNT_FIELD_IDS.displayName, "Quinn Two");
    fireEvent.submit(document.getElementById("account-profile-form") as HTMLFormElement);
    const profileStatus = await screen.findByText(PROFILE_UPDATED_MESSAGE, undefined, WAIT);
    expect(profileStatus.closest('[role="status"]')).not.toBeNull();
    expect((document.getElementById(ACCOUNT_FIELD_IDS.displayName) as HTMLInputElement).value).toBe("Quinn Two");

    typeInto(ACCOUNT_FIELD_IDS.currentPassword, PW_A);
    typeInto(ACCOUNT_FIELD_IDS.newPassword, PW_B);
    typeInto(ACCOUNT_FIELD_IDS.confirmPassword, PW_B);
    fireEvent.submit(document.getElementById("account-password-form") as HTMLFormElement);
    const pwStatus = await screen.findByText(PASSWORD_CHANGED_MESSAGE, undefined, WAIT);
    expect(pwStatus.closest('[role="status"]')).not.toBeNull();
    for (const id of [ACCOUNT_FIELD_IDS.currentPassword, ACCOUNT_FIELD_IDS.newPassword, ACCOUNT_FIELD_IDS.confirmPassword]) {
      expect((document.getElementById(id) as HTMLInputElement).value).toBe("");
    }
  }, 30_000);

  test("PasswordField keyboard: toggle is a focusable native button, flips type/name/aria-pressed, keeps value and returns focus to the input", async () => {
    render(
      <form>
        <PasswordField id="qa-pw" name="password" label="Password" autoComplete="new-password" />
      </form>,
    );
    const input = document.getElementById("qa-pw") as HTMLInputElement;
    fireEvent.change(input, { target: { value: PW_A } });
    const toggle = await screen.findByRole("button", { name: SHOW_PASSWORD_LABEL }, WAIT);
    await waitFor(() => expect(toggle).not.toBeDisabled(), WAIT);
    expect(toggle.getAttribute("tabindex")).not.toBe("-1");
    expect(toggle.getAttribute("type")).toBe("button");
    toggle.focus();
    expectFocused(toggle);
    fireEvent.click(toggle); // keyboard Enter/Space on a native <button> dispatches click
    await waitFor(() => expect(input.getAttribute("type")).toBe("text"), WAIT);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAccessibleName(HIDE_PASSWORD_LABEL);
    expect(input.value).toBe(PW_A);
    await waitFor(() => expectFocused(input), WAIT);
    fireEvent.click(toggle);
    await waitFor(() => expect(input.getAttribute("type")).toBe("password"), WAIT);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle.className).toMatch(/min-h-touch|min-h-11/);
    expect(toggle.className).toMatch(/min-w-touch|min-w-11/);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Criterion 7: 320px class audit, 44px targets, headings, unique ids
// ---------------------------------------------------------------------------

/** Unprefixed classes that break a 320px viewport (fixed widths > 280px, nowrap, horizontal overflow). */
function narrowViewportOffenders(doc: Document): string[] {
  const out: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("[class]"))) {
    for (const cls of (el.getAttribute("class") ?? "").split(/\s+/)) {
      if (cls.includes(":")) continue; // breakpoint/state-prefixed
      const fixed = /^(w|min-w)-(\d+)$/.exec(cls);
      if (fixed && Number(fixed[2]) * 4 > 280) out.push(cls);
      if (cls === "whitespace-nowrap" || cls === "w-screen" || cls === "overflow-x-scroll") out.push(cls);
      if (/^-?m[lrx]?-\[/.test(cls)) out.push(cls);
    }
  }
  return out;
}

function touchTargetOffenders(doc: Document): string[] {
  const out: string[] = [];
  const targets = doc.querySelectorAll("form button, form input:not([type=hidden]), [role=alert] a");
  for (const el of Array.from(targets)) {
    const cls = el.getAttribute("class") ?? "";
    if (!/\bmin-h-(touch|11|12)\b|\bh-(11|12)\b/.test(cls)) out.push(`${el.tagName.toLowerCase()}[name=${el.getAttribute("name") ?? ""}]`);
  }
  return out;
}

describe("criterion 7: 320px audit, 44px targets, headings, ids", () => {
  for (const spec of NOJS_FORMS) {
    test(`${spec.name}: no 320px-breaking classes, flex rows with inputs carry min-w-0, every control >= 44px, no headings above h2`, () => {
      const { doc } = ssr(spec.render());
      expect(narrowViewportOffenders(doc)).toEqual([]);
      expect(touchTargetOffenders(doc)).toEqual([]);
      for (const input of Array.from(doc.querySelectorAll("input:not([type=hidden])"))) {
        const row = input.parentElement;
        if (row && /\bflex\b/.test(row.getAttribute("class") ?? "") && !/\bflex-col\b/.test(row.getAttribute("class") ?? "")) {
          expect(row.getAttribute("class")).toContain("min-w-0");
          expect(input.getAttribute("class")).toContain("min-w-0");
        }
      }
      expect(doc.querySelectorAll("h1")).toHaveLength(0);
      // Long-text containers wrap.
      for (const p of Array.from(doc.querySelectorAll("form p"))) {
        const cls = p.getAttribute("class") ?? "";
        expect(cls).not.toContain("truncate");
        expect(cls).not.toContain("whitespace-nowrap");
      }
    });
  }

  test("all three settings forms together (as on /account/settings): ids unique, every IDREF resolves", () => {
    const { doc } = ssr(
      <>
        <h2 id="h-profile">Profile</h2>
        <ProfileForm action={accountServerLike()} displayName="Quinn" email="quinn@example.test" headingId="h-profile" />
        <h2 id="h-password">Password</h2>
        <ChangePasswordForm action={accountServerLike()} headingId="h-password" />
        <h2 id="h-delete">Delete</h2>
        <DeleteAccountForm action={accountServerLike()} headingId="h-delete" />
      </>,
    );
    expect(duplicateIds(doc)).toEqual([]);
    expect(danglingRefs(doc)).toEqual([]);
  });

  test("SignInForm + SignUpForm on one page (combined auth page the design allows): ids unique, refs resolve", () => {
    const { doc } = ssr(
      <>
        <SignInForm action={authServerLike()} />
        <SignUpForm action={authServerLike()} />
      </>,
    );
    expect(duplicateIds(doc)).toEqual([]);
    expect(danglingRefs(doc)).toEqual([]);
  });

  test("two PasswordFields without explicit ids get distinct useId-based ids", () => {
    const { doc } = ssr(
      <form>
        <PasswordField name="a" label="A" autoComplete="new-password" />
        <PasswordField name="b" label="B" autoComplete="new-password" />
      </form>,
    );
    expect(duplicateIds(doc)).toEqual([]);
    expect(danglingRefs(doc)).toEqual([]);
  });

  test("observation (not filed): a failed submit with 2 field errors exposes 3 role=alert regions (summary + one per FormField error)", async () => {
    const { action } = authScripted([
      authFailure("VALIDATION_FAILED", {
        message: AUTH_FORM_MESSAGES.invalid,
        fieldErrors: { email: "Enter a valid email address.", password: "Enter your password." },
      }),
    ]);
    render(<SignInForm action={action} />);
    fireEvent.submit(document.getElementById("signin-form") as HTMLFormElement);
    await screen.findByTestId("signin-error-summary", undefined, WAIT);
    const alerts = (document.getElementById("signin-form") as HTMLFormElement).querySelectorAll('[role="alert"]');
    // Observation recorded, not asserted as a defect: FormField marks each field error role="alert"
    // (atom design), so 3 alerts fire together. Pin the current count so a change is noticed.
    expect(alerts.length).toBe(3);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Defect pins
// ---------------------------------------------------------------------------

describe("defect pins", () => {
  // PIN: D-T124-1 (fixed)
  test("D-T124-1: sign-in identifier input uses autocomplete=username (T124 AC1 / PLAN U-03 list username for the sign-in identifier)", () => {
    const { doc } = ssr(<SignInForm action={authServerLike()} />);
    const email = doc.querySelector('input[name="email"]') as HTMLInputElement;
    expect(email.getAttribute("autocomplete")).toBe("username");
  });
});

beforeAll(() => {
  localStorage.clear();
  sessionStorage.clear();
});

beforeEach(() => {
  setSystemTime(); // never inherit a frozen clock from an earlier file
});

afterEach(() => {
  setItemSpy.mockClear();
});
