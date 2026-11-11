import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Wiring tests for ./checkout-v2 (T71). next/headers, next/navigation (real
// exports spread, so unstable_rethrow stays real) and next/cache are mocked
// process-wide before the module is imported and delegate to per-test state.
// ---------------------------------------------------------------------------

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url} (test sentinel)`);
  }
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: string[] = [];

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string): void {
    this.setCalls.push(name);
    this.jar.set(name, value);
  }
}

let fakeStore = new FakeCookieStore();
const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
const redirect = mock((url: string): never => {
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));
mock.module("next/navigation", () => ({ ...realNavigation, redirect }));
mock.module("next/cache", () => ({ revalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
closeDatabase();
const dbGlobal = globalThis as typeof globalThis & { __storefrontDb?: unknown };
const wired = await import("./checkout-v2");
const dbOpenedByImport = dbGlobal.__storefrontDb !== undefined;
const { placeOrderV2 } = wired;
const { seedDatabase } = await import("@/server/db/seed");
const { createCartService } = await import("@/server/cart/cart-service");
const { getAddressService } = await import("@/server/addresses/address-service");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { MOCK_CARDS } = await import("@/server/payments/mock-payment-provider");

const TOTE = "prod_canvas-tote-bag";
const SESSION = "99999999-9999-4999-8999-999999999999";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function baseFields(card: string, key: string): [string, string][] {
  return [
    ["idempotencyKey", key],
    ["fullName", "Grace Hopper"],
    ["email", "grace@example.com"],
    ["line1", "1 Compiler Rd"],
    ["line2", ""],
    ["city", "Arlington"],
    ["region", "VA"],
    ["postalCode", "22201"],
    ["country", "US"],
    ["nameOnCard", "Grace Hopper"],
    ["number", card],
    ["expMonth", "1"],
    ["expYear", String(new Date().getUTCFullYear() + 3)],
    ["cvc", "123"],
  ];
}

/** FormData parsed from a multipart body the way a no-JS browser posts the form. */
async function browserMultipart(fields: readonly (readonly [string, string])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundaryCh3ck0utV2T71";
  const all: (readonly [string, string])[] = [["$ACTION_ID_5c4b3a", ""], ...fields];
  const body =
    all.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") +
    `--${boundary}--\r\n`;
  const request = new Request("http://localhost/checkout", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  return request.formData();
}

async function redirectUrl(fd: FormData): Promise<string> {
  try {
    const state = await placeOrderV2(null, fd);
    throw new Error(`expected redirect, got ${JSON.stringify(state)}`);
  } catch (e) {
    if (e instanceof RedirectSentinel) return e.url;
    throw e;
  }
}

function orderCount(): number {
  return (getDatabase().query("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
}

beforeEach(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  fakeStore = new FakeCookieStore();
  revalidatePath.mockClear();
  redirect.mockClear();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("checkout-v2.ts wiring", () => {
  test("exports only the async placeOrderV2 and opens no DB at import", () => {
    expect(Object.keys(wired)).toEqual(["placeOrderV2"]);
    expect(placeOrderV2.constructor.name).toBe("AsyncFunction");
    expect(dbOpenedByImport).toBe(false);
  });

  test("browser multipart success: cookie session, forged fields ignored, revalidates, redirects; replay = same order", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    const key = crypto.randomUUID();
    const fields: [string, string][] = [
      ...baseFields(MOCK_CARDS.success, key),
      ["shippingMethodId", "express"],
      ["deliveryNote", "Ring twice"],
      ["saveAddress", "on"],
      ["addressLabel", "Home"],
      ["phone", "+1 555 0100"],
      ["total", "1"],
      ["discount", "99999"],
      ["price", "0"],
      ["sessionId", OTHER],
    ];

    const url = await redirectUrl(await browserMultipart(fields));
    const row = getDatabase()
      .query(
        "SELECT id, session_id AS s, shipping_method_id AS m, delivery_note AS n, total_cents AS t, subtotal_cents AS st, shipping_cents AS sh FROM orders",
      )
      .get() as { id: string; s: string; m: string; n: string; t: number; st: number; sh: number };
    expect(url).toBe(`/orders/${row.id}?placed=1`);
    expect(row).toMatchObject({ s: SESSION, m: "express", n: "Ring twice", st: 1999, sh: 999, t: 2998 });
    expect(revalidatePath.mock.calls).toEqual([["/cart"], ["/", "layout"], ["/orders"], ["/account/addresses"]]);
    expect(getAddressService().list(SESSION)).toHaveLength(1);
    expect(getAddressService().list(OTHER)).toHaveLength(0);
    expect(url).not.toContain("Grace");

    expect(await redirectUrl(await browserMultipart(fields))).toBe(url);
    expect(orderCount()).toBe(1);
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("saved address of another session: NOT_FOUND field error, no order", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    const theirs = getAddressService().create(OTHER, {
      fullName: "Other Person",
      email: undefined,
      line1: "2 Elsewhere St",
      line2: undefined,
      city: "Paris",
      region: "IDF",
      postalCode: "75001",
      country: "FR",
    });
    if (!theirs.ok) throw new Error("seed address failed");
    const fd = await browserMultipart([
      ...baseFields(MOCK_CARDS.success, crypto.randomUUID()),
      ["addressMode", "saved"],
      ["addressId", theirs.value.id],
    ]);
    const state = await placeOrderV2(null, fd);
    expect(state?.error.code).toBe("NOT_FOUND");
    expect(state?.fieldErrors?.addressId).toBe("Choose a saved address.");
    expect(orderCount()).toBe(0);
    expect(redirect).not.toHaveBeenCalled();
  });

  test("no session cookie: EMPTY_CART, no cookie set", async () => {
    const state = await placeOrderV2(null, await browserMultipart(baseFields(MOCK_CARDS.success, crypto.randomUUID())));
    expect(state?.error.code).toBe("EMPTY_CART");
    expect(fakeStore.setCalls).toEqual([]);
    expect(orderCount()).toBe(0);
  });

  test("declined card returns PAYMENT_FAILED without card data and keeps the cart", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    const state = await placeOrderV2(null, await browserMultipart(baseFields(MOCK_CARDS.declined, crypto.randomUUID())));
    expect(state?.error.code).toBe("PAYMENT_FAILED");
    expect(JSON.stringify(state)).not.toContain(MOCK_CARDS.declined);
    expect(createCartService().getCart(SESSION).itemCount).toBe(1);
  });
});
