/**
 * T104a — QA wave 5, page-level: `/lists`, `/lists/[id]`, `/lists/shared/[token]` (T99). QA-owned.
 * Criteria: T104 1, 6, 7 (+ T99 1–4, R-T85-1). Page functions called directly with
 * mocked next/* (see _harness.ts), `:memory:` DB seeded through real services.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createSignedInUser,
  duplicateFormNames,
  duplicateIds,
  harness,
  headingViolations,
  hrefViolations,
  installNextMocks,
  isRealPostForm,
  outcomeOf,
  parseHtml,
  placePaidOrder,
  QA_ADDRESS,
  resetCookies,
  serverLike,
  smallSubmitButtons,
  totalChanges,
  UUID_RE,
  type SignedInUser,
} from "./_harness";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const previousDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const dbClient = await import("@/server/db/client");
const { closeDatabase, getDatabase } = dbClient;
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const currentUser = await import("@/server/session/current-user");
const { isAllowedInternalHref } = await import("@/content/routes");
const { createListService } = await import("@/server/lists/list-service");
const listActions = await import("@/app/actions/lists");
const formActions = await import("@/app/lists/_lib/list-form-actions");
const { default: IndexPage, generateMetadata: indexMetadata } = await import("@/app/lists/page");
const { default: ListPage } = await import("@/app/lists/[id]/page");
const { default: SharedPage, generateMetadata: sharedMetadata } = await import("@/app/lists/shared/[token]/page");

const spies = {
  readSessionId: spyOn(session, "readSessionId"),
  getOrCreateSessionId: spyOn(session, "getOrCreateSessionId"),
  rotateGuestSession: spyOn(session, "rotateGuestSession"),
  setAuthCookie: spyOn(session, "setAuthCookie"),
  clearAuthCookie: spyOn(session, "clearAuthCookie"),
  readCurrentUser: spyOn(currentUser, "readCurrentUser"),
};

const OWNER_A = "a1a1a1a1-2222-4222-8222-00000000000a";
const OWNER_B = "b2b2b2b2-2222-4222-8222-00000000000b";
const HOSTILE_NAME = '<img src=x onerror="alert(1)">Gifts';

let user: SignedInUser;
let productIds: string[] = [];
let aGifts = "";
let aSecond = "";
let bList = "";
let bToken = "";
let userList = "";
let userToken = "";
let userIdem = "";

function svc() {
  return createListService({ db: getDatabase() });
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}

type Params = Record<string, string | string[]>;

async function renderIndex(searchParams: Params = {}) {
  const outcome = await outcomeOf(() => IndexPage({ searchParams: Promise.resolve(searchParams) }));
  const html = outcome.kind === "ok" ? renderToStaticMarkup(outcome.value) : "";
  return { outcome, html, doc: parseHtml(html) };
}

async function renderList(id: string, searchParams: Params = {}) {
  const outcome = await outcomeOf(() => ListPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(searchParams) }));
  const html = outcome.kind === "ok" ? renderToStaticMarkup(outcome.value) : "";
  return { outcome, html, doc: parseHtml(html) };
}

async function renderShared(token: string, searchParams: Params = {}) {
  const outcome = await outcomeOf(() => SharedPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(searchParams) }));
  const html = outcome.kind === "ok" ? renderToStaticMarkup(outcome.value) : "";
  return { outcome, html, doc: parseHtml(html) };
}

function expectNoMint(): void {
  expect(spies.getOrCreateSessionId).not.toHaveBeenCalled();
  expect(spies.rotateGuestSession).not.toHaveBeenCalled();
  expect(spies.setAuthCookie).not.toHaveBeenCalled();
  expect(spies.clearAuthCookie).not.toHaveBeenCalled();
  expect(harness.store.writes).toEqual([]);
}

function expectA11y(doc: Document): void {
  expect(headingViolations(doc)).toEqual([]);
  expect(duplicateIds(doc)).toEqual([]);
  expect(duplicateFormNames(doc)).toEqual([]);
  expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
}

beforeAll(async () => {
  closeDatabase();
  const db = getDatabase();
  seedDatabase(db);
  productIds = db
    .query<{ id: string }, []>("SELECT id FROM products WHERE stock > 3 ORDER BY id LIMIT 4")
    .all()
    .map((r) => r.id);
  const s = svc();
  aGifts = must(s.createList(OWNER_A, HOSTILE_NAME)).id;
  aSecond = must(s.createList(OWNER_A, "Second of A")).id;
  must(s.addItem(OWNER_A, aGifts, productIds[0] ?? "", { note: "note of owner A" }));
  bList = must(s.createList(OWNER_B, "Secret list of owner B")).id;
  must(s.createList(OWNER_B, "Other list of owner B"));
  must(s.addItem(OWNER_B, bList, productIds[1] ?? ""));
  bToken = must(s.setSharing(OWNER_B, bList, "enable")).shareToken ?? "";
  // Signed-in owner with an address on file (order) and a shared list.
  user = await createSignedInUser(db, "Listowner Displayname", "listowner.private");
  userList = must(s.createList(user.ownerKey, "Birthday wishes")).id;
  must(s.addItem(user.ownerKey, userList, productIds[2] ?? "", { note: "public note" }));
  userToken = must(s.setSharing(user.ownerKey, userList, "enable")).shareToken ?? "";
  userIdem = (await placePaidOrder(db, user.ownerKey, [productIds[3] ?? ""])).idempotencyKey;
});

beforeEach(() => {
  resetCookies();
  for (const spy of Object.values(spies)) spy.mockClear();
});

afterAll(() => {
  for (const spy of Object.values(spies)) spy.mockRestore();
  closeDatabase();
  if (previousDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = previousDatabasePath;
});

describe("/lists index (T99-4, T104-1)", () => {
  test("no cookie: 200 empty state; no DB access, no session or list created", async () => {
    const getDb = spyOn(dbClient, "getDatabase");
    let dbCalls = -1;
    try {
      const { outcome, doc } = await renderIndex();
      dbCalls = getDb.mock.calls.length;
      expect(outcome.kind).toBe("ok");
      expect(doc.body.textContent).toContain("You have no lists yet.");
      expectA11y(doc);
    } finally {
      getDb.mockRestore();
    }
    expect(dbCalls).toBe(0);
    expectNoMint();
  });

  test("garbage cookies: same empty state, never rewritten", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: "../../etc", [session.AUTH_COOKIE_NAME]: "not-a-token" });
    const before = totalChanges(getDatabase());
    const { doc } = await renderIndex();
    expect(doc.body.textContent).toContain("You have no lists yet.");
    expect(totalChanges(getDatabase())).toBe(before);
    expectNoMint();
  });

  test("owner A sees only A's lists (hostile name escaped); B's names and ids absent", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    const { html, doc } = await renderIndex();
    const names = [...doc.querySelectorAll("ul[role='list'] > li a")].map((a) => a.textContent);
    expect(names).toEqual(expect.arrayContaining([HOSTILE_NAME, "Second of A"]));
    expect(doc.querySelector("img[src='x']")).toBeNull();
    for (const secret of ["Secret list of owner B", "Other list of owner B", bList, OWNER_A, OWNER_B, bToken, "Birthday wishes"]) {
      expect(html).not.toContain(secret);
    }
    expectA11y(doc);
    expectNoMint();
  });

  test("signed-in owner: lists via owner key; one list -> redirect to it; no secrets on the notice view", async () => {
    resetCookies({ [session.AUTH_COOKIE_NAME]: user.token });
    const { outcome } = await renderIndex();
    expect(outcome).toEqual({ kind: "redirect", url: `/lists/${userList}` });
    const shown = await renderIndex({ deleted: "1" });
    expect(shown.doc.body.textContent).toContain("List deleted.");
    for (const secret of [user.ownerKey, user.token, user.tokenHash, user.email, user.displayName, userToken]) {
      expect(shown.html).not.toContain(secret);
    }
    expectNoMint();
  });

  test("?deleted=1 notice renders for a no-cookie visitor too (redirect target of deleteList)", async () => {
    const { doc } = await renderIndex({ deleted: "1" });
    const status = [...doc.querySelectorAll("[role='status']")].map((e) => (e.textContent ?? "").trim());
    expect(status).toContain("List deleted.");
  });

  test("create-list form is a real POST form", async () => {
    const restore = serverLike([formActions.createListFromIndex]);
    try {
      const { doc } = await renderIndex();
      const forms = [...doc.querySelectorAll("form")];
      expect(forms).toHaveLength(1);
      expect(forms.every(isRealPostForm)).toBe(true);
      expect(smallSubmitButtons(doc)).toEqual([]);
    } finally {
      restore();
    }
  });

  test("metadata: noindex", async () => {
    const m = await indexMetadata();
    expect(m.robots).toMatchObject({ index: false });
  });
});

describe("/lists/[id] owner view (T99-1, T104-1)", () => {
  test("own list renders; owner mutation forms are real POST forms; no owner key in markup", async () => {
    const restore = serverLike([
      listActions.renameList,
      listActions.deleteList,
      listActions.setListSharing,
      listActions.addAllToCart,
      listActions.updateListItem,
      listActions.removeFromList,
      listActions.moveListItem,
      formActions.addToCartFromList,
    ]);
    try {
      resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
      const { outcome, html, doc } = await renderList(aGifts);
      expect(outcome.kind).toBe("ok");
      expect(doc.querySelector("h1")?.textContent).toContain(HOSTILE_NAME);
      expect(doc.querySelector("img[src='x']")).toBeNull();
      const posts = [...doc.querySelectorAll("form")].filter((f) => (f.getAttribute("method") ?? "").toLowerCase() !== "get");
      expect(posts.length).toBeGreaterThan(0);
      expect(posts.filter((f) => !isRealPostForm(f)).map((f) => (f.getAttribute("action") ?? "").slice(0, 40))).toEqual([]);
      for (const secret of [OWNER_A, OWNER_B, bList, "Secret list of owner B"]) expect(html).not.toContain(secret);
      // Only A's own list ids may appear (R-T87-3 opaque ids).
      for (const id of html.match(UUID_RE) ?? []) expect([aGifts, aSecond]).toContain(id);
      expectA11y(doc);
      expectNoMint();
    } finally {
      restore();
    }
  });

  test("owner primary submit buttons meet the 44px target", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    const { doc } = await renderList(aGifts);
    expect(smallSubmitButtons(doc)).toEqual([]);
  });

  const notFoundCases: Array<[string, () => Record<string, string>, () => string]> = [
    ["another owner's id", () => ({ [session.SESSION_COOKIE_NAME]: OWNER_A }), () => bList],
    ["no cookie", () => ({}), () => aGifts],
    ["garbage cookie", () => ({ [session.SESSION_COOKIE_NAME]: "garbage" }), () => aGifts],
    ["malformed id", () => ({ [session.SESSION_COOKIE_NAME]: OWNER_A }), () => "../../etc/passwd"],
    ["upper-case id", () => ({ [session.SESSION_COOKIE_NAME]: OWNER_A }), () => aGifts.toUpperCase()],
    ["10k id", () => ({ [session.SESSION_COOKIE_NAME]: OWNER_A }), () => "a".repeat(10_000)],
    ["unknown uuid", () => ({ [session.SESSION_COOKIE_NAME]: OWNER_A }), () => "d4d4d4d4-2222-4222-8222-00000000000d"],
    ["R-1: guest cookie = a user's owner key", () => ({ [session.SESSION_COOKIE_NAME]: user.ownerKey }), () => userList],
  ];

  test.each(notFoundCases)("%s -> notFound() (no leak), nothing written", async (_n, cookies, id) => {
    resetCookies(cookies());
    const before = totalChanges(getDatabase());
    const { outcome } = await renderList(id());
    expect(outcome.kind).toBe("notFound");
    expect(totalChanges(getDatabase())).toBe(before);
    expectNoMint();
  });

  test("signed-in owner opens own list via sf_auth", async () => {
    resetCookies({ [session.AUTH_COOKIE_NAME]: user.token });
    const { outcome, html } = await renderList(userList);
    expect(outcome.kind).toBe("ok");
    for (const secret of [user.ownerKey, user.token, user.tokenHash, user.email, user.passwordHash, userIdem]) {
      expect(html).not.toContain(secret);
    }
    expectNoMint();
  });

  test("hostile ?sort= is ignored", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    const { outcome } = await renderList(aGifts, { sort: ["<script>", "x".repeat(5000)] });
    expect(outcome.kind).toBe("ok");
  });
});

describe("/lists/shared/[token] public view (T99-2, T104-6)", () => {
  function forbiddenFor(): string[] {
    return [
      user.ownerKey,
      user.token,
      user.tokenHash,
      user.email,
      user.displayName,
      user.passwordHash,
      user.userId,
      userList,
      userIdem,
      QA_ADDRESS.fullName,
      QA_ADDRESS.email,
      QA_ADDRESS.line1,
      QA_ADDRESS.city,
      QA_ADDRESS.postalCode,
      "listowner",
      "Listowner",
    ];
  }

  test("signed-in owner's shared list: no cookie works; leaks no owner key, ids, email, name, address; no forms", async () => {
    const { outcome, html, doc } = await renderShared(userToken);
    expect(outcome.kind).toBe("ok");
    expect(doc.body.textContent).toContain("Birthday wishes");
    expect(doc.querySelectorAll("form")).toHaveLength(0);
    expect(doc.querySelectorAll("input, button[type='submit'], textarea, select")).toHaveLength(0);
    for (const secret of forbiddenFor()) expect(html).not.toContain(secret);
    expect(html.match(UUID_RE)).toBeNull();
    expect(spies.readSessionId).not.toHaveBeenCalled();
    expect(spies.readCurrentUser).not.toHaveBeenCalled();
    expect(harness.cookieReads).toBe(0);
    expectA11y(doc);
    expectNoMint();
  });

  test("guest owner B's shared list: no owner key, list id or B's other lists", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    const { html, doc } = await renderShared(bToken);
    expect(doc.body.textContent).toContain("Secret list of owner B");
    for (const secret of [OWNER_B, OWNER_A, bList, "Other list of owner B", HOSTILE_NAME]) expect(html).not.toContain(secret);
    expect(html.match(UUID_RE)).toBeNull();
    expect(doc.querySelectorAll("form")).toHaveLength(0);
    expectNoMint();
  });

  test("viewer identity never changes the shared markup", async () => {
    const anon = (await renderShared(userToken)).html;
    resetCookies({ [session.AUTH_COOKIE_NAME]: user.token });
    const asOwner = (await renderShared(userToken)).html;
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_B });
    const asOther = (await renderShared(userToken)).html;
    expect(asOwner).toBe(anon);
    expect(asOther).toBe(anon);
  });

  test("metadata: noindex, nofollow, token absent from every URL", async () => {
    const m = await sharedMetadata({ params: Promise.resolve({ token: userToken }), searchParams: Promise.resolve({}) });
    expect(m.robots).toMatchObject({ index: false });
    expect(JSON.stringify(m)).not.toContain(userToken);
    expect(JSON.stringify(m)).not.toContain(user.displayName);
  });

  test("rotated, revoked, malformed and hostile tokens -> notFound()", async () => {
    const db = getDatabase();
    const s = createListService({ db });
    const listId = must(s.createList(OWNER_A, "Rotate me")).id;
    const first = must(s.setSharing(OWNER_A, listId, "enable")).shareToken ?? "";
    expect((await renderShared(first)).outcome.kind).toBe("ok");
    const second = must(s.setSharing(OWNER_A, listId, "rotate")).shareToken ?? "";
    expect((await renderShared(first)).outcome.kind).toBe("notFound");
    expect((await renderShared(second)).outcome.kind).toBe("ok");
    must(s.setSharing(OWNER_A, listId, "disable"));
    expect((await renderShared(second)).outcome.kind).toBe("notFound");
    for (const bad of ["", "short", "../../../etc/passwd", "<script>alert(1)</script>xx", "a".repeat(100_000), `${userToken.slice(0, 21)}!`]) {
      expect((await renderShared(bad)).outcome.kind).toBe("notFound");
    }
    expectNoMint();
  });
});
