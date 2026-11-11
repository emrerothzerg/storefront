import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// T122 QA criterion 4: cross-user isolation matrix through ACTION entry points
// (PLAN.md section 1 protocol, rows 1-15, 6 ordered pairs of G/A/B) + I-00
// discovery guard + A-31/A-40/A-65 at the action level.
// Real `'use server'` wrappers, real session resolution (sf_auth -> owner key),
// real services over one :memory: app DB. next/* mocked process-wide.
// ---------------------------------------------------------------------------

import { QaCookieStore, RedirectSentinel } from "./_fixtures";

let store = new QaCookieStore();
const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
const redirect = mock((url: string): never => {
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/headers", () => ({
  cookies: async (): Promise<QaCookieStore> => store,
  headers: async (): Promise<Headers> => new Headers({ "user-agent": "qa" }),
}));
mock.module("next/navigation", () => ({ ...realNavigation, redirect }));
mock.module("next/cache", () => ({ revalidatePath, revalidateTag: () => undefined, updateTag: () => undefined }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
closeDatabase();
const cart = await import("@/app/actions/cart");
const lists = await import("@/app/actions/lists");
const reviews = await import("@/app/actions/reviews");
const questions = await import("@/app/actions/questions");
const addresses = await import("@/app/actions/addresses");
const views = await import("@/app/actions/views");
const alerts = await import("@/app/actions/stock-alerts");
const contact = await import("@/app/actions/contact");
const { readSessionId } = await import("@/server/session/session");
const { seedDatabase } = await import("@/server/db/seed");
const { createAuthService } = await import("@/server/auth/auth-service");
const { OWNER_KEYED_TABLES } = await import("@/server/auth/account-repository");
const { getCartService } = await import("@/server/cart/cart-service");
const { getListService } = await import("@/server/lists/list-service");
const { getReviewService } = await import("@/server/reviews/review-service");
const { getQaService } = await import("@/server/qa/qa-service");
const { getAddressService } = await import("@/server/addresses/address-service");
const { getStockAlertService } = await import("@/server/alerts/stock-alert-service");
const { getContactService } = await import("@/server/contact/contact-service");
const { getOrderService } = await import("@/server/orders/order-service");
const { getRecommendationService } = await import("@/server/recommendations/recommendation-service");
const { ok } = await import("@/lib/result");
const fx = await import("./_fixtures");
const { OWNER_TABLES, PASSWORD, discoverOwnerTables, fastHasher, form, seedIdentity, snapshot, counts, uuid } = fx;
type IdentityRows = import("./_fixtures").IdentityRows;

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

interface Identity {
  readonly name: "G" | "A" | "B";
  readonly key: string;
  readonly userId: string | null;
  readonly cookies: Record<string, string>;
  readonly rows: IdentityRows;
  readonly tag: string;
}

const ids: Record<"G" | "A" | "B", Identity> = {} as Record<"G" | "A" | "B", Identity>;

beforeAll(async () => {
  const db = getDatabase();
  seedDatabase(db);
  const auth = createAuthService({ db, hasher: fastHasher(), limiter: { check: () => ok({ remaining: 99 }) } });
  const a = await auth.signUp({ email: "a@iso.test", password: PASSWORD, displayName: "Alice" }, { sessionKey: uuid() });
  const b = await auth.signUp({ email: "b@iso.test", password: PASSWORD, displayName: "Bob" }, { sessionKey: uuid() });
  if (!a.ok || !b.ok) throw new Error("users");
  const G = uuid();
  ids.G = { name: "G", key: G, userId: null, cookies: { sf_session: G }, rows: seedIdentity(db, G, { tag: "qgst", slot: 1 }), tag: "qgst" };
  ids.A = {
    name: "A",
    key: a.value.user.ownerKey,
    userId: a.value.user.id,
    cookies: { sf_auth: a.value.token, sf_session: uuid() },
    rows: seedIdentity(db, a.value.user.ownerKey, { tag: "qals", slot: 2 }),
    tag: "qals",
  };
  ids.B = {
    name: "B",
    key: b.value.user.ownerKey,
    userId: b.value.user.id,
    cookies: { sf_auth: b.value.token },
    rows: seedIdentity(db, b.value.user.ownerKey, { tag: "qbob", slot: 3 }),
    tag: "qbob",
  };
});

function as(x: Identity): void {
  store = new QaCookieStore(x.cookies);
}

async function act(p: Promise<unknown>): Promise<unknown> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof RedirectSentinel) return { redirect: e.url };
    throw e;
  }
}

