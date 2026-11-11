import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { isAllowedInternalHref } from "@/content/routes";
import type { AccountActionFn, AccountActionState } from "@/components/molecules/_contracts/account-actions";

import { SETTINGS_SECTION_IDS, SIGN_OUT_EVERYWHERE_ERROR, SIGN_OUT_EVERYWHERE_LABEL, type SettingsPageData } from "./settings-page";
import { SettingsView, type SettingsActions } from "./settings-view";

/**
 * Mimics what a Next server reference exposes to React's SSR (`$$FORM_ACTION`,
 * kept across `.bind`, which useActionState uses): the form then renders as a
 * real POST/multipart form, i.e. the no-JavaScript shape.
 */
const formFields = () => ({ name: "$ACTION_REF_1", action: "", encType: "multipart/form-data", method: "POST", data: null });

function serverLikeStateAction(): AccountActionFn {
  return Object.assign(async (): Promise<AccountActionState> => null, {
    $$FORM_ACTION: formFields,
    bind(): unknown {
      return Object.assign(async () => null, { $$FORM_ACTION: formFields });
    },
  });
}

function serverLikeFormAction(): (formData: FormData) => Promise<void> {
  return Object.assign(async (): Promise<void> => undefined, { $$FORM_ACTION: formFields });
}

function actions(): SettingsActions {
  return {
    updateProfile: serverLikeStateAction(),
    changePassword: serverLikeStateAction(),
    deleteAccount: serverLikeStateAction(),
    signOutEverywhere: serverLikeFormAction(),
  };
}

const DATA: SettingsPageData = { user: { email: "ada@example.com", displayName: "Ada Lovelace" }, sessionsError: false };

function renderDoc(data: SettingsPageData = DATA): Document {
  return new DOMParser().parseFromString(renderToStaticMarkup(<SettingsView data={data} actions={actions()} />), "text/html");
}

function fieldNames(form: Element): string[] {
  return Array.from(form.querySelectorAll("input, textarea, select"))
    .map((el) => el.getAttribute("name") ?? "")
    .filter((name) => name !== "" && !name.startsWith("$ACTION"));
}

function formLabelledBy(doc: Document, headingId: string): Element {
  const form = doc.querySelector(`form[aria-labelledby="${headingId}"]`);
  if (form === null) throw new Error(`no form labelled by ${headingId}`);
  return form;
}

