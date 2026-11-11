/**
 * Shared harness for the T111 (QA wave 6) page files. QA-owned. Copied and
 * trimmed from tests/app/phase2-wave5/_harness.ts (read-only for us): the
 * process-wide `next/*` mocks SPREAD the real modules and delegate to
 * per-test state. Every page file calls `installNextMocks()` before importing
 * its page module.
 */
import { mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/** Cookie store double: records every write attempt. */
export class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly writes: string[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  has(name: string): boolean {
    return this.jar.has(name);
  }
  getAll(): { name: string; value: string }[] {
    return [...this.jar].map(([name, value]) => ({ name, value }));
  }
  set(name: string): void {
    this.writes.push(`set:${name}`);
  }
  delete(name: string): void {
    this.writes.push(`delete:${name}`);
  }
}

export const harness = {
  store: new FakeCookieStore(),
  cookieReads: 0,
  revalidated: [] as string[],
};

const realServer = { ...(await import("next/server")) };
const realHeaders = { ...(await import("next/headers")) };
const realCache = { ...(await import("next/cache")) };

export function installNextMocks(): void {
  mock.module("next/server", () => ({
    ...realServer,
    connection: async (): Promise<void> => undefined,
  }));
  mock.module("next/headers", () => ({
    ...realHeaders,
    cookies: async (): Promise<FakeCookieStore> => {
      harness.cookieReads += 1;
      return harness.store;
    },
    headers: async (): Promise<Headers> => new Headers(),
  }));
  mock.module("next/cache", () => ({
    ...realCache,
    revalidatePath: (path: string): void => {
      harness.revalidated.push(path);
    },
  }));
}

installNextMocks();

export function resetCookies(cookies: Readonly<Record<string, string>> = {}): FakeCookieStore {
  harness.store = new FakeCookieStore();
  for (const [k, v] of Object.entries(cookies)) harness.store.jar.set(k, v);
  harness.cookieReads = 0;
  harness.revalidated = [];
  return harness.store;
}

// ---------------------------------------------------------------------------
// `$$FORM_ACTION` server-reference fixture (pattern from ReviewCard.test.tsx /
// wave-5 harness): patches the REAL exported action function objects so React
// SSR renders a real POST/multipart form; `.bind` keeps the marker.
// ---------------------------------------------------------------------------

const formFields = () => ({
  name: "$ACTION_REF_QA",
  action: "",
  encType: "multipart/form-data",
  method: "POST",
  data: null,
});

type AnyFn = (...args: never[]) => unknown;

function markServerLike(fn: AnyFn): void {
  const realBind = Function.prototype.bind;
  Object.defineProperty(fn, "$$FORM_ACTION", { value: formFields, configurable: true, writable: true });
  Object.defineProperty(fn, "bind", {
    configurable: true,
    writable: true,
    value(this: AnyFn, thisArg: unknown, ...args: unknown[]): AnyFn {
      const bound = realBind.call(this, thisArg, ...args) as AnyFn;
      markServerLike(bound);
      return bound;
    },
  });
}

export function serverLike(fns: readonly AnyFn[]): () => void {
  for (const fn of fns) markServerLike(fn);
  return () => {
    for (const fn of fns) {
      delete (fn as unknown as Record<string, unknown>).$$FORM_ACTION;
      delete (fn as unknown as Record<string, unknown>).bind;
    }
  };
}

// ---------------------------------------------------------------------------
// Markup checks
// ---------------------------------------------------------------------------

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
}

const HASH = "#";

/** Every `a[href]`: in-page fragment links must target an element; the rest must pass `isAllowed`. */
export function hrefViolations(doc: Document, isAllowed: (href: string) => boolean): string[] {
  const out: string[] = [];
  for (const a of doc.body.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith(HASH)) {
      const id = decodeURIComponent(href.slice(1));
      if (id === "" || doc.body.querySelector(`[id="${CSS.escape(id)}"]`) === null) out.push(`dangling:${href}`);
      continue;
    }
    if (!isAllowed(href)) out.push(`href:${href}`);
  }
  return out;
}

/** One h1, first heading is the h1, no skipped levels going down. */
export function headingViolations(doc: Document): string[] {
  const levels = [...doc.body.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName.slice(1)));
  const out: string[] = [];
  const h1 = levels.filter((l) => l === 1).length;
  if (h1 !== 1) out.push(`h1 count ${h1}`);
  if (levels[0] !== 1) out.push(`first heading is h${levels[0] ?? "none"}`);
  for (let i = 1; i < levels.length; i += 1) {
    const prev = levels[i - 1] ?? 1;
    const cur = levels[i] ?? 1;
    if (cur > prev + 1) out.push(`skip h${prev}->h${cur} at index ${i}`);
  }
  return out;
}

