import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// next/* mocks (process-wide in bun test), registered before `./page` is imported.
class NotFoundSentinel extends Error {
  constructor() {
    super("NEXT_NOT_FOUND (test sentinel)");
  }
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: string[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string): void {
    this.setCalls.push(name);
  }
}

let fakeStore = new FakeCookieStore();
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/headers", () => ({ cookies: async (): Promise<FakeCookieStore> => fakeStore }));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));
mock.module("next/navigation", () => ({
  ...realNavigation,
  notFound: (): never => {
    throw new NotFoundSentinel();
  },
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const { createListService } = await import("@/server/lists/list-service");
const { isAllowedInternalHref } = await import("@/content/routes");
const { LIST_SORT_SELECT_ID } = await import("@/components/organisms/ListView");
const { default: Page, generateMetadata } = await import("./page");

const OWNER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const TOTE = "prod_canvas-tote-bag";
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0
const HOSTILE = '<img src=x onerror="alert(1)">';

const readSessionIdSpy = spyOn(session, "readSessionId");
const getOrCreateSpy = spyOn(session, "getOrCreateSessionId");

function svc() {
  return createListService({ db: getDatabase() });
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}

function setCookie(id: string | null): void {
  fakeStore = new FakeCookieStore();
  if (id !== null) fakeStore.jar.set(session.SESSION_COOKIE_NAME, id);
}

function props(id: string, query: Record<string, string | string[]> = {}) {
  return { params: Promise.resolve({ id }), searchParams: Promise.resolve(query) };
}

async function renderPage(id: string, query: Record<string, string | string[]> = {}) {
  return render(await Page(props(id, query)));
}

async function expectNotFound(id: string, query: Record<string, string> = {}): Promise<void> {
  let thrown: unknown = null;
  try {
    await Page(props(id, query));
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(NotFoundSentinel);
}

beforeEach(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  setCookie(null);
});

afterEach(() => {
  readSessionIdSpy.mockClear();
  getOrCreateSpy.mockClear();
});

afterAll(() => {
  readSessionIdSpy.mockRestore();
  getOrCreateSpy.mockRestore();
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("/lists/[id] metadata", () => {
  test("static, noindex, no canonical (the id never reaches the metadata)", async () => {
    const metadata = await generateMetadata();
    expect(metadata.title).toBe("Your list");
    expect(metadata.robots).toMatchObject({ index: false });
    expect(metadata.alternates).toBeUndefined();
  });
});

describe("/lists/[id] access (criterion 1)", () => {
  test("another owner's id, unknown id and no cookie take the same notFound path; nothing is written", async () => {
    const theirs = unwrap(svc().createList(OTHER, "Theirs"));
    const mine = unwrap(svc().createList(OWNER, "Mine"));
    setCookie(OWNER);
    await expectNotFound(theirs.id);
    await expectNotFound(crypto.randomUUID());
    setCookie(null);
    await expectNotFound(mine.id);
    setCookie("garbage");
    await expectNotFound(mine.id);
    expect(getOrCreateSpy).not.toHaveBeenCalled();
    expect(fakeStore.setCalls).toEqual([]);
    expect(getDatabase().query<{ n: number }, []>("SELECT count(*) AS n FROM lists").get()?.n).toBe(2);
  });

  test("malformed ids 404 before any session/DB lookup", async () => {
    unwrap(svc().createList(OWNER, "Mine"));
    setCookie(OWNER);
    for (const id of ["not-a-uuid", "../../etc", "x".repeat(5000), "AAAAAAAAAAAAAAAAAAAAAA", "' OR 1=1 --"]) {
      await expectNotFound(id);
    }
    expect(readSessionIdSpy).not.toHaveBeenCalled();
  });
});

describe("/lists/[id] owner view", () => {
  test("renders the list in ListView owner mode with one h1, breadcrumb and safe hrefs", async () => {
    const list = unwrap(svc().createList(OWNER, "Birthday"));
    const other = unwrap(svc().createList(OWNER, "Holidays"));
    unwrap(svc().addItem(OWNER, list.id, TOTE));
    setCookie(OWNER);
    const { container } = await renderPage(list.id);

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Birthday");
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "Your lists" })).toHaveAttribute("href", "/lists");
    expect(within(nav).getByText("Birthday")).toHaveAttribute("aria-current", "page");

    // Owner mode: mutation forms exist (rename/delete/share/item forms) and the switcher offers the other list.
    expect(container.querySelectorAll("form").length).toBeGreaterThan(3);
    expect(container.innerHTML).toContain(other.id);
    expect(screen.getAllByRole("button", { name: /^Add .+ to cart$/ }).length).toBeGreaterThan(0);
    // Sort form targets this page.
    const sortForm = container.querySelector(`#${LIST_SORT_SELECT_ID}`)?.closest("form");
    expect(sortForm?.getAttribute("action")).toBe(`/lists/${list.id}`);

    for (const a of container.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      expect(isAllowedInternalHref(href)).toBe(true);
    }
    expect(container.innerHTML).not.toContain(OWNER);
    expect(getOrCreateSpy).not.toHaveBeenCalled();
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("?sort= is validated: known values select it, unknown values fall back to the default (criterion 3)", async () => {
    const list = unwrap(svc().createList(OWNER, "L"));
    unwrap(svc().addItem(OWNER, list.id, TOTE));
    unwrap(svc().addItem(OWNER, list.id, POUR_OVER));
    setCookie(OWNER);

    const sorted = await renderPage(list.id, { sort: "price_desc" });
    expect((sorted.container.querySelector(`#${LIST_SORT_SELECT_ID}`) as HTMLSelectElement).value).toBe("price_desc");
    sorted.unmount();

    for (const bad of ["bogus", "<script>", "__proto__"]) {
      const view = await renderPage(list.id, { sort: bad });
      expect((view.container.querySelector(`#${LIST_SORT_SELECT_ID}`) as HTMLSelectElement).value).toBe("added_desc");
      expect(view.container.innerHTML).not.toContain("<script>");
      view.unmount();
    }
    const repeated = await renderPage(list.id, { sort: ["price_asc", "priority"] });
    expect((repeated.container.querySelector(`#${LIST_SORT_SELECT_ID}`) as HTMLSelectElement).value).toBe("added_desc");
  });

  test("current price, price drop, purchased and out-of-stock states render as text (criterion 5)", async () => {
    const list = unwrap(svc().createList(OWNER, "States"));
    unwrap(svc().addItem(OWNER, list.id, TOTE));
    unwrap(svc().addItem(OWNER, list.id, POUR_OVER));
    const db = getDatabase();
    db.query("UPDATE products SET price_cents = 1499 WHERE id = ?").run(TOTE); // was 1999
    db.query(
      `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
         region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
       VALUES ('o-t99', ?, 'paid', 100, 100, 'USD', 'A', 'a@b.co', 'l1', 'c', 'r', 'p', 'US', '4242', 'idem-t99', '2999-01-01T00:00:00.000Z', 'processing')`,
    ).run(OWNER);
    db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES ('o-t99', ?, 'n', 100, 1)").run(TOTE);
    setCookie(OWNER);
    await renderPage(list.id);

    const tote = screen.getByRole("heading", { name: "Canvas Tote Bag" }).closest("article");
    if (tote === null) throw new Error("no tote row");
    expect(within(tote as HTMLElement).getByText("$14.99")).toBeInTheDocument();
    expect(within(tote as HTMLElement).getByText("Price dropped by $5.00")).toBeInTheDocument();
    expect(within(tote as HTMLElement).getByText("Purchased")).toBeInTheDocument();
    expect(within(tote as HTMLElement).queryByText("Out of stock")).toBeNull();

    const pourOver = screen.getByRole("heading", { name: /Pour-Over/i }).closest("article");
    if (pourOver === null) throw new Error("no pour-over row");
    expect(within(pourOver as HTMLElement).getByText("Out of stock")).toBeInTheDocument();
    expect(within(pourOver as HTMLElement).queryByText("Purchased")).toBeNull();
    expect(within(pourOver as HTMLElement).queryByText(/Price dropped/)).toBeNull();
  });

  test("hostile list names and notes render as text", async () => {
    const list = unwrap(svc().createList(OWNER, HOSTILE));
    unwrap(svc().addItem(OWNER, list.id, TOTE, { note: `<script>alert(1)</script> ${HOSTILE}` }));
    setCookie(OWNER);
    const { container } = await renderPage(list.id);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(HOSTILE);
    expect(screen.getByTestId("list-item-note")).toHaveTextContent("<script>alert(1)</script>");
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  test("?created=1 shows 'List created.'", async () => {
    const list = unwrap(svc().createList(OWNER, "New"));
    setCookie(OWNER);
    await renderPage(list.id, { created: "1" });
    expect(screen.getByText("List created.")).toBeInTheDocument();
  });
});
