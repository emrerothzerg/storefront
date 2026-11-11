/**
 * Test-only helpers for the Q&A molecules. Not exported from any index.
 */
import { appError } from "@/lib/result";
import type { ErrorCode } from "@/lib/types";
import type {
  QaActionFn,
  QaActionState,
  QaEchoValues,
  QaVoteActionFn,
  QaVoteActionState,
} from "../_contracts/qa-actions";

export type Fields = Record<string, string>;

export function snapshot(formData: FormData): Fields {
  const out: Fields = {};
  formData.forEach((value, name) => {
    if (typeof value === "string") out[name] = value;
  });
  return out;
}

export function scriptedAction(steps: ReadonlyArray<QaActionState>): { action: QaActionFn; calls: Fields[] } {
  const calls: Fields[] = [];
  const action: QaActionFn = async (_prev, formData) => {
    calls.push(snapshot(formData));
    return steps[calls.length - 1] ?? null;
  };
  return { action, calls };
}

export function controlledAction(): { action: QaActionFn; calls: Fields[]; resolve: (s: QaActionState) => void } {
  const calls: Fields[] = [];
  let resolveFn: (s: QaActionState) => void = () => {};
  const action: QaActionFn = (_prev, formData) => {
    calls.push(snapshot(formData));
    return new Promise<QaActionState>((res) => {
      resolveFn = res;
    });
  };
  return { action, calls, resolve: (s) => resolveFn(s) };
}

export function controlledVote(): {
  action: QaVoteActionFn;
  calls: Fields[];
  resolve: (s: QaVoteActionState) => void;
} {
  const calls: Fields[] = [];
  let resolveFn: (s: QaVoteActionState) => void = () => {};
  const action: QaVoteActionFn = (_prev, formData) => {
    calls.push(snapshot(formData));
    return new Promise<QaVoteActionState>((res) => {
      resolveFn = res;
    });
  };
  return { action, calls, resolve: (s) => resolveFn(s) };
}

export function qaFailure(
  code: ErrorCode,
  message: string,
  fieldErrors: Partial<Record<keyof QaEchoValues, string>> = {},
  values: QaEchoValues = {},
  retryAfterSeconds?: number,
): QaActionState {
  const base = { ok: false as const, error: appError(code, message), message, fieldErrors, values };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

export function voteFailure(code: ErrorCode, message: string, retryAfterSeconds?: number): QaVoteActionState {
  const base = { ok: false as const, error: appError(code, message), message };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

const formMeta = (prefix: string) => ({
  name: `$ACTION_ID_test${prefix}`,
  action: "",
  encType: "multipart/form-data",
  method: "POST",
  data: null,
});

/**
 * Mimics a Next server-action reference for `renderToStaticMarkup`: React's
 * server renderer turns a `<form action>` into `method="POST"` +
 * multipart + a hidden `$ACTION_ID_*` field only when the action (and its
 * `bind` result, used by `useActionState`) carries `$$FORM_ACTION`. A plain
 * function renders a `javascript:throw` action instead, so this proves the
 * component passes the action through unwrapped (the no-JS requirement).
 */
export function fakeServerAction<F extends (...args: never[]) => unknown>(fn: F): F {
  const bind = (thisArg: unknown, ...args: unknown[]) =>
    Object.assign(Function.prototype.bind.call(fn, thisArg, ...args), { $$FORM_ACTION: formMeta });
  return Object.assign(fn, { $$FORM_ACTION: formMeta, bind });
}

export const HOSTILE = `<script>alert(1)</script><img src=x onerror="alert(2)">`;

const FOCUSABLE = "a[href], button, input:not([type='hidden']), select, textarea, summary";

/** Is `el` rendered for keyboard users (not inside a closed `<details>`, except its own summary)? */
function reachable(el: Element): boolean {
  if (el.hasAttribute("disabled") || el.getAttribute("tabindex") === "-1") return false;
  let node: Element | null = el;
  while (node) {
    const details: HTMLDetailsElement | null = node.parentElement?.closest("details") ?? null;
    if (!details) return true;
    const ownSummary = node.tagName === "SUMMARY" && node.parentElement === details;
    if (!details.open && !ownSummary) return false;
    node = details;
  }
  return true;
}

/** Sequential Tab order of the document (DOM order; no positive tabindex in these components). */
export function tabOrder(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(reachable);
}

/** Emulates one Tab press from the focused element; returns the newly focused element. */
export function pressTab(): HTMLElement | null {
  const order = tabOrder();
  const current = document.activeElement;
  const index = current instanceof HTMLElement ? order.indexOf(current) : -1;
  const next = order[index + 1] ?? null;
  next?.focus();
  return next;
}