export function duplicateIds(doc: Document): string[] {
  const seen = new Map<string, number>();
  for (const el of doc.body.querySelectorAll("[id]")) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

/** Maximum `<form>` nesting depth in RAW markup (the HTML parser silently drops nested forms). */
export function maxFormDepth(html: string): number {
  let depth = 0;
  let max = 0;
  for (const m of html.matchAll(/<(\/?)form\b/gi)) {
    depth += m[1] === "/" ? -1 : 1;
    max = Math.max(max, depth);
  }
  return max;
}

/** Accessible name of a button: aria-label, else text content (incl. visually hidden text). */
export function buttonName(b: Element): string {
  const label = b.getAttribute("aria-label");
  if (label !== null) return label.trim().replace(/\s+/g, " ");
  return (b.textContent ?? "").trim().replace(/\s+/g, " ");
}

export const TOUCH_RE = /\b(min-h-touch|h-touch|size-touch)\b/;

/** Visible submit buttons without a 44px touch-target class. */
export function smallSubmitButtons(doc: Document): string[] {
  const out: string[] = [];
  for (const b of doc.body.querySelectorAll('button[type="submit"], button:not([type])')) {
    if (b.closest("[hidden]") !== null) continue;
    const cls = b.getAttribute("class") ?? "";
    if (!TOUCH_RE.test(cls)) out.push(buttonName(b) || "(unnamed)");
  }
  return out;
}

export function isRealPostForm(form: Element): boolean {
  const method = (form.getAttribute("method") ?? "").toLowerCase();
  const enctype = form.getAttribute("enctype") ?? "";
  const action = form.getAttribute("action") ?? "";
  return method === "post" && enctype === "multipart/form-data" && !action.includes("javascript:");
}

/** Field names a form would post, excluding React's own `$ACTION_*` plumbing. */
export function postedFieldNames(form: Element): string[] {
  return [...form.querySelectorAll("input[name], select[name], textarea[name], button[name]")]
    .map((el) => el.getAttribute("name") ?? "")
    .filter((n) => n !== "" && !n.startsWith("$ACTION"));
}

/** FormData a no-JS browser would post for this form (checked radios only; first submit button excluded). */
export function formDataOf(form: Element): FormData {
  const fd = new FormData();
  for (const el of form.querySelectorAll("input[name], select[name], textarea[name]")) {
    const name = el.getAttribute("name") ?? "";
    if (name === "" || name.startsWith("$ACTION")) continue;
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if ((type === "radio" || type === "checkbox") && !el.hasAttribute("checked")) continue;
    fd.append(name, el.getAttribute("value") ?? "");
  }
  return fd;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface SignedInUser {
  readonly userId: string;
  readonly ownerKey: string;
  readonly token: string;
  readonly tokenHash: string;
  readonly email: string;
  readonly displayName: string;
}

/** A user + live auth session created through the real auth repository. */
export async function createSignedInUser(db: Database, displayName: string, emailLocal: string): Promise<SignedInUser> {
  const { createAuthRepository } = await import("@/server/auth/auth-repository");
  const repo = createAuthRepository(db);
  const passwordHash = `$argon2id$v=19$m=65536,t=2,p=1$qafixturesalt$qafixturehash${emailLocal}`;
  const created = repo.createUser({ email: `${emailLocal}@example.test`, passwordHash, displayName });
  if (!created.ok) throw new Error(`createUser failed: ${created.error.code}`);
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const session = repo.createAuthSession({
    userId: created.value.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  if (!session.ok) throw new Error(`createAuthSession failed: ${session.error.code}`);
  return {
    userId: created.value.id,
    ownerKey: created.value.ownerKey,
    token,
    tokenHash,
    email: created.value.email,
    displayName,
  };
}

export function totalChanges(db: Database): number {
  return db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? -1;
}

/** Counts clock reads (Date.now, argument-less `new Date()`) while `run` executes; records a short stack per read. */
export async function countClockReads<T>(run: () => Promise<T>): Promise<{ value: T; reads: number; stacks: string[] }> {
  const RealDate = globalThis.Date;
  const stacks: string[] = [];
  const note = (): void => {
    const frames = (new Error().stack ?? "").split("\n").slice(2, 6).map((s) => s.trim());
    stacks.push(frames.join(" <- "));
  };
  class CountingDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(...args);
      const argc: number = args.length;
      if (argc === 0) note();
    }
    static override now(): number {
      note();
      return RealDate.now();
    }
  }
  globalThis.Date = CountingDate as DateConstructor;
  try {
    const value = await run();
    return { value, reads: stacks.length, stacks };
  } finally {
    globalThis.Date = RealDate;
  }
}

/** Places a real paid order (cart service + order service v2, zero-latency mock payments). Copied from the wave-5 harness. */
export async function placePaidOrder(
  db: Database,
  ownerKey: string,
  productIds: readonly string[],
): Promise<{ readonly orderId: string }> {
  const { createCartService } = await import("@/server/cart/cart-service");
  const { createOrderService } = await import("@/server/orders/order-service");
  const { createMockPaymentProvider, MOCK_CARDS } = await import("@/server/payments/mock-payment-provider");
  const carts = createCartService(db);
  for (const id of productIds) {
    const r = carts.addItem(ownerKey, id, 1);
    if (!r.ok) throw new Error(`addItem failed: ${r.error.code}`);
  }
  const orders = createOrderService(db, { payments: createMockPaymentProvider({ latencyMs: 0 }), inFlight: new Map() });
  const address = {
    fullName: "Quentin Cartqa",
    email: "quentin.cartqa@example.test",
    line1: "1 QA Way",
    city: "Testville",
    region: "OR",
    postalCode: "97475",
    country: "US",
  };
  const placed = await orders.placeOrderV2({
    sessionId: ownerKey,
    address,
    card: { number: MOCK_CARDS.success, expMonth: 12, expYear: 2031, cvc: "987", nameOnCard: address.fullName },
    idempotencyKey: `qa-idem-${crypto.randomUUID()}`,
  });
  if (!placed.ok) throw new Error(`placeOrderV2 failed: ${JSON.stringify(placed.error)}`);
  return { orderId: placed.value.id };
}
