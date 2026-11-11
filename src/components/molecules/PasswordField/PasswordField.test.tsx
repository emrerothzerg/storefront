import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen } from "@testing-library/react";
import * as policy from "@/server/auth/password-policy";
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from "../_contracts/auth-actions";
import {
  HIDE_PASSWORD_LABEL,
  LENGTH_HINT_TEXT,
  PASSWORD_FIELD_MAX_LENGTH,
  PASSWORD_FIELD_MIN_LENGTH,
  PASSWORD_RULES_TEXT,
  PasswordField,
  SHOW_PASSWORD_LABEL,
  lengthHintBucket,
} from "./index";
import { expectFocused, expectNotFocused } from "@/test/dom-assertions";

const SENTINEL = "Sentinel-Pa55-zq81x";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

const input = () => document.getElementById("pw") as HTMLInputElement;
const toggle = () => screen.getByRole("button", { name: /password/i }) as HTMLButtonElement;

describe("constants", () => {
  test("bounds equal the auth contract and the password policy (cannot drift)", () => {
    expect(PASSWORD_FIELD_MIN_LENGTH).toBe(policy.PASSWORD_MIN);
    expect(PASSWORD_FIELD_MAX_LENGTH).toBe(policy.PASSWORD_MAX);
    expect(PASSWORD_FIELD_MIN_LENGTH).toBe(AUTH_PASSWORD_MIN_LENGTH);
    expect(PASSWORD_FIELD_MAX_LENGTH).toBe(AUTH_PASSWORD_MAX_LENGTH);
  });

  test("rules text states 8..128 and no composition rules; a policy-valid password exists for it", () => {
    expect(PASSWORD_RULES_TEXT).toContain("8 to 128 characters");
    expect(PASSWORD_RULES_TEXT).toContain("No special characters are required");
    // A plain 8-char lower-case password passes the policy: the text does not overstate the rules.
    expect(policy.validatePassword("quietbirch", {}).ok).toBe(true);
    expect(policy.validatePassword("a".repeat(7), {}).ok).toBe(false);
    expect(policy.validatePassword("b".repeat(129), {}).ok).toBe(false);
  });

  test("lengthHintBucket thresholds", () => {
    expect(lengthHintBucket(0)).toBe("empty");
    expect(lengthHintBucket(Number.NaN)).toBe("empty");
    expect(lengthHintBucket(1)).toBe("short");
    expect(lengthHintBucket(7)).toBe("short");
    expect(lengthHintBucket(8)).toBe("ok");
    expect(lengthHintBucket(120)).toBe("ok");
    expect(lengthHintBucket(121)).toBe("near");
    expect(lengthHintBucket(127)).toBe("near");
    expect(lengthHintBucket(128)).toBe("max");
    expect(lengthHintBucket(500)).toBe("max");
  });
});

