/**
 * Test-only helpers for the auth forms. Not exported from any index.
 */
import { appError } from "@/lib/result";
import type { ErrorCode } from "@/lib/types";
import type {
  AuthActionCode,
  AuthActionFn,
  AuthActionState,
  AuthEchoValues,
  AuthErrorField,
} from "../_contracts/auth-actions";

export type Fields = Record<string, string>;

export function snapshot(formData: FormData): Fields {
  const out: Fields = {};
  formData.forEach((value, name) => {
    if (typeof value === "string") out[name] = value;
  });
  return out;
}

export function scriptedAction(steps: ReadonlyArray<AuthActionState>): { action: AuthActionFn; calls: Fields[] } {
  const calls: Fields[] = [];
  const action: AuthActionFn = async (_prev, formData) => {
    calls.push(snapshot(formData));
    return steps[calls.length - 1] ?? null;
  };
  return { action, calls };
}

export function controlledAction(): {
  action: AuthActionFn;
  calls: Fields[];
  resolve: (s: AuthActionState) => void;
  reject: (e: unknown) => void;
} {
  const calls: Fields[] = [];
  let resolveFn: (s: AuthActionState) => void = () => {};
  let rejectFn: (e: unknown) => void = () => {};
  const action: AuthActionFn = (_prev, formData) => {
    calls.push(snapshot(formData));
    return new Promise<AuthActionState>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
  };
  return { action, calls, resolve: (s) => resolveFn(s), reject: (e) => rejectFn(e) };
}

export function authFailure(
  code: AuthActionCode,
  options: {
    errorCode?: ErrorCode;
    message?: string;
    fieldErrors?: Partial<Record<AuthErrorField, string>>;
    values?: AuthEchoValues;
    retryAfterSeconds?: number;
  } = {},
): AuthActionState {
  const errorCode: ErrorCode = options.errorCode ?? (code === "TOO_MANY_ATTEMPTS" ? "RATE_LIMITED" : code);
  const message = options.message ?? "server message";
  const details = options.retryAfterSeconds === undefined ? undefined : { retryAfterSeconds: options.retryAfterSeconds };
  const base = {
    ok: false as const,
    error: appError(errorCode, message, details),
    code,
    message,
    fieldErrors: options.fieldErrors ?? {},
    values: options.values ?? {},
  };
  return options.retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds: options.retryAfterSeconds };
}

/**
 * Mimics what a Next server reference exposes to React's SSR (`$$FORM_ACTION`,
 * kept across `.bind`, which useActionState applies).
 */
export function serverLikeAction(): AuthActionFn {
  const formFields = () => ({
    name: "$ACTION_REF_1",
    action: "",
    encType: "multipart/form-data",
    method: "POST",
    data: null,
  });
  return Object.assign(async (): Promise<AuthActionState> => null, {
    $$FORM_ACTION: formFields,
    bind(): unknown {
      return Object.assign(async () => null, { $$FORM_ACTION: formFields });
    },
  });
}

export const HOSTILE_NEXT = [
  "//evil.com",
  "https://evil.com",
  "javascript:alert(1)",
  "/\\evil",
  "%2F%2Fevil",
  "/%2F%2Fevil.com",
  "/%5Cevil",
  "\\\\evil.com",
  " /orders",
  "/orders\n",
  "http:/evil.com",
  "",
] as const;

export const HOSTILE_TEXT = '"><img src=x onerror="alert(1)"><script>alert(2)</script>';
