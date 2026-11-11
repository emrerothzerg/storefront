import { appError } from "@/lib/result";
import type { ErrorCode } from "@/lib/types";
import type {
  AccountActionFn,
  AccountActionState,
  AccountFieldName,
} from "../_contracts/account-actions";

/** Test-only helpers shared by the AccountSettingsForms tests. */

export type Fields = Record<string, string>;

export function snapshot(formData: FormData): Fields {
  const out: Fields = {};
  formData.forEach((value, name) => {
    if (typeof value === "string") out[name] = value;
  });
  return out;
}

/** Resolves the n-th call with steps[n] (null past the end). */
export function scriptedAction(steps: ReadonlyArray<AccountActionState>) {
  const calls: Fields[] = [];
  const action: AccountActionFn = async (_prev, formData) => {
    calls.push(snapshot(formData));
    return steps[calls.length - 1] ?? null;
  };
  return { action, calls };
}

/** Stays pending until `resolve` / `reject` is called. */
export function controlledAction() {
  const calls: Fields[] = [];
  let resolveFn: (s: AccountActionState) => void = () => {};
  let rejectFn: (e: unknown) => void = () => {};
  const action: AccountActionFn = (_prev, formData) => {
    calls.push(snapshot(formData));
    return new Promise<AccountActionState>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
  };
  return {
    action,
    calls,
    resolve: (s: AccountActionState) => resolveFn(s),
    reject: (e: unknown) => rejectFn(e),
  };
}

export function failure(
  code: ErrorCode,
  message: string,
  fieldErrors: Partial<Record<AccountFieldName, string>> = {},
  values: { displayName?: string } = {},
  retryAfterSeconds?: number,
): AccountActionState {
  const base = { ok: false as const, error: appError(code, message), message, fieldErrors, values };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

export const HOSTILE = '<img src=x onerror="alert(1)">';
export const SENTINEL = "Sentinel-Pw-7a1f!x";

export function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** Every attribute value in the subtree, plus web storage contents. */
export function attributeDump(root: Element): string {
  const parts: string[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const attr of el.attributes) parts.push(`${attr.name}=${attr.value}`);
  }
  for (const storage of [localStorage, sessionStorage]) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) parts.push(`${key}=${storage.getItem(key) ?? ""}`);
    }
  }
  return parts.join("\n");
}

/**
 * Mimics what a Next server reference exposes to React's SSR: `$$FORM_ACTION`,
 * kept across `.bind` (useActionState binds the previous state).
 */
export function serverLikeAction(): AccountActionFn {
  const formFields = () => ({
    name: "$ACTION_REF_1",
    action: "",
    encType: "multipart/form-data",
    method: "POST",
    data: null,
  });
  return Object.assign(async (): Promise<AccountActionState> => null, {
    $$FORM_ACTION: formFields,
    bind(): unknown {
      return Object.assign(async () => null, { $$FORM_ACTION: formFields });
    },
  });
}

/** Asserts the server markup is a real no-JS POST form. */
export function expectRealPostForm(form: Element | null | undefined) {
  if (!form) throw new Error("form missing");
  if (form.getAttribute("method")?.toLowerCase() !== "post") throw new Error(`method=${form.getAttribute("method")}`);
  if (form.getAttribute("enctype") !== "multipart/form-data") throw new Error(`enctype=${form.getAttribute("enctype")}`);
  if ((form.getAttribute("action") ?? "").includes("javascript:")) throw new Error("javascript: action");
}