function code(s: unknown): string | undefined {
  return (s as { error?: { code?: string } } | null)?.error?.code;
}

const NOT_FOUND_FAMILY = new Set(["NOT_FOUND", "LIST_NOT_FOUND", "ORDER_NOT_FOUND", "PRODUCT_NOT_FOUND"]);
const PAIRS: ["G" | "A" | "B", "G" | "A" | "B"][] = [
  ["G", "A"],
  ["G", "B"],
  ["A", "G"],
  ["A", "B"],
  ["B", "G"],
  ["B", "A"],
];

describe("I-00 discovery guard", () => {
  test("every table with session_id / cart_session_id is in the PLAN matrix and in OWNER_KEYED_TABLES", () => {
    const found = discoverOwnerTables(getDatabase());
    expect(found).toEqual(Object.keys(OWNER_TABLES).sort());
    expect(found).toEqual(Object.keys(OWNER_KEYED_TABLES).sort());
  });
});

describe("Read protocol: each jar resolves to its own key and reads only its own rows", () => {
  const reads: [string, (key: string) => unknown, (r: IdentityRows) => unknown][] = [
    ["cart", (k) => {
      const v = getCartService().getCartView(k);
      return v.ok ? v.value.items.map((l) => l.productId).sort() : v;
    }, (r) => [r.cartProduct]],
    ["lists", (k) => getListService().listLists(k).map((l) => l.id).sort(), (r) => [r.defaultListId, r.sflListId].sort()],
    ["reviews", (k) => getReviewService().listMine(k).map((r) => r.id), (r) => [r.reviewId]],
    ["qa", (k) => {
      const m = getQaService().listMine(k);
      return { q: m.questions.map((q) => q.id), a: m.answers.map((a) => a.id) };
    }, (r) => ({ q: [r.questionId], a: [r.answerId] })],
    ["addresses", (k) => getAddressService().list(k).map((a) => a.id), (r) => [r.addressId]],
    ["alerts", (k) => getStockAlertService().list(k).map((a) => a.id), (r) => [r.alertId]],
    ["contact", (k) => getContactService().listForSession(k).map((c) => c.reference), (r) => [r.contactId]],
    ["orders", (k) => getOrderService().listOrders(k).items.map((o) => o.id), (r) => [r.orderId]],
  ];

  for (const name of ["G", "A", "B"] as const) {
    test(`${name}: readSessionId = own key; every service read returns exactly own ids and no other identity's tags`, async () => {
      const x = ids[name];
      as(x);
      const key = await readSessionId();
      expect(key).toBe(x.key);
      for (const [svc, read, expected] of reads) {
        const got = read(key as string);
        if (svc === "contact") {
          const list = getContactService().listForSession(key as string);
          expect([svc, list.length]).toEqual([svc, 1]);
          expect(JSON.stringify(list)).toContain(x.tag);
        } else {
          expect([svc, got]).toEqual([svc, expected(x.rows)]);
        }
        const json = JSON.stringify(got);
        for (const other of Object.values(ids)) {
          if (other.name === name) continue;
          expect([svc, json.includes(other.key), json.includes(other.tag)]).toEqual([svc, false, false]);
        }
      }
      const recent = getRecommendationService().recentlyViewed(key as string, { limit: 10 } as never).map((p) => p.id);
      for (const other of Object.values(ids)) if (other.name !== name) expect(recent).not.toContain(snapshotView(other));
      expect(store.setCalls).toEqual([]);
    }, 30_000);
  }
});

function snapshotView(x: Identity): string {
  const row = getDatabase().query("SELECT product_id FROM product_views WHERE session_id = ?").get(x.key) as { product_id: string } | null;
  return row?.product_id ?? "";
}

function forged(y: Identity): Record<string, string> {
  return { sessionId: y.key, ownerKey: y.key, userId: y.userId ?? y.key };
}