describe("SettingsView structure", () => {
  test("one h1 and one h2 per section whose ids label the forms", () => {
    const doc = renderDoc();
    const h1s = doc.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe("Login & security");
    const h2s = Array.from(doc.querySelectorAll("h2"));
    expect(h2s.map((h) => h.textContent)).toEqual(["Profile", "Password", "Sessions", "Delete account"]);
    expect(h2s.map((h) => h.id)).toEqual(Object.values(SETTINGS_SECTION_IDS));
    for (const id of Object.values(SETTINGS_SECTION_IDS)) {
      expect(doc.querySelectorAll(`#${id}`)).toHaveLength(1);
      formLabelledBy(doc, id);
    }
  });

  test("breadcrumb Home > Your Account > Login & security; every href is allowed", () => {
    const doc = renderDoc();
    const nav = doc.querySelector('nav[aria-label="Breadcrumb"]') ?? doc.querySelector("nav");
    expect(nav?.textContent).toContain("Home");
    expect(nav?.textContent).toContain("Your Account");
    expect(nav?.textContent).toContain("Login & security");
    expect(nav?.querySelector('a[href="/account"]')).not.toBeNull();
    const hrefs = Array.from(doc.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(isAllowedInternalHref(href)).toBe(true);
  });

  test("exactly four forms, none nested", () => {
    const doc = renderDoc();
    expect(doc.querySelectorAll("form")).toHaveLength(4);
    expect(doc.querySelectorAll("form form")).toHaveLength(0);
  });

  test("sessions form is a real POST multipart form without a javascript: action (no-JS shape)", () => {
    const form = formLabelledBy(renderDoc(), SETTINGS_SECTION_IDS.sessions);
    expect(form.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form.getAttribute("enctype")).toBe("multipart/form-data");
    expect(form.getAttribute("action") ?? "").not.toContain("javascript:");
  });

  // Regression guard for D-T128-1 (fixed in AccountSettingsForms/shared.tsx
  // useAccountForm): the Profile, Password and Delete forms must hand React the
  // raw server action until mounted, so SSR sees the server reference's
  // `$$FORM_ACTION` and renders a real POST form (method + multipart enctype,
  // never `action="javascript:throw ..."`) that works without JavaScript
  // (SR2, T128 criterion 3).
  test("molecule forms (profile, password, delete) are real POST forms without JavaScript", () => {
    const doc = renderDoc();
    for (const id of [SETTINGS_SECTION_IDS.profile, SETTINGS_SECTION_IDS.password, SETTINGS_SECTION_IDS.delete]) {
      const form = formLabelledBy(doc, id);
      expect(form.getAttribute("method")?.toLowerCase()).toBe("post");
      expect(form.getAttribute("enctype")).toBe("multipart/form-data");
      expect(form.getAttribute("action") ?? "").not.toContain("javascript:");
    }
  });

  test("forms post the contract field names", () => {
    const doc = renderDoc();
    expect(fieldNames(formLabelledBy(doc, SETTINGS_SECTION_IDS.profile))).toEqual(["displayName"]);
    expect(fieldNames(formLabelledBy(doc, SETTINGS_SECTION_IDS.password)).sort()).toEqual(
      ["confirmPassword", "currentPassword", "newPassword"].sort(),
    );
    expect(fieldNames(formLabelledBy(doc, SETTINGS_SECTION_IDS.delete)).sort()).toEqual(["confirm", "password"]);
  });

  test("sessions form: no fields, one enabled submit 'Sign out of all devices'", () => {
    const form = formLabelledBy(renderDoc(), SETTINGS_SECTION_IDS.sessions);
    expect(fieldNames(form)).toEqual([]);
    const buttons = Array.from(form.querySelectorAll("button"));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("type")).toBe("submit");
    expect(buttons[0]?.textContent).toBe(SIGN_OUT_EVERYWHERE_LABEL);
    expect(buttons[0]?.hasAttribute("disabled")).toBe(false);
  });

  test("delete account lives in a visually separate danger section with an enabled submit", () => {
    const doc = renderDoc();
    const section = doc.querySelector('section[data-section="danger"]');
    expect(section?.getAttribute("aria-labelledby")).toBe(SETTINGS_SECTION_IDS.delete);
    expect(section?.className).toContain("border-danger");
    const form = formLabelledBy(doc, SETTINGS_SECTION_IDS.delete);
    expect(section?.contains(form)).toBe(true);
    expect(doc.querySelectorAll("section")).toHaveLength(4);
    const submit = form.querySelector('button[type="submit"]');
    expect(submit?.hasAttribute("disabled")).toBe(false);
  });

  test("email appears exactly once, as text, never in an attribute; display name prefills the input", () => {
    const html = renderToStaticMarkup(<SettingsView data={DATA} actions={actions()} />);
    expect(html.split(DATA.user.email)).toHaveLength(2);
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) expect(attr.value).not.toContain(DATA.user.email);
    }
    expect(doc.querySelector('input[name="displayName"]')?.getAttribute("value")).toBe("Ada Lovelace");
  });

  test("sessions error notice only with the flag", () => {
    expect(renderToStaticMarkup(<SettingsView data={DATA} actions={actions()} />)).not.toContain(SIGN_OUT_EVERYWHERE_ERROR);
    const doc = renderDoc({ ...DATA, sessionsError: true });
    const alert = doc.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(SIGN_OUT_EVERYWHERE_ERROR);
    const sessions = doc.querySelector(`section[aria-labelledby="${SETTINGS_SECTION_IDS.sessions}"]`);
    expect(sessions?.contains(alert ?? null)).toBe(true);
  });

  test("user text is rendered as text, never markup", () => {
    const evil = { email: "x@example.com", displayName: '<img src=x onerror="alert(1)">' };
    const doc = renderDoc({ user: evil, sessionsError: false });
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector('input[name="displayName"]')?.getAttribute("value")).toBe(evil.displayName);
  });
});