describe("PasswordField server markup (no JS)", () => {
  test("plain password input that submits: type, name, autocomplete, maxlength; no value attribute", () => {
    const html = renderToStaticMarkup(
      <form>
        <PasswordField id="pw" name="password" label="Password" autoComplete="current-password" required />
      </form>,
    );
    const doc = parse(html);
    const el = doc.getElementById("pw") as HTMLInputElement;
    expect(el.tagName).toBe("INPUT");
    expect(el.getAttribute("type")).toBe("password");
    expect(el.getAttribute("name")).toBe("password");
    expect(el.getAttribute("autocomplete")).toBe("current-password");
    expect(el.getAttribute("maxlength")).toBe("128");
    expect(el.hasAttribute("minlength")).toBe(false);
    expect(el.hasAttribute("value")).toBe(false);
    expect(el.hasAttribute("required")).toBe(true);
    expect(el.getAttribute("spellcheck")).toBe("false");
    expect(doc.querySelector('label[for="pw"]')?.textContent).toContain("Password");
    expect(html).not.toContain("<script");
  });

  test("toggle is rendered server-side but inert (disabled) until hydration", () => {
    const html = renderToStaticMarkup(<PasswordField id="pw" name="password" label="Password" autoComplete="new-password" />);
    const doc = parse(html);
    const button = doc.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe(SHOW_PASSWORD_LABEL);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  test("new-password: minlength 8 and the default rules helper linked via aria-describedby", () => {
    const html = renderToStaticMarkup(<PasswordField id="pw" name="password" label="Password" autoComplete="new-password" />);
    const doc = parse(html);
    const el = doc.getElementById("pw") as HTMLInputElement;
    expect(el.getAttribute("autocomplete")).toBe("new-password");
    expect(el.getAttribute("minlength")).toBe("8");
    expect(el.getAttribute("aria-describedby")?.split(" ")).toContain("pw-helper");
    expect(doc.getElementById("pw-helper")?.textContent).toBe(PASSWORD_RULES_TEXT);
    // Helper wraps at 320px (no truncation).
    expect(doc.getElementById("pw-helper")?.getAttribute("class")).toContain("break-words");
  });

  test("helperText null hides the helper; custom ReactNode helper is rendered", () => {
    const none = parse(
      renderToStaticMarkup(<PasswordField id="pw" name="p" label="P" autoComplete="current-password" helperText={null} />),
    );
    expect(none.getElementById("pw-helper")).toBeNull();
    expect(none.getElementById("pw")?.hasAttribute("aria-describedby")).toBe(false);
    const custom = parse(
      renderToStaticMarkup(
        <PasswordField id="pw" name="p" label="P" autoComplete="current-password" helperText={<strong>Custom</strong>} />,
      ),
    );
    expect(custom.getElementById("pw-helper")?.textContent).toBe("Custom");
  });

  test("error: aria-invalid + aria-describedby lists helper and error; blank error ignored", () => {
    const doc = parse(
      renderToStaticMarkup(
        <PasswordField id="pw" name="p" label="P" autoComplete="new-password" error="Password must be at least 8 characters." />,
      ),
    );
    const el = doc.getElementById("pw") as HTMLInputElement;
    expect(el.getAttribute("aria-invalid")).toBe("true");
    expect(el.getAttribute("aria-describedby")?.split(" ")).toEqual(["pw-helper", "pw-error"]);
    expect(doc.getElementById("pw-error")?.textContent).toBe("Password must be at least 8 characters.");
    const blank = parse(renderToStaticMarkup(<PasswordField id="pw" name="p" label="P" autoComplete="new-password" error="  " />));
    expect(blank.getElementById("pw")?.hasAttribute("aria-invalid")).toBe(false);
    expect(blank.getElementById("pw-error")).toBeNull();
  });

  test("hostile error text renders as text", () => {
    const html = renderToStaticMarkup(
      <PasswordField id="pw" name="p" label="P" autoComplete="new-password" error={'<img src=x onerror="alert(1)">'} />,
    );
    expect(html).not.toContain("<img");
  });

  test("generated id when none is given wires label and input", () => {
    const doc = parse(renderToStaticMarkup(<PasswordField name="p" label="Secret" autoComplete="new-password" />));
    const el = doc.querySelector("input") as HTMLInputElement;
    expect(el.id).not.toBe("");
    expect(doc.querySelector("label")?.getAttribute("for")).toBe(el.id);
  });

  test("no length hint region unless showLengthHint", () => {
    const off = renderToStaticMarkup(<PasswordField id="pw" name="p" label="P" autoComplete="new-password" />);
    expect(off).not.toContain('role="status"');
    const on = parse(renderToStaticMarkup(<PasswordField id="pw" name="p" label="P" autoComplete="new-password" showLengthHint />));
    const region = on.getElementById("pw-length");
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toBe("");
  });
});

describe("PasswordField interactions", () => {
  test("toggle: accessible name and aria-pressed flip; value and focus preserved; >= 44px; keyboard-operable button", () => {
    render(<PasswordField id="pw" name="password" label="Password" autoComplete="current-password" />);
    const b = toggle();
    expect(b.tagName).toBe("BUTTON");
    expect(b.disabled).toBe(false); // hydrated
    expect(b.className).toContain("size-touch");
    expect(b.getAttribute("aria-controls")).toBe("pw");

    input().focus();
    fireEvent.change(input(), { target: { value: SENTINEL } });
    input().setSelectionRange(3, 5);

    // Pointer press does not steal focus from the input.
    expect(fireEvent.mouseDown(b)).toBe(false);
    fireEvent.click(b);
    expect(input().type).toBe("text");
    expect(input().value).toBe(SENTINEL);
    expectFocused(input());
    expect(input().selectionStart).toBe(3);
    expect(input().selectionEnd).toBe(5);
    expect(toggle().getAttribute("aria-label")).toBe(HIDE_PASSWORD_LABEL);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");

    // Keyboard: focus the button and activate it (native button: Enter/Space -> click).
    toggle().focus();
    expectFocused(toggle());
    fireEvent.click(toggle());
    expect(input().type).toBe("password");
    expect(input().value).toBe(SENTINEL);
    expectFocused(input());
    expect(toggle().getAttribute("aria-label")).toBe(SHOW_PASSWORD_LABEL);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  test("the typed value never appears in any attribute, data-*, outerHTML or storage (masked and revealed)", () => {
    localStorage.clear();
    sessionStorage.clear();
    const { container } = render(
      <form>
        <PasswordField id="pw" name="password" label="Password" autoComplete="new-password" showLengthHint />
      </form>,
    );
    fireEvent.change(input(), { target: { value: SENTINEL } });
    const check = () => {
      for (const el of container.querySelectorAll("*")) {
        for (const attr of el.getAttributeNames()) {
          expect(el.getAttribute(attr) ?? "").not.toContain(SENTINEL);
        }
        if (el instanceof HTMLElement) {
          for (const v of Object.values(el.dataset)) expect(v ?? "").not.toContain(SENTINEL);
        }
      }
      expect(container.innerHTML).not.toContain(SENTINEL);
      expect(document.documentElement.outerHTML).not.toContain(SENTINEL);
      for (const storage of [localStorage, sessionStorage]) {
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i) ?? "";
          expect(key).not.toContain(SENTINEL);
          expect(storage.getItem(key) ?? "").not.toContain(SENTINEL);
        }
      }
    };
    check();
    fireEvent.click(toggle());
    expect(input().value).toBe(SENTINEL);
    check();
  });

  test("live length hint only changes at thresholds", () => {
    render(<PasswordField id="pw" name="password" label="Password" autoComplete="new-password" showLengthHint />);
    const region = () => document.getElementById("pw-length") as HTMLElement;
    const type = (n: number) => fireEvent.change(input(), { target: { value: "x".repeat(n) } });
    expect(region().textContent).toBe("");
    type(3);
    expect(region().textContent).toBe(LENGTH_HINT_TEXT.short);
    const node = region().firstChild;
    type(6);
    expect(region().textContent).toBe(LENGTH_HINT_TEXT.short);
    expect(region().firstChild).toBe(node); // no DOM mutation, nothing re-announced
    type(8);
    expect(region().textContent).toBe(LENGTH_HINT_TEXT.ok);
    type(100);
    expect(region().textContent).toBe(LENGTH_HINT_TEXT.ok);
    type(121);
    expect(region().textContent).toBe(LENGTH_HINT_TEXT.near);
    type(128);
    expect(region().textContent).toBe(LENGTH_HINT_TEXT.max);
    type(0);
    expect(region().textContent).toBe("");
  });

  test("form reset masks the field again and clears the hint", () => {
    render(
      <form data-testid="f">
        <PasswordField id="pw" name="password" label="Password" autoComplete="new-password" showLengthHint />
      </form>,
    );
    fireEvent.change(input(), { target: { value: SENTINEL } });
    fireEvent.click(toggle());
    expect(input().type).toBe("text");
    act(() => {
      (screen.getByTestId("f") as HTMLFormElement).reset();
    });
    expect(input().value).toBe("");
    expect(input().type).toBe("password");
    expect(document.getElementById("pw-length")?.textContent).toBe("");
  });

  test("the field is part of form submission under its name", () => {
    render(
      <form data-testid="f">
        <PasswordField id="pw" name="password" label="Password" autoComplete="current-password" />
      </form>,
    );
    fireEvent.change(input(), { target: { value: "hunter2hunter2" } });
    const fd = new FormData(screen.getByTestId("f") as HTMLFormElement);
    expect(fd.get("password")).toBe("hunter2hunter2");
  });

  test("320px-safe: no fixed widths; input shrinks beside the toggle", () => {
    const { container } = render(<PasswordField id="pw" name="p" label="P" autoComplete="new-password" showLengthHint />);
    const tokens = [...container.querySelectorAll("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    const fixedWidths = tokens.filter((t) => /^(w|min-w)-(\d+|screen|\[.*\])$/.test(t) && t !== "min-w-0");
    expect(fixedWidths).toEqual([]);
    expect(input().className).toContain("min-w-0");
    expect(input().className).toContain("flex-1");
  });

  test("no autofocus", () => {
    render(<PasswordField id="pw" name="p" label="P" autoComplete="new-password" />);
    expect(input().hasAttribute("autofocus")).toBe(false);
    expectNotFocused(input());
  });
});