describe("Write protocol: X's mutating actions on Y's row ids never touch Y (NOT_FOUND family, never FORBIDDEN)", () => {
  for (const [xn, yn] of PAIRS) {
    test(`${xn} -> ${yn}`, async () => {
      const x = ids[xn];
      const y = ids[yn];
      const db = getDatabase();
      const before = snapshot(db, y.key);
      const beforeCounts = counts(db, y.key);
      const yr = y.rows;
      const slug = (pid: string): string => (db.query("SELECT slug FROM products WHERE id = ?").get(pid) as { slug: string }).slug;
      const outcomes: [string, unknown][] = [];
      const call = async (label: string, p: () => Promise<unknown>, byId: boolean): Promise<void> => {
        as(x);
        const s = await act(p());
        outcomes.push([label, s]);
        const c = code(s);
        expect([label, c]).not.toEqual([label, "FORBIDDEN"]);
        if (byId) expect([label, c, NOT_FOUND_FAMILY.has(c ?? "")]).toEqual([label, c, true]);
      };
      const f = (fields: Record<string, string>, withForged = false): FormData => form(withForged ? { ...fields, ...forged(y) } : fields);
      for (const withForged of [false, true]) {
        // cart (row 1/2): Y's cart line product
        await call("cart.updateQuantity", () => cart.updateCartQuantity(null, f({ productId: yr.cartProduct, quantity: "3" }, withForged)), false);
        await call("cart.remove", () => cart.removeFromCart(null, f({ productId: yr.cartProduct }, withForged)), false);
        await call("cart.saveForLater", () => cart.saveForLater(null, f({ productId: yr.cartProduct }, withForged)), false);
        // lists (row 3/4)
        await call("lists.addToList", () => lists.addToList(null, f({ listId: yr.defaultListId, productId: "prod_brass-desk-lamp" }, withForged)), true);
        await call("lists.removeFromList", () => lists.removeFromList(null, f({ listId: yr.defaultListId, productId: yr.cartProduct }, withForged)), true);
        await call("lists.updateListItem", () => lists.updateListItem(null, f({ listId: yr.defaultListId, productId: yr.cartProduct, note: "pwned", priority: "2" }, withForged)), true);
        await call("lists.moveListItem", () => lists.moveListItem(null, f({ listId: yr.defaultListId, toListId: yr.sflListId, productId: yr.cartProduct }, withForged)), true);
        await call("lists.renameList", () => lists.renameList(null, f({ listId: yr.defaultListId, name: "pwned" }, withForged)), true);
        await call("lists.setListSharing", () => lists.setListSharing(null, f({ listId: yr.defaultListId, mode: "enable" }, withForged)), true);
        await call("lists.deleteList", () => lists.deleteList(null, f({ listId: yr.sflListId, confirm: "yes" }, withForged)), true);
        await call("lists.addAllToCart", () => lists.addAllToCart(null, f({ listId: yr.defaultListId }, withForged)), true);
        // addresses (row 14)
        await call("addresses.delete", () => addresses.deleteAddress(null, f({ addressId: yr.addressId, confirm: "yes" }, withForged)), true);
        await call("addresses.setDefault", () => addresses.setDefaultAddress(null, f({ addressId: yr.addressId }, withForged)), true);
        await call(
          "addresses.update",
          () =>
            addresses.saveAddress(
              null,
              f({ addressId: yr.addressId, fullName: "Pwned", line1: "1 Evil St", city: "X", region: "CA", postalCode: "90210", country: "US" }, withForged),
            ),
          true,
        );
        // alerts (row 12)
        await call("alerts.unsubscribe", () => alerts.unsubscribeStockAlert(null, f({ alertId: yr.alertId }, withForged)), true);
        await call("alerts.acknowledge", () => alerts.acknowledgeStockAlert(null, f({ alertId: yr.alertId }, withForged)), true);
        // views (row 5): remove Y's viewed product / clear history only affect X
        const yView = yr.viewProduct;
        await call("views.remove", () => views.removeFromHistory(null, f({ productId: yView, productSlug: slug(yView) }, withForged)), false);
      }
      // clear history last (affects X's own row only)
      as(x);
      await act(views.clearHistory(null, form({ confirm: "yes", ...forged(y) })));

      expect(snapshot(db, y.key)).toEqual(before);
      expect(counts(db, y.key)).toEqual(beforeCounts);
      expect(outcomes.length).toBeGreaterThan(30);
    }, 30_000);
  }
});

