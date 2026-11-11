import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// T129b QA: journeys at function level on two cookie jars (PLAN 3.12 J-01..J-05,
// T129 criterion 4) driving the REAL `'use server'` action wrappers over the
// :memory: app DB, then rendering the REAL account pages for each jar.
// The app-wide auth/account services are swapped for ones using the fast
// hasher (same DB handle, globalThis caches), exactly like actions.qa.test.ts.
//
// One guest order is inserted with the fixture `seedOrderAndQa` (the purchase
// journey through checkout is T111b's); everything else goes through actions.
// Steps share state and run in order; each has an explicit 30 s timeout.
// ---------------------------------------------------------------------------

import { QaCookieStore, RedirectSentinel } from "./_fixtures";

let store = new QaCookieStore();
const realHeaders = { ...(await import("next/headers")) };
const realCache = { ...(await import("next/cache")) };
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/headers", () => ({
  ...realHeaders,
  cookies: async (): Promise<QaCookieStore> => store,
  headers: async (): Promise<Headers> => new Headers({ "user-agent": "qa-journeys/1.0" }),
}));
mock.module("next/cache", () => ({ ...realCache, revalidatePath: () => undefined }));
mock.module("next/navigation", () => ({
  ...realNavigation,
  redirect: (url: string): never => {
    throw new RedirectSentinel(url);
  },
  notFound: (): never => {
    throw new Error("unexpected notFound()");
  },
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
closeDatabase();
const { seedDatabase } = await import("@/server/db/seed");
const { createAuthService, getAuthService } = await import("@/server/auth/auth-service");
const { createAuthRepository } = await import("@/server/auth/auth-repository");
const { createAccountService } = await import("@/server/auth/account-service");
const { validatePassword } = await import("@/server/auth/password-policy");
const { getRateLimiter } = await import("@/server/security/rate-limiter");
const { getCartService } = await import("@/server/cart/cart-service");
const { readSessionId } = await import("@/server/session/session");
const { GUEST_NOTICE_TEXT } = await import("@/components/organisms/AccountHub");
const { signUp, signIn, signOut } = await import("@/app/actions/auth");
const { updateProfile, deleteAccount, signOutEverywhere } = await import("@/app/actions/account");
const { addToCart } = await import("@/app/actions/cart");
const { submitReview } = await import("@/app/actions/reviews");
const { saveAddress } = await import("@/app/actions/addresses");
const { askQuestion } = await import("@/app/actions/questions");
const fx = await import("./_fixtures");
const { PASSWORD, SecretRegistry, consoleCapture, counts, fastHasher, form, fullSnapshot, seedOrderAndQa, uuid, zeroCounts, OWNER_TABLES, TOMBSTONE } = fx;

const PAGES = {
  hub: await import("@/app/account/page"),
  addresses: await import("@/app/account/addresses/page"),
  history: await import("@/app/account/history/page"),
  contributions: await import("@/app/account/contributions/page"),
  alerts: await import("@/app/account/alerts/page"),
  messages: await import("@/app/account/messages/page"),
} as const;
type PageKey = keyof typeof PAGES;

const P_TOTE = "prod_canvas-tote-bag"; // stock 42
const P_PINS = "prod_enamel-pin-set"; // stock 100: per-line cap 99 is the binding limit
const P_SKILLET = "prod_cast-iron-skillet"; // stock 30
const P_WITHDRAWN = "prod_cork-yoga-mat"; // unpublished between add-to-cart and sign-up

const EMAIL = "zulu.journey@example.test";
const DISPLAY_NAME = "Zulu Journey Name";
const REVIEW_NAME = "Zulu Reviewer";
const REVIEW_TITLE = "Journey review Zulu";
const ADDRESS_NAME = "Zulu Addressee";
const ADDRESS_LINE = "12 Zulu Road";
const QUESTION_BODY = "Zulu question about the strap length?";

const capture = consoleCapture();
const secrets = new SecretRegistry();
secrets.add(PASSWORD);
const hasher = fastHasher();
const g = globalThis as typeof globalThis & {
  __storefrontAuthService?: { db: unknown; service: unknown };
  __storefrontAccountService?: { db: unknown; service: unknown };
};

let db: import("bun:sqlite").Database;
let jar1 = new QaCookieStore();
let jar2 = new QaCookieStore();
let G1 = "";
let G2 = "";
let KA = "";
let userId = "";
let guestQuestionIds: string[] = [];
let bystanderAnswerId = "";
let orderId = "";
const markups: string[] = [];

beforeAll(() => {
  db = getDatabase();
  seedDatabase(db);
  const auth = createAuthService({ db, hasher, limiter: getRateLimiter() });
  g.__storefrontAuthService = { db, service: auth };
  const repo = createAuthRepository(db);
  g.__storefrontAccountService = {
    db,
    service: createAccountService({
      db,
      verifyPassword: (id, pw, now) => getAuthService().verifyPassword(id, pw, now),
      hashPassword: (pw) => hasher.hash(pw),
      validatePassword,
      revokeOthers: (id, keep, now) => repo.revokeOthers(id, keep, now),
    }),
  };
});

afterAll(() => {
  capture.restore();
  delete g.__storefrontAuthService;
  delete g.__storefrontAccountService;
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

/** Runs an action on `jar` (it becomes the request's cookie store); returns the state or `{ redirect }`. */
async function act<S>(jar: QaCookieStore, run: () => Promise<S>): Promise<S | { redirect: string }> {
  store = jar;
  try {
    return await run();
  } catch (e) {
    if (e instanceof RedirectSentinel) return { redirect: e.url };
    throw e;
  }
}

async function page(jar: QaCookieStore, key: PageKey): Promise<{ html: string; text: string; doc: Document }> {
  store = jar;
  const html = renderToStaticMarkup(await PAGES[key].default());
  markups.push(html);
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
  return { html, text: (doc.body.textContent ?? "").replace(/\s+/g, " "), doc };
}

function ok(state: unknown): boolean {
  return (state as { ok?: unknown } | null)?.ok === true;
}

function errCode(state: unknown): string | undefined {
  return (state as { error?: { code?: string } } | null)?.error?.code;
}

function cartLines(key: string): Record<string, number> {
  const rows = db.query("SELECT product_id, quantity FROM cart_items WHERE cart_session_id = ? ORDER BY product_id").all(key) as {
    product_id: string;
    quantity: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.product_id, r.quantity]));
}

function lastSet(jar: QaCookieStore, name: string): string | undefined {
  const sets = jar.setsOf(name);
  return sets[sets.length - 1]?.value;
}

describe("criterion 4: two-jar journey (guest -> sign-up merge -> sign-out -> sign-in jar 2 -> sign-out-everywhere -> delete)", () => {
  test(
    "J-01a guest on jar 1: add to cart (+ a line later withdrawn), review, address, question; guest hub shows the counts",
    async () => {
      jar1 = new QaCookieStore();
      const added = await act(jar1, () => addToCart(null, form({ productId: P_TOTE, quantity: "2" })));
      expect(ok(added)).toBe(true);
      G1 = lastSet(jar1, "sf_session") as string;
      expect(G1).toMatch(/^[0-9a-f-]{36}$/);
      secrets.addOwnerKey(G1);
      jar1 = jar1.next();
      expect(ok(await act(jar1, () => addToCart(null, form({ productId: P_PINS, quantity: "60" }))))).toBe(true);
      jar1 = jar1.next();
      expect(ok(await act(jar1, () => addToCart(null, form({ productId: P_WITHDRAWN, quantity: "1" }))))).toBe(true);
      jar1 = jar1.next();
      const review = await act(jar1, () =>
        submitReview(
          null,
          form({
            productId: P_TOTE,
            productSlug: "canvas-tote-bag",
            rating: "5",
            title: REVIEW_TITLE,
            body: "Sturdy stitching, roomy, and it survived a rainy week of commuting.",
            displayName: REVIEW_NAME,
          }),
        ),
      );
      expect(ok(review)).toBe(true);
      jar1 = jar1.next();
      const address = await act(jar1, () =>
        saveAddress(
          null,
          form({ fullName: ADDRESS_NAME, line1: ADDRESS_LINE, line2: "", city: "Portland", region: "OR", postalCode: "97201", country: "US", phone: "555-0100" }),
        ),
      );
      expect(ok(address)).toBe(true);
      jar1 = jar1.next();
      const asked = await act(jar1, () => askQuestion(null, form({ productId: P_TOTE, productSlug: "canvas-tote-bag", body: QUESTION_BODY, displayName: REVIEW_NAME })));
      expect(ok(asked)).toBe(true);
      jar1 = jar1.next();
      // Fixture: a paid order + question + answer + contact message for G1 (checkout journey is T111b's).
      ({ orderId } = seedOrderAndQa(db, G1, "Zulu"));
      guestQuestionIds = (db.query("SELECT id FROM questions WHERE session_id = ?").all(G1) as { id: string }[]).map((r) => r.id);
      expect(guestQuestionIds).toHaveLength(2);
      // A bystander answers the guest's question (R-7: it must survive the later deletion).
      bystanderAnswerId = uuid();
      db.query("INSERT INTO answers (id, question_id, session_id, display_name, body) VALUES (?, ?, ?, 'Bystander', 'Bystander answer text')").run(
        bystanderAnswerId,
        guestQuestionIds[0] as string,
        uuid(),
      );
      // The withdrawn product is unpublished after it went into the cart (R-CART-1 on merge).
      db.query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(P_WITHDRAWN);

      const hub = await page(jar1, "hub");
      expect(hub.text).toContain(GUEST_NOTICE_TEXT);
      expect(hub.text).toContain("1 order");
      expect(hub.text).toContain("1 saved address");
      expect(hub.text).toContain("1 review, 2 questions");
      expect(jar1.setCalls).toEqual([]);
    },
    30_000,
  );

  test(
    "J-01b sign-up on jar 1 merges cart, review, address, order, questions into the new owner key; withdrawn line dropped",
    async () => {
      const before = jar1;
      const r = await act(jar1, () => signUp(null, form({ email: EMAIL, password: PASSWORD, displayName: DISPLAY_NAME })));
      expect(r).toEqual({ redirect: "/account" });
      const token = lastSet(before, "sf_auth") as string;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      secrets.add(token);
      const rotated = lastSet(before, "sf_session");
      expect(rotated).toBeDefined();
      expect(rotated).not.toBe(G1);
      const user = db.query("SELECT id, owner_key FROM users WHERE email = ?").get(EMAIL) as { id: string; owner_key: string };
      KA = user.owner_key;
      userId = user.id;
      secrets.addOwnerKey(KA);
      secrets.add(userId);
      secrets.harvest(db);
      expect(rotated).not.toBe(KA);

      expect(zeroCounts(counts(db, G1))).toBe(true);
      expect(cartLines(KA)).toEqual({ [P_PINS]: 60, [P_TOTE]: 2 });
      expect(cartLines(G1)).toEqual({});
      expect((db.query("SELECT COUNT(*) n FROM reviews WHERE session_id = ? AND title = ?").get(KA, REVIEW_TITLE) as { n: number }).n).toBe(1);
      expect((db.query("SELECT COUNT(*) n FROM addresses WHERE session_id = ? AND line1 = ?").get(KA, ADDRESS_LINE) as { n: number }).n).toBe(1);
      expect((db.query("SELECT session_id FROM orders WHERE id = ?").get(orderId) as { session_id: string }).session_id).toBe(KA);
      expect((db.query("SELECT COUNT(*) n FROM questions WHERE session_id = ?").get(KA) as { n: number }).n).toBe(2);

      jar1 = jar1.next();
      expect(jar1.has("sf_auth")).toBe(true);
      const hub = await page(jar1, "hub");
      expect(hub.text).toContain(`Hello, ${DISPLAY_NAME}`);
      expect(hub.text).not.toContain(GUEST_NOTICE_TEXT);
      expect(hub.text).toContain("1 order");
      expect(hub.text).toContain("1 saved address");
      expect(hub.text).toContain("1 review, 2 questions");
      expect((await page(jar1, "addresses")).text).toContain(ADDRESS_NAME);
      expect((await page(jar1, "contributions")).text).toContain(REVIEW_TITLE);
      expect(jar1.setCalls).toEqual([]);
    },
    30_000,
  );

  test(
    "J-02 sign-out on jar 1: sf_auth cleared, new sf_session, guest cart empty, guest hub",
    async () => {
      const before = jar1;
      const previousGuest = before.jar.get("sf_session");
      const r = await act(jar1, () => signOut(null, form({})));
      expect(r).toEqual({ redirect: "/" });
      expect(before.isCleared("sf_auth")).toBe(true);
      const fresh = lastSet(before, "sf_session") as string;
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(previousGuest);
      expect(fresh).not.toBe(KA);
      expect(fresh).not.toBe(G1);
      jar1 = jar1.next();
      expect(jar1.has("sf_auth")).toBe(false);
      store = jar1;
      expect(await readSessionId()).toBe(fresh);
      expect(getCartService().getCart(fresh).itemCount).toBe(0);
      const hub = await page(jar1, "hub");
      expect(hub.text).toContain(GUEST_NOTICE_TEXT);
      expect(hub.text).toContain("No orders yet");
      expect(hub.html).not.toContain(DISPLAY_NAME);
      expect(hub.html).not.toContain(EMAIL);
    },
    30_000,
  );

  test(
    "J-03 jar 2: guest adds pins x60 + skillet, signs in: cart merged (pins capped at 99), review/address/order visible",
    async () => {
      jar2 = new QaCookieStore();
      expect(ok(await act(jar2, () => addToCart(null, form({ productId: P_PINS, quantity: "60" }))))).toBe(true);
      G2 = lastSet(jar2, "sf_session") as string;
      secrets.addOwnerKey(G2);
      jar2 = jar2.next();
      expect(ok(await act(jar2, () => addToCart(null, form({ productId: P_SKILLET, quantity: "1" }))))).toBe(true);
      jar2 = jar2.next();
      const before = jar2;
      const r = await act(jar2, () => signIn(null, form({ email: EMAIL.toUpperCase(), password: PASSWORD })));
      expect(r).toEqual({ redirect: "/account" });
      secrets.add(lastSet(before, "sf_auth"));
      secrets.harvest(db);
      expect(lastSet(before, "sf_session")).not.toBe(G2);
      expect(zeroCounts(counts(db, G2))).toBe(true);
      expect(cartLines(KA)).toEqual({ [P_PINS]: 99, [P_SKILLET]: 1, [P_TOTE]: 2 });
      jar2 = jar2.next();

      const hub = await page(jar2, "hub");
      expect(hub.text).toContain(`Hello, ${DISPLAY_NAME}`);
      expect(hub.text).toContain("1 order");
      expect(hub.text).toContain("1 saved address");
      expect(hub.text).toContain("1 review, 2 questions");
      expect((await page(jar2, "addresses")).text).toContain(ADDRESS_LINE);
      const contributions = await page(jar2, "contributions");
      expect(contributions.text).toContain(REVIEW_TITLE);
      expect(contributions.text).toContain(QUESTION_BODY);
      store = jar2;
      expect(await readSessionId()).toBe(KA);
      expect(getCartService().getCart(KA).itemCount).toBe(102);
      expect(jar2.setCalls).toEqual([]);
    },
    30_000,
  );

  test(
    "J-04 sign-out-everywhere on jar 2 invalidates jar 1 (jar 1 renders the guest hub; its actions are UNAUTHENTICATED)",
    async () => {
      const r1 = await act(jar1, () => signIn(null, form({ email: EMAIL, password: PASSWORD })));
      expect(r1).toEqual({ redirect: "/account" });
      secrets.add(lastSet(jar1, "sf_auth"));
      jar1 = jar1.next();
      expect((await page(jar1, "hub")).text).toContain(`Hello, ${DISPLAY_NAME}`);

      const before2 = jar2;
      const r2 = await act(jar2, () => signOutEverywhere(null, form({})));
      expect(r2).toEqual({ redirect: "/" });
      expect(before2.isCleared("sf_auth")).toBe(true);
      jar2 = jar2.next();
      jar1 = jar1.next();
      expect(jar1.has("sf_auth")).toBe(true); // the stale cookie stays in jar 1 (read paths never clear it, R-8)
      const live = db.query("SELECT COUNT(*) n FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL").get(userId) as { n: number };
      expect(live.n).toBe(0);

      for (const key of Object.keys(PAGES) as PageKey[]) {
        const p = await page(jar1, key);
        expect(p.html).not.toContain(DISPLAY_NAME);
        expect(p.html).not.toContain(ADDRESS_LINE);
        expect(p.html).not.toContain(REVIEW_TITLE);
        expect(jar1.setCalls).toEqual([]);
      }
      expect((await page(jar1, "hub")).text).toContain(GUEST_NOTICE_TEXT);
      expect((await page(jar2, "hub")).text).toContain(GUEST_NOTICE_TEXT);
      const denied = await act(jar1, () => updateProfile(null, form({ displayName: "Hijacked Name" })));
      expect(errCode(denied)).toBe("UNAUTHENTICATED");
      expect((db.query("SELECT display_name FROM users WHERE id = ?").get(userId) as { display_name: string }).display_name).toBe(DISPLAY_NAME);
    },
    30_000,
  );

  test(
    "J-05 delete account (R-7): pages render as guest, content anonymised '[deleted]', no PII or owner key left",
    async () => {
      jar1 = jar1.next();
      const signedIn = await act(jar1, () => signIn(null, form({ email: EMAIL, password: PASSWORD })));
      expect(signedIn).toEqual({ redirect: "/account" });
      secrets.add(lastSet(jar1, "sf_auth"));
      secrets.harvest(db);
      jar1 = jar1.next();
      const before = jar1;
      const r = await act(jar1, () => deleteAccount(null, form({ password: PASSWORD, confirm: "DELETE" })));
      expect(r).toEqual({ redirect: "/" });
      expect(before.isCleared("sf_auth")).toBe(true);
      jar1 = jar1.next();

      // Pages for that browser render as guest, with none of the user's data.
      for (const key of Object.keys(PAGES) as PageKey[]) {
        const p = await page(jar1, key);
        for (const s of [DISPLAY_NAME, EMAIL, ADDRESS_LINE, ADDRESS_NAME, REVIEW_TITLE, QUESTION_BODY]) expect(p.html).not.toContain(s);
      }
      expect((await page(jar1, "hub")).text).toContain(GUEST_NOTICE_TEXT);

      // Owner-keyed tables: nothing left under KA (orders + redemptions moved to the tombstone).
      expect(zeroCounts(counts(db, KA))).toBe(true);
      expect((db.query("SELECT COUNT(*) n FROM users WHERE id = ? OR email = ?").get(userId, EMAIL) as { n: number }).n).toBe(0);
      expect((db.query("SELECT COUNT(*) n FROM auth_sessions WHERE user_id = ?").get(userId) as { n: number }).n).toBe(0);
      // Reviews deleted; questions/answers by the user anonymised but kept; bystander answer survives.
      expect((db.query("SELECT COUNT(*) n FROM reviews WHERE title = ?").get(REVIEW_TITLE) as { n: number }).n).toBe(0);
      const qs = db.query(`SELECT session_id, body, display_name FROM questions WHERE id IN (${guestQuestionIds.map(() => "?").join(",")})`).all(...guestQuestionIds) as {
        session_id: string;
        body: string;
        display_name: string;
      }[];
      expect(qs).toHaveLength(2);
      for (const q of qs) expect(q).toEqual({ session_id: TOMBSTONE, body: "[deleted]", display_name: "[deleted]" });
      const bystander = db.query("SELECT body, display_name FROM answers WHERE id = ?").get(bystanderAnswerId) as { body: string; display_name: string };
      expect(bystander).toEqual({ body: "Bystander answer text", display_name: "Bystander" });
      const order = db.query("SELECT session_id, full_name, email, line1, phone FROM orders WHERE id = ?").get(orderId) as Record<string, unknown>;
      expect(order.session_id).toBe(TOMBSTONE);
      expect(order.full_name).toBe("[deleted]");
      expect(order.email).toBe("[deleted]");
      expect(order.line1).toBe("[deleted]");

      // No PII anywhere in the database; owner key / user id only possibly in rate_limits keys.
      const dump = JSON.stringify(fullSnapshot(db, ["rate_limits"]));
      for (const pii of [EMAIL, DISPLAY_NAME, REVIEW_NAME, ADDRESS_NAME, ADDRESS_LINE, QUESTION_BODY, "o@o.test", "c@c.test", KA, userId]) {
        expect({ pii, found: dump.includes(pii) }).toEqual({ pii, found: false });
      }
      for (const [table, col] of Object.entries(OWNER_TABLES)) {
        expect({ table, n: (db.query(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = ?`).get(KA) as { n: number }).n }).toEqual({ table, n: 0 });
      }
      const limiterRows = db.query("SELECT key FROM rate_limits").all() as { key: string }[];
      for (const row of limiterRows) {
        expect(row.key).not.toContain(EMAIL);
        expect(row.key).not.toContain("@");
      }
    },
    30_000,
  );

  test(
    "criterion 5: no secret (password, hash, token, token hash, user id, owner key) in any rendered page or console line",
    () => {
      expect(markups.length).toBeGreaterThan(10);
      for (const html of markups) expect(secrets.find(html, true)).toEqual([]);
      const joined = capture.lines.join("\n");
      expect(secrets.find(joined, true)).toEqual([]);
      expect(joined).not.toContain(EMAIL);
    },
    30_000,
  );
});
