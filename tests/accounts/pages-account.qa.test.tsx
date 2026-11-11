import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// T129b QA: account hub pages (T98) + AccountHub (T87) + header greeting (T80).
// PLAN.md 3.11 P-06 / U-01 / U-02 / A-93 / A-94, T129 criteria 1, 2, 5, 6 for
// the six pages under src/app/account (settings excluded: T129a).
//
// The page functions run against the app DB (DATABASE_PATH=:memory:, the real
// getXService() singletons) with mocked next/*: the cookie store is the QA
// cookie jar, `redirect` throws a sentinel and `notFound` fails the test.
// Structural checks parse `renderToStaticMarkup` output with DOMParser.
// ---------------------------------------------------------------------------

import { QaCookieStore, RedirectSentinel } from "./_fixtures";

let store = new QaCookieStore();
const realHeaders = { ...(await import("next/headers")) };
const realCache = { ...(await import("next/cache")) };
const realNavigation = { ...(await import("next/navigation")) };
const notFoundCalls: string[] = [];
mock.module("next/headers", () => ({
  ...realHeaders,
  cookies: async (): Promise<QaCookieStore> => store,
  headers: async (): Promise<Headers> => new Headers({ "user-agent": "qa-pages/1.0" }),
}));
mock.module("next/cache", () => ({ ...realCache, revalidatePath: () => undefined }));
mock.module("next/navigation", () => ({
  ...realNavigation,
  redirect: (url: string): never => {
    throw new RedirectSentinel(url);
  },
  notFound: (): never => {
    notFoundCalls.push("notFound");
    throw new Error("unexpected notFound()");
  },
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const dbClient = await import("@/server/db/client");
dbClient.closeDatabase();
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const currentUser = await import("@/server/session/current-user");
const { getAuthService } = await import("@/server/auth/auth-service");
const { createAuthRepository } = await import("@/server/auth/auth-repository");
const { isAllowedInternalHref } = await import("@/content/routes");
const { GUEST_NOTICE_TEXT, AccountHub } = await import("@/components/organisms/AccountHub");
const { DepartmentMenu } = await import("@/components/molecules/DepartmentMenu");
const { HeaderShell } = await import("@/app/_layout/HeaderShell");
const headerActions = await import("@/app/_layout/header-actions");
const authActions = await import("@/app/actions/auth");
const alertActions = await import("@/app/actions/stock-alerts");
const addressActions = await import("@/app/actions/addresses");
const viewActions = await import("@/app/actions/views");
const reviewActions = await import("@/app/actions/reviews");
const { ADDRESS_FIELD } = await import("@/components/molecules/_contracts/address-actions");
const { VIEW_FIELD, CLEAR_HISTORY_CONFIRM_VALUE } = await import("@/components/molecules/_contracts/view-actions");
const { STOCK_ALERT_FIELD } = await import("@/components/molecules/_contracts/stock-alert-actions");
const { AUTH_FIELD } = await import("@/components/molecules/_contracts/auth-actions");
const fx = await import("./_fixtures");
const { SecretRegistry, consoleCapture, fullSnapshot, seedIdentity, sha256hex, uuid, OUT_OF_STOCK } = fx;

const PAGE_MODULES = {
  hub: await import("@/app/account/page"),
  addresses: await import("@/app/account/addresses/page"),
  history: await import("@/app/account/history/page"),
  contributions: await import("@/app/account/contributions/page"),
  alerts: await import("@/app/account/alerts/page"),
  messages: await import("@/app/account/messages/page"),
} as const;
type PageKey = keyof typeof PAGE_MODULES;
const PAGE_KEYS = Object.keys(PAGE_MODULES) as PageKey[];

const PAGE_TITLES: Readonly<Record<PageKey, string>> = {
  hub: "Your Account",
  addresses: "Your Addresses",
  history: "Browsing History",
  contributions: "Your Reviews & Questions",
  alerts: "Stock Alerts",
  messages: "Messages",
};

// ---------------------------------------------------------------------------
// Spies (restored in afterAll)
// ---------------------------------------------------------------------------

const capture = consoleCapture();
const secrets = new SecretRegistry();
const getOrCreateSpy = spyOn(session, "getOrCreateSessionId");
const rotateSpy = spyOn(session, "rotateGuestSession");
const readOwnerAndUserSpy = spyOn(currentUser, "readOwnerAndUser");

// ---------------------------------------------------------------------------
// Fixture: guest G, users A and B (one row per owner-keyed table each), a
// hostile-name user H, plus A-only rows: a hidden review, a hidden question,
// a back-in-stock alert. Tags contain no hex runs.
// ---------------------------------------------------------------------------

interface UserFixture {
  readonly id: string;
  readonly key: string;
  readonly token: string;
  readonly email: string;
  readonly displayName: string;
}

const HOSTILE_IMG = "<img src=x onerror=alert(1)>";
const RTL_50 = "ש".repeat(50);
const BIDI_NAME = "Mallory ‮gnp.exe‬ Quinn";
const C1_NAME = "Victor\u0085\u009B Ivy\u0090";

let db: import("bun:sqlite").Database;
let G = "";
let A: UserFixture;
let B: UserFixture;
let rowsG: import("./_fixtures").IdentityRows;
let rowsA: import("./_fixtures").IdentityRows;
let rowsB: import("./_fixtures").IdentityRows;
let aBackInStockAlertId = "";
let aHiddenReviewId = "";
let aHiddenQuestionId = "";
let authSpy: ReturnType<typeof spyOn<ReturnType<typeof getAuthService>, "resolveToken">>;

const PASSWORD_HASH_TEXT = "$argon2id$v=19$m=65536,t=2,p=1$qaSaltQAqa$qaStoredHashValueForPagesQA";

function makeUser(displayName: string, email: string): UserFixture {
  const repo = createAuthRepository(db);
  const created = repo.createUser({ email, passwordHash: PASSWORD_HASH_TEXT, displayName });
  if (!created.ok) throw new Error(`createUser failed: ${created.error.code}`);
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const s = repo.createAuthSession(
    { userId: created.value.id, tokenHash: sha256hex(token), expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString() },
    Date.now(),
  );
  if (!s.ok) throw new Error(`createAuthSession failed: ${s.error.code}`);
  secrets.add(token, sha256hex(token), created.value.id);
  secrets.addOwnerKey(created.value.ownerKey);
  return { id: created.value.id, key: created.value.ownerKey, token, email: created.value.email, displayName };
}

/** Browser cookies for one persona. */
type Persona = "none" | "garbage" | "unknownAuth" | "r1" | "guestG" | "userA" | "userB";
const GUESTISH: readonly Persona[] = ["none", "garbage", "unknownAuth", "r1"];

function cookiesFor(p: Persona): Record<string, string> {
  switch (p) {
    case "none":
      return {};
    case "garbage":
      return { sf_session: "not-a-session", sf_auth: "garbage" };
    case "unknownAuth":
      // Well-formed (43 b64url chars) but unknown token + garbage guest id.
      return { sf_auth: "Q".repeat(43), sf_session: "ZZZZ-not-a-uuid" };
    case "r1":
      // R-1: a guest cookie equal to A's owner key, no sf_auth.
      return { sf_session: A.key };
    case "guestG":
      return { sf_session: G };
    case "userA":
      return { sf_auth: A.token, sf_session: uuid() };
    case "userB":
      return { sf_auth: B.token };
  }
}

function browse(p: Persona): QaCookieStore {
  store = new QaCookieStore(cookiesFor(p));
  return store;
}

async function renderPage(key: PageKey): Promise<string> {
  const element = await PAGE_MODULES[key].default();
  return renderToStaticMarkup(element);
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function uuidsIn(html: string): string[] {
  return [...new Set((html.match(UUID_RE) ?? []).map((u) => u.toLowerCase()))];
}

function text(doc: Document): string {
  return (doc.body.textContent ?? "").replace(/\s+/g, " ");
}

/** Text tags + ids that belong to `owner` (must never show for another owner). */
function ownedStrings(rows: import("./_fixtures").IdentityRows, tag: string): string[] {
  return [
    `Wish ${tag}`,
    `Title ${tag}`,
    `Body ${tag}`,
    `Question ${tag}`,
    `Message ${tag}`,
    `Addr ${tag}`,
    `Main St ${tag}`,
    `Order ${tag}`,
    `${tag}@order.test`,
    `${tag}@contact.test`,
    `Contact ${tag}`,
    rows.alertId,
    rows.addressId,
    rows.reviewId,
    rows.questionId,
    rows.answerId,
    rows.orderId,
    rows.contactId,
  ];
}

const TAG = { G: "Gulf", A: "Kilo", B: "Romeo" } as const;

beforeAll(() => {
  db = dbClient.getDatabase();
  seedDatabase(db);
  const now = Date.now();
  A = makeUser("Kilo Person", "kilo.person@example.test");
  B = makeUser("Romeo Person", "romeo.person@example.test");
  G = uuid();
  secrets.addOwnerKey(G);
  rowsG = seedIdentity(db, G, { tag: TAG.G, slot: 0, now });
  rowsA = seedIdentity(db, A.key, { tag: TAG.A, slot: 1, now });
  rowsB = seedIdentity(db, B.key, { tag: TAG.B, slot: 2, now });
  // A-only extras: hidden review + hidden question (Not published badges), back-in-stock alert.
  const at = new Date(now - 60_000).toISOString();
  aHiddenReviewId = uuid();
  db.query(
    `INSERT INTO reviews (id, product_id, session_id, display_name, rating, title, body, status, created_at, updated_at)
     VALUES (?, 'prod_gooseneck-kettle', ?, 'Name Kilo', 2, 'Hidden title Kilo', 'Hidden body Kilo is moderated.', 'hidden', ?, ?)`,
  ).run(aHiddenReviewId, A.key, at, at);
  aHiddenQuestionId = uuid();
  db.query(
    `INSERT INTO questions (id, product_id, session_id, display_name, body, status, created_at)
     VALUES (?, 'prod_gooseneck-kettle', ?, 'Name Kilo', 'Hidden question Kilo?', 'hidden', ?)`,
  ).run(aHiddenQuestionId, A.key, at);
  aBackInStockAlertId = uuid();
  db.query("INSERT INTO stock_alerts (id, product_id, session_id, created_at) VALUES (?, 'prod_walnut-desk', ?, ?)").run(
    aBackInStockAlertId,
    A.key,
    at,
  );
  secrets.harvest(db);
  const auth = getAuthService();
  authSpy = spyOn(auth, "resolveToken");
});

afterEach(() => {
  getOrCreateSpy.mockClear();
  rotateSpy.mockClear();
  readOwnerAndUserSpy.mockClear();
  authSpy?.mockClear();
});

afterAll(() => {
  capture.restore();
  getOrCreateSpy.mockRestore();
  rotateSpy.mockRestore();
  readOwnerAndUserSpy.mockRestore();
  authSpy?.mockRestore();
  dbClient.closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

// ---------------------------------------------------------------------------
// `$$FORM_ACTION` server-reference fixture (same pattern as ReviewCard.test.tsx
// and tests/app/phase2-wave5/_harness.ts): patch the REAL action function
// objects so React SSR renders a real POST/multipart form; `.bind` keeps the
// marker. `restore()` deletes the own properties again.
// ---------------------------------------------------------------------------

const formFields = () => ({ name: "$ACTION_REF_QA", action: "", encType: "multipart/form-data", method: "POST", data: null });
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

function serverLike(fns: readonly AnyFn[]): () => void {
  for (const fn of fns) markServerLike(fn);
  return () => {
    for (const fn of fns) {
      delete (fn as unknown as Record<string, unknown>).$$FORM_ACTION;
      delete (fn as unknown as Record<string, unknown>).bind;
    }
  };
}

const ALL_PAGE_ACTIONS: readonly AnyFn[] = [
  authActions.signOut,
  alertActions.acknowledgeStockAlert,
  alertActions.unsubscribeStockAlert,
  addressActions.saveAddress,
  addressActions.deleteAddress,
  addressActions.setDefaultAddress,
  viewActions.removeFromHistory,
  viewActions.clearHistory,
  reviewActions.voteReviewHelpful,
  headerActions.headerSignOut,
];

// ---------------------------------------------------------------------------
// Criterion 1: persona x page matrix
// ---------------------------------------------------------------------------

describe("criterion 1: guest / garbage / R-1 / G / A / B on each page", () => {
  for (const key of PAGE_KEYS) {
    for (const persona of ["none", "garbage", "unknownAuth", "r1", "guestG", "userA", "userB"] as const) {
      test(`${key} as ${persona}: 200, no cookie writes, no DB writes, one auth resolution, no foreign data`, async () => {
        const jar = browse(persona);
        const before = fullSnapshot(db);
        const html = await renderPage(key);
        const after = fullSnapshot(db);
        const doc = parse(html);

        // Never 404, never redirect (the render resolved to markup).
        expect(notFoundCalls).toEqual([]);
        expect(doc.querySelectorAll("h1")).toHaveLength(1);
        // Read-only: no cookie minted, rotated or cleared; no DB row changed.
        expect(jar.setCalls).toEqual([]);
        expect(jar.deleteCalls).toEqual([]);
        expect(getOrCreateSpy).not.toHaveBeenCalled();
        expect(rotateSpy).not.toHaveBeenCalled();
        expect(after).toEqual(before);
        // readOwnerAndUser resolves sf_auth at most once (exactly once when a well-formed token is present).
        const tokenPresent = persona === "userA" || persona === "userB" || persona === "unknownAuth";
        expect(authSpy).toHaveBeenCalledTimes(tokenPresent ? 1 : 0);

        // Owner keys, user ids, tokens, hashes never in markup.
        expect(secrets.find(html, true)).toEqual([]);

        const own: Record<Persona, string[]> = {
          none: [],
          garbage: [],
          unknownAuth: [],
          r1: [],
          guestG: ownedStrings(rowsG, TAG.G),
          userA: ownedStrings(rowsA, TAG.A),
          userB: ownedStrings(rowsB, TAG.B),
        };
        const everyone = [...ownedStrings(rowsG, TAG.G), ...ownedStrings(rowsA, TAG.A), ...ownedStrings(rowsB, TAG.B)];
        const foreign = everyone.filter((s) => !own[persona].includes(s));
        const leaked = foreign.filter((s) => html.includes(s));
        expect(leaked).toEqual([]);
        // A-only extras never shown to anyone else.
        if (persona !== "userA") {
          for (const s of ["Hidden title Kilo", "Hidden question Kilo", aBackInStockAlertId, aHiddenReviewId]) expect(html).not.toContain(s);
        }

        // Emails: never on the five sub-pages or in the hub for anyone but the signed-in user themself.
        const emails = [A.email, B.email];
        const allowedEmails = key === "hub" && persona === "userA" ? [A.email] : key === "hub" && persona === "userB" ? [B.email] : [];
        for (const e of emails.filter((x) => !allowedEmails.includes(x))) expect(html).not.toContain(e);

        // Every href allow-listed.
        const badHrefs = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "").filter((h) => !isAllowedInternalHref(h));
        expect(badHrefs).toEqual([]);
      });
    }
  }

  test("guest hub (no cookie, garbage, unknown token, R-1, G): sign-in invitation + device-bound notice, no sign-out", async () => {
    for (const persona of [...GUESTISH, "guestG"] as const) {
      browse(persona);
      const doc = parse(await renderPage("hub"));
      expect(text(doc)).toContain(GUEST_NOTICE_TEXT);
      const signIn = [...doc.querySelectorAll("a")].find((a) => a.textContent?.trim() === "Sign in");
      const signUp = [...doc.querySelectorAll("a")].find((a) => a.textContent?.trim() === "Create account");
      expect(signIn?.getAttribute("href")).toBe("/signin");
      expect(signUp?.getAttribute("href")).toBe("/signup");
      expect([...doc.querySelectorAll("button")].some((b) => b.textContent?.includes("Sign out"))).toBe(false);
    }
  });

  test("R-1: guest cookie equal to A's owner key reads as NO cookie (empty guest hub, none of A's data)", async () => {
    browse("r1");
    const html = await renderPage("hub");
    const doc = parse(html);
    expect(text(doc)).toContain("No orders yet");
    expect(text(doc)).toContain("Add an address");
    expect(html).not.toContain("Walnut");
    for (const key of ["addresses", "history", "contributions", "alerts", "messages"] as const) {
      browse("r1");
      const sub = await renderPage(key);
      expect(sub).not.toContain(TAG.A);
    }
  });

  test("hub counts are per owner (A vs B vs G)", async () => {
    browse("userA");
    const a = text(parse(await renderPage("hub")));
    expect(a).toContain("1 order");
    expect(a).toContain("1 list");
    expect(a).toContain("1 saved address");
    expect(a).toContain("1 item");
    expect(a).toContain("2 reviews, 2 questions");
    expect(a).toContain("2 alerts");
    expect(a).toContain("1 message");
    browse("userB");
    const b = text(parse(await renderPage("hub")));
    expect(b).toContain("1 review, 1 question");
    expect(b).toContain("1 alert");
    expect(b).not.toContain("2 alerts");
    browse("guestG");
    const g = text(parse(await renderPage("hub")));
    expect(g).toContain("1 review, 1 question");
    expect(g).toContain("1 saved address");
  });

  test("each sub-page lists exactly the owner's rows (A sees A's, B sees B's)", async () => {
    browse("userA");
    expect(await renderPage("addresses")).toContain(`Addr ${TAG.A}`);
    browse("userA");
    const contribA = await renderPage("contributions");
    expect(contribA).toContain(`Title ${TAG.A}`);
    expect(contribA).toContain("Hidden question Kilo?");
    browse("userA");
    const alertsA = await renderPage("alerts");
    expect(alertsA).toContain(rowsA.alertId);
    expect(alertsA).toContain(aBackInStockAlertId);
    browse("userA");
    expect(await renderPage("messages")).toContain(`Message ${TAG.A}`);
    browse("userB");
    expect(await renderPage("addresses")).toContain(`Addr ${TAG.B}`);
    browse("userB");
    expect(await renderPage("alerts")).toContain(rowsB.alertId);
  });

  test("no-cookie render never opens the database", async () => {
    const spy = spyOn(dbClient, "getDatabase");
    try {
      for (const key of PAGE_KEYS) {
        browse("none");
        await renderPage(key);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("readOwnerAndUser is called exactly once per page render", async () => {
    for (const key of PAGE_KEYS) {
      browse("userA");
      readOwnerAndUserSpy.mockClear();
      await renderPage(key);
      expect(readOwnerAndUserSpy).toHaveBeenCalledTimes(1);
    }
  });

  test("a stale sf_auth session (touch due) writes only auth_sessions.last_seen_at (accepted K-12 touch)", async () => {
    db.query("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?").run(new Date(Date.now() - 3_600_000).toISOString(), sha256hex(B.token));
    browse("userB");
    const before = fullSnapshot(db, ["auth_sessions"]);
    await renderPage("hub");
    expect(fullSnapshot(db, ["auth_sessions"])).toEqual(before);
    expect(store.setCalls).toEqual([]);
  });
});

// T129 criterion 2 / P-06: "guest sees the sign-in invitation plus device-bound notice" on /account/*.
describe("criterion 1: guest sign-in invitation on the five sub-pages", () => {
  for (const key of ["addresses", "history", "contributions", "alerts", "messages"] as const) {
    // PIN: D-T98-1 (fixed on all five sub-pages).
    // Ruling: the sign-in link carries `?next=<this page>` (`/signin?next=%2Faccount%2F<key>`).
    test(`${key} (no cookie) shows the sign-in invitation and the device-bound notice`, async () => {
      browse("none");
      const doc = parse(await renderPage(key));
      expect(text(doc)).toContain(GUEST_NOTICE_TEXT);
      const signIn = [...doc.querySelectorAll("a")]
        .map((a) => new URL(a.getAttribute("href") ?? "", "http://qa.test"))
        .filter((u) => u.pathname === "/signin");
      expect(signIn.length).toBeGreaterThan(0);
      expect(signIn.every((u) => [null, `/account/${key}`].includes(u.searchParams.get("next")))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Criterion 2: greeting (header, hub, contributions, drawer)
// ---------------------------------------------------------------------------

describe("criterion 2: header greeting and hostile display names", () => {
  test("signed-in header: 'Hello, <name>' and a POST sign-out form; guest header: 'Sign in' to /signin", async () => {
    const restore = serverLike(ALL_PAGE_ACTIONS);
    try {
      browse("userA");
      const signedIn = parse(renderToStaticMarkup(await HeaderShell()));
      const t = text(signedIn);
      expect(t).toContain("Hello, Kilo Person");
      const forms = [...signedIn.querySelectorAll("form")].filter((f) => f.textContent?.includes("Sign out"));
      expect(forms).toHaveLength(1);
      expect(forms[0]?.getAttribute("method")?.toLowerCase()).toBe("post");
      expect(forms[0]?.getAttribute("enctype")).toBe("multipart/form-data");
      expect(forms[0]?.getAttribute("action") ?? "").not.toContain("javascript:");
      expect(signedIn.body.innerHTML).not.toContain(A.email);
      expect(secrets.find(signedIn.body.innerHTML, true)).toEqual([]);
      expect(store.setCalls).toEqual([]);

      browse("none");
      const guest = parse(renderToStaticMarkup(await HeaderShell()));
      expect(text(guest)).toContain("Hello, Sign in");
      const accountLink = [...guest.querySelectorAll("a")].find((a) => a.textContent?.includes("Hello, Sign in"));
      expect(accountLink?.getAttribute("href")).toBe("/signin");
      expect([...guest.querySelectorAll("button")].some((b) => b.textContent?.includes("Sign out"))).toBe(false);

      browse("r1");
      const r1 = parse(renderToStaticMarkup(await HeaderShell()));
      expect(text(r1)).toContain("Hello, Sign in");
      expect(text(r1)).not.toContain("Kilo");
      expect(store.setCalls).toEqual([]);
    } finally {
      restore();
    }
  });

  const HOSTILE_NAMES = [
    { label: "img onerror", raw: HOSTILE_IMG, cleaned: HOSTILE_IMG },
    { label: "50 RTL chars", raw: RTL_50, cleaned: RTL_50 },
    { label: "bidi overrides", raw: BIDI_NAME, cleaned: "Mallory gnp.exe Quinn" },
    { label: "C1 controls", raw: C1_NAME, cleaned: "Victor Ivy" },
  ] as const;
  const FORBIDDEN_CHARS = /[\u0080-\u009f‪-‮⁦-⁩]/;

  for (const name of HOSTILE_NAMES) {
    test(`header (${name.label}): rendered as escaped text, cleaned, no live element`, async () => {
      const user = makeUser(name.raw, `hostile.${name.label.replace(/[^a-z]/gi, "").toLowerCase()}.hdr@example.test`);
      store = new QaCookieStore({ sf_auth: user.token });
      const html = renderToStaticMarkup(await HeaderShell());
      const doc = parse(html);
      expect(doc.querySelector("img")).toBeNull();
      expect(FORBIDDEN_CHARS.test(html)).toBe(false);
      expect(text(doc)).toContain(`Hello, ${name.cleaned.length > 20 ? Array.from(name.cleaned).slice(0, 20).join("") : name.cleaned}`);
      // The full (cleaned) name stays in the accessible label.
      expect(text(doc)).toContain(`Hello, ${name.cleaned}, Account & Lists`);
    });

    test(`drawer greeting (${name.label}): heading text is cleaned and escaped`, () => {
      render(<DepartmentMenu departments={[]} signedInName={name.raw} />);
      fireEvent.click(screen.getByRole("button", { name: /Open menu/ }));
      const dialog = screen.getByRole("dialog");
      expect(dialog.querySelector("img")).toBeNull();
      expect(FORBIDDEN_CHARS.test(dialog.innerHTML)).toBe(false);
      expect(within(dialog).getByRole("heading", { name: `Hello, ${name.cleaned}` })).toBeInTheDocument();
    });

    test(`hub greeting via the real sign-up policy (${name.label}): stored cleaned, rendered as text`, () => {
      // normalizeDisplayName (cleanText 1..50) is what every write path applies.
      const html = renderToStaticMarkup(
        <AccountHub
          user={{ displayName: name.cleaned, email: "hub.hostile@example.test" }}
          counts={{ orders: 0, lists: 0, addresses: 0, history: 0, reviews: 0, questions: 0, alerts: 0, messages: 0 }}
          backInStock={[]}
        />,
      );
      const doc = parse(html);
      expect(doc.querySelector("img")).toBeNull();
      expect(text(doc)).toContain(`Hello, ${name.cleaned}`);
    });
  }

  // T129 brief criterion 2: "escaped and cleaned everywhere it renders (header, hub, ...)".
  // The header and drawer clean at render (cleanDisplayName); AccountHub prints the raw value,
  // so a row written outside the auth service (repository / legacy row) reaches the hub with
  // bidi overrides and C1 controls intact.
  // PIN: D-T87-1 (fixed: AccountHub uses cleanDisplayName + truncateDisplayName)
  test("hub (signed-in page) cleans a raw stored display name with bidi overrides / C1 controls", async () => {
    const user = makeUser(`${BIDI_NAME}${C1_NAME}`.slice(0, 50), "hostile.raw.hub@example.test");
    store = new QaCookieStore({ sf_auth: user.token });
    const html = await renderPage("hub");
    expect(FORBIDDEN_CHARS.test(html)).toBe(false);
  });

  test("hub with a hostile <img onerror> name (raw row): escaped text, no element", async () => {
    const user = makeUser(HOSTILE_IMG, "hostile.img.hub@example.test");
    store = new QaCookieStore({ sf_auth: user.token });
    const html = await renderPage("hub");
    const doc = parse(html);
    expect(doc.querySelector("img")).toBeNull();
    expect(text(doc)).toContain(`Hello, ${HOSTILE_IMG}`);
  });

  test("contributions: own review with a hostile display name renders as escaped text", async () => {
    const user = makeUser("Plain Name", "hostile.review.owner@example.test");
    const at = new Date().toISOString();
    db.query(
      `INSERT INTO reviews (id, product_id, session_id, display_name, rating, title, body, created_at, updated_at)
       VALUES (?, 'prod_cork-yoga-mat', ?, ?, 5, ?, 'Body text that is long enough here.', ?, ?)`,
    ).run(uuid(), user.key, HOSTILE_IMG, `Title ${HOSTILE_IMG}`, at, at);
    store = new QaCookieStore({ sf_auth: user.token });
    const html = await renderPage("contributions");
    const doc = parse(html);
    expect(doc.querySelector("img[onerror]")).toBeNull();
    expect(text(doc)).toContain(HOSTILE_IMG);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: no-JS form shape
// ---------------------------------------------------------------------------

// `email` is checked separately: the D-T98-2 test asserts address forms post only ADDRESS_FIELD names
// (AddressForm omits the AddressFields `email` input since the fix).
const IDENTITY_FIELDS = ["sessionId", "session_id", "ownerKey", "owner_key", "userId", "user_id", "token", "authToken", "password"];

function formReport(doc: Document): { problems: string[]; forms: HTMLFormElement[] } {
  const problems: string[] = [];
  const forms = [...doc.querySelectorAll("form")];
  for (const f of forms) {
    if (f.querySelector("form") !== null) problems.push("nested form");
    if (f.getAttribute("method")?.toLowerCase() !== "post") problems.push(`method=${f.getAttribute("method")}`);
    if (f.getAttribute("enctype") !== "multipart/form-data") problems.push(`enctype=${f.getAttribute("enctype")}`);
    if ((f.getAttribute("action") ?? "").includes("javascript:")) problems.push("javascript: action");
    for (const el of f.querySelectorAll("input[name], select[name], textarea[name], button[name]")) {
      const n = el.getAttribute("name") ?? "";
      if (IDENTITY_FIELDS.includes(n)) problems.push(`identity field ${n}`);
    }
  }
  return { problems, forms };
}

function fieldNames(f: HTMLFormElement): string[] {
  return [...new Set([...f.querySelectorAll("[name]")].map((e) => e.getAttribute("name") ?? "").filter((n) => !n.startsWith("$ACTION")))].sort();
}

function submitNames(doc: Document): string[] {
  return [...doc.querySelectorAll("form button[type=submit], form button:not([type])")].map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim());
}

describe("criterion 3: mutation forms are real POST + multipart, contract fields only", () => {
  test("hub (A): sign-out + acknowledge forms; ids only from the contract", async () => {
    const restore = serverLike(ALL_PAGE_ACTIONS);
    try {
      browse("userA");
      const doc = parse(await renderPage("hub"));
      const { problems, forms } = formReport(doc);
      expect(problems).toEqual([]);
      expect(forms).toHaveLength(2);
      const allowed = new Set<string>(Object.values(STOCK_ALERT_FIELD));
      for (const f of forms) for (const n of fieldNames(f)) expect(allowed.has(n)).toBe(true);
      const ack = forms.find((f) => f.textContent?.includes("Acknowledge"));
      expect(ack?.querySelector<HTMLInputElement>('input[name="alertId"]')?.value).toBe(aBackInStockAlertId);
      const names = submitNames(doc);
      expect(new Set(names).size).toBe(names.length);
    } finally {
      restore();
    }
  });

  test("history (A): remove per item + clear with required confirm=yes", async () => {
    const restore = serverLike(ALL_PAGE_ACTIONS);
    try {
      browse("userA");
      const doc = parse(await renderPage("history"));
      const { problems, forms } = formReport(doc);
      expect(problems).toEqual([]);
      expect(forms.length).toBeGreaterThanOrEqual(2);
      const allowed = new Set<string>(Object.values(VIEW_FIELD));
      for (const f of forms) for (const n of fieldNames(f)) expect(allowed.has(n)).toBe(true);
      const clear = forms.find((f) => f.textContent?.includes("Clear history"));
      const confirm = clear?.querySelector<HTMLInputElement>(`input[name="${VIEW_FIELD.confirm}"]`);
      expect(confirm?.getAttribute("type")).toBe("checkbox");
      expect(confirm?.hasAttribute("required")).toBe(true);
      expect(confirm?.getAttribute("value")).toBe(CLEAR_HISTORY_CONFIRM_VALUE);
      expect(CLEAR_HISTORY_CONFIRM_VALUE).toBe("yes");
      const names = submitNames(doc);
      expect(new Set(names).size).toBe(names.length);
    } finally {
      restore();
    }
  });

  test("alerts (A): stop watching per alert + acknowledge for the back-in-stock one", async () => {
    const restore = serverLike(ALL_PAGE_ACTIONS);
    try {
      browse("userA");
      const doc = parse(await renderPage("alerts"));
      const { problems, forms } = formReport(doc);
      expect(problems).toEqual([]);
      const allowed = new Set<string>(Object.values(STOCK_ALERT_FIELD));
      for (const f of forms) for (const n of fieldNames(f)) expect(allowed.has(n)).toBe(true);
      expect(forms.filter((f) => f.textContent?.includes("Stop watching"))).toHaveLength(2);
      expect(forms.filter((f) => f.textContent?.includes("Acknowledge"))).toHaveLength(1);
      const names = submitNames(doc);
      expect(new Set(names).size).toBe(names.length);
    } finally {
      restore();
    }
  });

  test("addresses (A): add / edit / delete / set-default are POST + multipart, no nested forms, unique names", async () => {
    // Give A a second (non-default) address so "Set as default" renders.
    const id2 = uuid();
    const at = new Date().toISOString();
    db.query(
      `INSERT INTO addresses (id, session_id, full_name, line1, city, region, postal_code, country, is_default, created_at, updated_at)
       VALUES (?, ?, 'Second Kilo', '9 Side Rd Kilo', 'Springfield', 'IL', '62701', 'US', 0, ?, ?)`,
    ).run(id2, A.key, at, at);
    const restore = serverLike(ALL_PAGE_ACTIONS);
    try {
      browse("userA");
      const html = await renderPage("addresses");
      const doc = parse(html);
      const { problems, forms } = formReport(doc);
      expect(problems).toEqual([]);
      // add + 2 edits + 2 deletes + 1 set default; the raw markup has as many <form as the parsed DOM
      // (an HTML parser silently drops a nested <form>, so compare both).
      expect((html.match(/<form\b/g) ?? []).length).toBe(6);
      expect(forms.length).toBe(6);
      expect(forms.some((f) => f.textContent?.includes("Set as default"))).toBe(true);
      const del = forms.filter((f) => (f.textContent ?? "").includes("Delete"));
      for (const f of del) {
        expect(f.querySelector(`input[name="${ADDRESS_FIELD.confirm}"]`)?.hasAttribute("required")).toBe(true);
      }
      // Only the two own address ids appear as UUIDs.
      expect(uuidsIn(html).sort()).toEqual([rowsA.addressId, id2].sort());
    } finally {
      db.query("DELETE FROM addresses WHERE id = ?").run(id2);
      restore();
    }
  });

  // The two edit forms' submit buttons are both named "Update address" (no address in the name,
  // unlike "Delete, <address>" / "Set as default, <address>").
  // PIN: D-T98-3 (fixed)
  test("addresses: every submit button has a unique accessible name", async () => {
    const id2 = uuid();
    const at = new Date().toISOString();
    db.query(
      `INSERT INTO addresses (id, session_id, full_name, line1, city, region, postal_code, country, is_default, created_at, updated_at)
       VALUES (?, ?, 'Third Kilo', '7 Hill Rd Kilo', 'Springfield', 'IL', '62701', 'US', 0, ?, ?)`,
    ).run(id2, A.key, at, at);
    try {
      browse("userA");
      const names = submitNames(parse(await renderPage("addresses")));
      expect(names.length).toBeGreaterThan(3);
      expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    } finally {
      db.query("DELETE FROM addresses WHERE id = ?").run(id2);
    }
  });

  // AddressForm posts the AddressFields `email` input (CSS-hidden, documented in AddressForm.tsx);
  // `email` is not an ADDRESS_FIELD name, so the add/edit forms post a non-contract field.
  // PIN: D-T98-2 (fixed)
  test("addresses: add/edit forms post only ADDRESS_FIELD names (no hidden `email` input)", async () => {
    const restore = serverLike(ALL_PAGE_ACTIONS);
    try {
      browse("userA");
      const doc = parse(await renderPage("addresses"));
      const allowed = new Set<string>(Object.values(ADDRESS_FIELD));
      const extra = [...doc.querySelectorAll("form")].flatMap((f) => fieldNames(f).filter((n) => !allowed.has(n)));
      expect(extra).toEqual([]);
    } finally {
      restore();
    }
  });

  test("contributions and messages render no form at all (no vote form on own reviews)", async () => {
    const restore = serverLike(ALL_PAGE_ACTIONS);
    try {
      for (const key of ["contributions", "messages"] as const) {
        browse("userA");
        const doc = parse(await renderPage(key));
        expect(doc.querySelectorAll("form")).toHaveLength(0);
        expect(text(doc)).not.toMatch(/Helpful/);
      }
    } finally {
      restore();
    }
  });

  test("guest pages: no sign-out form; guest hub forms (if any) carry no identity fields", async () => {
    const restore = serverLike(ALL_PAGE_ACTIONS);
    try {
      for (const key of PAGE_KEYS) {
        browse("none");
        const doc = parse(await renderPage(key));
        expect(formReport(doc).problems).toEqual([]);
        expect([...doc.querySelectorAll("button")].some((b) => b.textContent?.includes("Sign out"))).toBe(false);
      }
    } finally {
      restore();
    }
  });

  test("sign-out form posts no auth fields (signOut reads none)", async () => {
    const restore = serverLike(ALL_PAGE_ACTIONS);
    try {
      browse("userA");
      const doc = parse(await renderPage("hub"));
      const signOutForm = [...doc.querySelectorAll("form")].find((f) => f.textContent?.includes("Sign out"));
      expect(signOutForm).toBeDefined();
      const names = fieldNames(signOutForm as HTMLFormElement);
      for (const n of Object.values(AUTH_FIELD)) expect(names).not.toContain(n);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: secrets and emails in markup, metadata, console
// ---------------------------------------------------------------------------

describe("criterion 5: secrets", () => {
  test("metadata of every page: noindex, no secrets, no owner keys, no emails", async () => {
    for (const key of PAGE_KEYS) {
      browse("userA");
      const meta = await PAGE_MODULES[key].generateMetadata();
      const json = JSON.stringify(meta);
      expect(meta.robots).toEqual({ index: false, follow: false });
      expect(secrets.find(json, true)).toEqual([]);
      expect(json).not.toContain(A.email);
      expect(json).not.toContain("@");
      expect(store.setCalls).toEqual([]);
    }
  });

  test("UUIDs in markup are only the opaque ids the page intends to expose", async () => {
    const allowed: Record<PageKey, string[]> = {
      hub: [aBackInStockAlertId],
      addresses: [rowsA.addressId],
      history: [],
      contributions: [],
      alerts: [rowsA.alertId, aBackInStockAlertId],
      messages: [],
    };
    for (const key of PAGE_KEYS) {
      const restore = serverLike(ALL_PAGE_ACTIONS);
      try {
        browse("userA");
        const html = await renderPage(key);
        const extra = uuidsIn(html).filter((u) => !allowed[key].includes(u));
        expect({ key, extra }).toEqual({ key, extra: [] });
      } finally {
        restore();
      }
    }
  });

  test("the signed-in hub shows the user's own email once as text (T87 AC5) and in no attribute", async () => {
    browse("userA");
    const html = await renderPage("hub");
    const doc = parse(html);
    expect(html.split(A.email)).toHaveLength(2);
    for (const el of doc.querySelectorAll("*")) for (const attr of el.attributes) expect(attr.value).not.toContain(A.email);
  });

  test("console output during every render carries no secret, owner key, token or email", async () => {
    const restore = serverLike(ALL_PAGE_ACTIONS);
    try {
      for (const persona of ["none", "garbage", "unknownAuth", "r1", "guestG", "userA", "userB"] as const) {
        for (const key of PAGE_KEYS) {
          browse(persona);
          await renderPage(key);
        }
      }
    } finally {
      restore();
    }
    const joined = capture.lines.join("\n");
    expect(secrets.find(joined, true)).toEqual([]);
    expect(joined).not.toContain(A.email);
    expect(joined).not.toContain(B.email);
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: hygiene
// ---------------------------------------------------------------------------

function headingLevels(doc: Document): number[] {
  return [...doc.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName.slice(1)));
}

function landmarkKeys(doc: Document): string[] {
  const keys: string[] = [];
  const nameOf = (el: Element): string => {
    const label = el.getAttribute("aria-label");
    if (label) return label;
    const by = el.getAttribute("aria-labelledby");
    if (by) return by.split(/\s+/).map((id) => doc.getElementById(id)?.textContent?.trim() ?? "").join(" ");
    return "";
  };
  for (const el of doc.querySelectorAll("nav, main, aside, header, footer")) keys.push(`${el.tagName.toLowerCase()}:${nameOf(el)}`);
  for (const el of doc.querySelectorAll("section[aria-label], section[aria-labelledby], form[aria-label], form[aria-labelledby]")) {
    keys.push(`${el.tagName === "FORM" ? "form" : "region"}:${nameOf(el)}`);
  }
  return keys;
}

const TOUCH = /\b(min-h-touch|h-touch|size-touch)\b/;

describe("criterion 6: hygiene", () => {
  for (const key of PAGE_KEYS) {
    for (const persona of ["none", "userA"] as const) {
      test(`${key} (${persona}): one h1, no skipped heading level, breadcrumb, unique landmarks, 44px controls`, async () => {
        const restore = serverLike(ALL_PAGE_ACTIONS);
        try {
          browse(persona);
          const doc = parse(await renderPage(key));
          const levels = headingLevels(doc);
          expect(levels[0]).toBe(1);
          expect(levels.filter((l) => l === 1)).toHaveLength(1);
          for (let i = 1; i < levels.length; i++) expect((levels[i] as number) - (levels[i - 1] as number)).toBeLessThanOrEqual(1);

          const crumb = doc.querySelector('nav[aria-label="Breadcrumb"]');
          expect(crumb).not.toBeNull();
          const items = [...(crumb as Element).querySelectorAll("li")].map((li) => (li.textContent ?? "").trim());
          const links = [...(crumb as Element).querySelectorAll("a")].map((a) => [a.textContent?.trim(), a.getAttribute("href")]);
          if (key === "hub") {
            expect(items).toEqual(["Home", "Your Account"]);
            expect(links).toEqual([["Home", "/"]]);
          } else {
            expect(items).toEqual(["Home", "Your Account", PAGE_TITLES[key]]);
            expect(links).toEqual([
              ["Home", "/"],
              ["Your Account", "/account"],
            ]);
          }
          expect((crumb as Element).querySelector('[aria-current="page"]')?.textContent?.trim()).toBe(PAGE_TITLES[key]);

          const marks = landmarkKeys(doc);
          expect(marks.length).toBe(new Set(marks).size);

          const small = [...doc.querySelectorAll("button, summary")].filter((el) => !TOUCH.test(el.getAttribute("class") ?? "")).map((el) => el.outerHTML.slice(0, 80));
          expect(small).toEqual([]);
          // Standalone links outside the breadcrumb keep a 44px target (hub back-in-stock links included since D-T87-2).
          const smallLinks = [...doc.querySelectorAll("a[href]")]
            .filter((a) => !a.closest('nav[aria-label="Breadcrumb"]') && !TOUCH.test(a.getAttribute("class") ?? ""))
            .map((a) => `${a.textContent?.trim()} -> ${a.getAttribute("href")}`);
          expect(smallLinks).toEqual([]);

          // No arbitrary Tailwind values or palette classes in the page markup.
          const classes = [...doc.querySelectorAll("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
          expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
          expect(classes.filter((c) => /^(?:[a-z0-9]+:)*(?:bg|text|border)-(?:red|blue|green|gray|slate|zinc|neutral|stone|amber|yellow|emerald|sky|indigo|rose|pink|purple|violet|orange|lime|teal|cyan|fuchsia)-\d{2,3}$/.test(c))).toEqual([]);
        } finally {
          restore();
        }
      });
    }
  }

  // SR6 (touch targets >= 44px): the back-in-stock product links in the hub Notice use the
  // `inline` Link variant (no min-h-touch) although each is a standalone list-item link.
  // PIN: D-T87-2 (fixed)
  test("hub (A): back-in-stock product links keep a 44px touch target (SR6)", async () => {
    browse("userA");
    const doc = parse(await renderPage("hub"));
    const link = [...doc.querySelectorAll('a[href="/products/walnut-desk"]')][0];
    expect(link).toBeDefined();
    expect(TOUCH.test(link?.getAttribute("class") ?? "")).toBe(true);
  });

  test("contributions (A): 'Not published' badges on the hidden review and hidden question only", async () => {
    browse("userA");
    const doc = parse(await renderPage("contributions"));
    const reviews = doc.querySelector('ul[aria-label="Your reviews"]');
    const questions = doc.querySelector('ul[aria-label="Your questions"]');
    const badged = (ul: Element | null) =>
      [...(ul?.querySelectorAll(":scope > li") ?? [])].filter((li) => (li.textContent ?? "").includes("Not published")).map((li) => li.textContent ?? "");
    const r = badged(reviews);
    const q = badged(questions);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("Hidden title Kilo");
    expect(q).toHaveLength(1);
    expect(q[0]).toContain("Hidden question Kilo?");
  });

  test("hostile review/question text from the DB stays text on contributions and history", async () => {
    const user = makeUser("Text Only", "hostile.text.owner@example.test");
    const at = new Date().toISOString();
    db.query("INSERT INTO questions (id, product_id, session_id, display_name, body, created_at) VALUES (?, 'prod_felt-desk-mat', ?, 'X', ?, ?)").run(
      uuid(),
      user.key,
      `<script>alert(1)</script> ${HOSTILE_IMG}?`,
      at,
    );
    store = new QaCookieStore({ sf_auth: user.token });
    const html = await renderPage("contributions");
    const doc = parse(html);
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("img[onerror]")).toBeNull();
    expect(text(doc)).toContain("<script>alert(1)</script>");
  });

  // A withdrawn / future-dated product still renders as a live "/products/<slug>" link (a 404)
  // on /account/alerts and in the hub back-in-stock Notice: listBackInStock / list do not apply
  // the publication filter (R-CART-1 family).
  // PIN: D-T98-4 (fixed)
  test("an unpublished (future-dated) product never yields a link on alerts or the hub", async () => {
    const restoreDb = db.query("SELECT published_at FROM products WHERE id = 'prod_walnut-desk'").get() as { published_at: string };
    db.query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = 'prod_walnut-desk'").run();
    try {
      browse("userA");
      const html = await renderPage("alerts");
      const doc = parse(html);
      const hrefs = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
      expect(hrefs.every((h) => isAllowedInternalHref(h ?? ""))).toBe(true);
      expect(hrefs).not.toContain("/products/walnut-desk");
      browse("userA");
      const hub = parse(await renderPage("hub"));
      expect([...hub.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"))).not.toContain("/products/walnut-desk");
    } finally {
      db.query("UPDATE products SET published_at = ? WHERE id = 'prod_walnut-desk'").run(restoreDb.published_at);
    }
  });

  test("OUT_OF_STOCK alert shows 'Watching'; restocked shows 'Back in stock'", async () => {
    browse("userA");
    const t = text(parse(await renderPage("alerts")));
    expect(t).toContain("Watching");
    expect(t).toContain("Back in stock");
    expect(OUT_OF_STOCK).toBe("prod_bike-light-set");
  });
});