describe("Votes, answers, reviews and contact from X are keyed to X, never to Y (rows 6-11, 13)", () => {
  for (const [xn, yn] of PAIRS) {
    test(`${xn} -> ${yn}`, async () => {
      const x = ids[xn];
      const y = ids[yn];
      const db = getDatabase();
      const n = (sql: string, ...p: string[]): number => (db.query(sql).get(...p) as { n: number }).n;
      const yVotes = n("SELECT (SELECT COUNT(*) FROM review_votes WHERE session_id = ?1) + (SELECT COUNT(*) FROM question_votes WHERE session_id = ?1) + (SELECT COUNT(*) FROM answer_votes WHERE session_id = ?1) AS n", y.key);
      const yAnswers = n("SELECT COUNT(*) AS n FROM answers WHERE session_id = ?", y.key);
      const yContact = n("SELECT COUNT(*) AS n FROM contact_messages WHERE session_id = ?", y.key);
      const yReviews = n("SELECT COUNT(*) AS n FROM reviews WHERE session_id = ?", y.key);
      const extra = forged(y);

      as(x);
      const vr = await act(reviews.voteReviewHelpful(null, form({ reviewId: y.rows.reviewId, ...extra })));
      expect(code(vr)).not.toBe("FORBIDDEN");
      as(x);
      await act(questions.voteQuestion(null, form({ questionId: y.rows.questionId, ...extra })));
      as(x);
      await act(questions.voteAnswer(null, form({ answerId: y.rows.answerId, ...extra })));
      as(x);
      await act(questions.answerQuestion(null, form({ questionId: y.rows.questionId, body: `Answer from ${x.name} to ${y.name} ${uuid()}`, displayName: "X", ...extra })));
      as(x);
      await act(
        contact.sendContactMessage(null, form({ name: "X", email: "x@iso.test", topic: "other", message: `Hello ${x.name}->${y.name} ${uuid()}`, ...extra })),
      );
      as(x);
      await act(reviews.submitReview(null, form({ productId: y.rows.reviewProduct, rating: "5", title: "t", body: `review ${uuid()}`, displayName: "X", ...extra })));

      expect(n("SELECT (SELECT COUNT(*) FROM review_votes WHERE session_id = ?1) + (SELECT COUNT(*) FROM question_votes WHERE session_id = ?1) + (SELECT COUNT(*) FROM answer_votes WHERE session_id = ?1) AS n", y.key)).toBe(yVotes);
      expect(n("SELECT COUNT(*) AS n FROM answers WHERE session_id = ?", y.key)).toBe(yAnswers);
      expect(n("SELECT COUNT(*) AS n FROM contact_messages WHERE session_id = ?", y.key)).toBe(yContact);
      expect(n("SELECT COUNT(*) AS n FROM reviews WHERE session_id = ?", y.key)).toBe(yReviews);
      // X's own rows carry X's key
      expect(n("SELECT COUNT(*) AS n FROM review_votes WHERE session_id = ? AND review_id = ?", x.key, y.rows.reviewId)).toBe(1);
      expect(n("SELECT COUNT(*) AS n FROM contact_messages WHERE session_id = ? AND message LIKE ?", x.key, `Hello ${x.name}->${y.name}%`)).toBe(1);
      // Nothing was ever written under a key that is not one of the three identities (except seeded data)
      const strangers = n(
        `SELECT COUNT(*) AS n FROM (
           SELECT session_id FROM review_votes UNION ALL SELECT session_id FROM answers UNION ALL SELECT session_id FROM contact_messages
         ) WHERE session_id NOT IN (?, ?, ?) AND session_id NOT LIKE 'seed_%' AND session_id IS NOT NULL`,
        ids.G.key,
        ids.A.key,
        ids.B.key,
      );
      expect(strangers).toBe(0);
    }, 30_000);
  }
});

describe("A-31 / A-40 at the action level", () => {
  test("A-40 (R-1): sf_session = KA without sf_auth -> cart/list actions never reach A's rows; a fresh guest id is minted", async () => {
    const A = ids.A;
    const before = snapshot(getDatabase(), A.key);
    store = new QaCookieStore({ sf_session: A.key });
    const r = await act(cart.addToCart(null, form({ productId: "prod_brass-desk-lamp", quantity: "1" })));
    expect(code(r)).toBeUndefined();
    const minted = store.setsOf("sf_session").at(-1)?.value;
    expect(minted).toBeDefined();
    expect(minted).not.toBe(A.key);
    store = new QaCookieStore({ sf_session: A.key });
    await act(lists.removeFromList(null, form({ listId: A.rows.defaultListId, productId: A.rows.cartProduct })));
    await act(addresses.deleteAddress(null, form({ addressId: A.rows.addressId, confirm: "yes" })));
    expect(snapshot(getDatabase(), A.key)).toEqual(before);
    expect(await readSessionId()).toBeNull();
  });

  test("A-31: an attacker holding a stale guest id that was merged reads nothing of the account", async () => {
    store = new QaCookieStore({ sf_session: uuid() });
    const key = await readSessionId();
    const view = getCartService().getCartView(key as string);
    expect(view.ok && view.value.items).toEqual([]);
    expect(getOrderService().listOrders(key as string).items).toEqual([]);
  });
});
