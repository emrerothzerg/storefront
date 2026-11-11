import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen } from "@testing-library/react";

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
const currentUser = await import("@/server/session/current-user");
const { createListService } = await import("@/server/lists/list-service");
const { isAllowedInternalHref } = await import("@/content/routes");
const { default: Page, generateMetadata } = await import("./page");

const OWNER = "33333333-3333-4333-8333-333333333333";
const TOTE = "prod_canvas-tote-bag";
const POUR_OVER = "prod_ceramic-pour-over";
const HOSTILE = '<img src=x onerror="alert(1)">';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const readSessionIdSpy = spyOn(session, "readSessionId");
const readCurrentUserSpy = spyOn(currentUser, "readCurrentUser");

function svc() {
  return createListService({ db: getDatabase() });
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}

/** Creates OWNER's list with items, shares it, and returns ids + token. */
function sharedFixture(name = "Birthday", note: string | null = "size M please") {
  const list = unwrap(svc().createList(OWNER, name));
  unwrap(svc().addItem(OWNER, list.id, TOTE, { note, priority: 2 }));
  unwrap(svc().addItem(OWNER, list.id, POUR_OVER));
  const token = unwrap(svc().setSharing(OWNER, list.id, "enable")).shareToken;
  if (token === null) throw new Error("no token");
  return { list, token };
}

function props(token: string, query: Record<string, string> = {}) {
  return { params: Promise.resolve({ token }), searchParams: Promise.resolve(query) };
}

async function expectNotFound(token: string): Promise<void> {
  let thrown: unknown = null;
  try {
    await Page(props(token));
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(NotFoundSentinel);
}

beforeEach(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  fakeStore = new FakeCookieStore();
});

afterEach(() => {
  readSessionIdSpy.mockClear();
  readCurrentUserSpy.mockClear();
});

afterAll(() => {
  readSessionIdSpy.mockRestore();
  readCurrentUserSpy.mockRestore();
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("/lists/shared/[token] metadata", () => {
  test("title 'Shared list: <name>', noindex + nofollow, no canonical carrying the token", async () => {
    const { token } = sharedFixture();
    const metadata = await generateMetadata(props(token));
    expect(metadata.title).toBe("Shared list: Birthday");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.alternates).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toContain(token);
  });

  test("unknown or malformed token: generic title, still noindex", async () => {
    for (const token of ["A".repeat(22), "nope"]) {
      const metadata = await generateMetadata(props(token));
      expect(metadata.title).toBe("Shared list");
      expect(metadata.robots).toEqual({ index: false, follow: false });
    }
  });
});

describe("/lists/shared/[token] page (criterion 2)", () => {
  test("works without a cookie; read-only, no forms, no owner data or ids", async () => {
    const { list, token } = sharedFixture();
    const { container } = render(await Page(props(token)));

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Birthday");
    expect(screen.getByText("size M please")).toBeInTheDocument();
    expect(screen.getByText("Out of stock")).toBeInTheDocument();
    expect(screen.queryByText("Purchased")).toBeNull();

    const html = container.innerHTML;
    expect(html).not.toContain("<form");
    expect(container.querySelector("form, input, textarea, select, button[type='submit']")).toBeNull();
    expect(html).not.toMatch(UUID_RE);
    expect(html).not.toContain(OWNER);
    expect(html).not.toContain(list.id);
    expect(html).not.toContain("@");
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);

    expect(readSessionIdSpy).not.toHaveBeenCalled();
    expect(readCurrentUserSpy).not.toHaveBeenCalled();
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("a visitor's own cookie changes nothing (no owner lookup, no session data rendered)", async () => {
    const { token } = sharedFixture();
    const visitor = "55555555-5555-4555-8555-555555555555";
    fakeStore.jar.set(session.SESSION_COOKIE_NAME, visitor);
    const { container } = render(await Page(props(token)));
    expect(container.innerHTML).not.toContain(visitor);
    expect(readSessionIdSpy).not.toHaveBeenCalled();
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("purchased state is never shown to the public even if the owner bought the item", async () => {
    const { token } = sharedFixture();
    const db = getDatabase();
    db.query(
      `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
         region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
       VALUES ('o-sh', ?, 'paid', 100, 100, 'USD', 'Owner Name', 'owner@example.com', 'l1', 'c', 'r', 'p', 'US', '4242', 'idem-sh', '2999-01-01T00:00:00.000Z', 'processing')`,
    ).run(OWNER);
    db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES ('o-sh', ?, 'n', 100, 1)").run(TOTE);
    const { container } = render(await Page(props(token)));
    expect(screen.queryByText("Purchased")).toBeNull();
    expect(container.innerHTML).not.toContain("owner@example.com");
    expect(container.innerHTML).not.toContain("Owner Name");
  });

  test("breadcrumb: Home > Shared list: <name>", async () => {
    const { token } = sharedFixture();
    render(await Page(props(token)));
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav.querySelector("a[href='/']")).not.toBeNull();
    expect(nav).toHaveTextContent("Shared list: Birthday");
  });

  test("sort is validated: unknown values fall back to the default (criterion 3)", async () => {
    const { token } = sharedFixture();
    const view = render(await Page(props(token, { sort: "javascript:alert(1)" })));
    expect(screen.getByRole("link", { name: "Recently added" })).toHaveAttribute("aria-current", "page");
    expect(view.container.innerHTML).not.toContain("javascript:");
    view.unmount();
    render(await Page(props(token, { sort: "price_asc" })));
    expect(screen.getByRole("link", { name: "Price: Low to High" })).toHaveAttribute("aria-current", "page");
  });

  test("hostile names and notes render as text", async () => {
    const { token } = sharedFixture(HOSTILE, `<script>alert(1)</script>`);
    const { container } = render(await Page(props(token)));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(HOSTILE);
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(container.querySelector("img[src='x'], script")).toBeNull();
  });

  test("rotated, revoked, unknown and malformed tokens 404", async () => {
    const { list, token } = sharedFixture();
    const rotated = unwrap(svc().setSharing(OWNER, list.id, "rotate")).shareToken ?? "";
    await expectNotFound(token);
    render(await Page(props(rotated)));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Birthday");
    unwrap(svc().setSharing(OWNER, list.id, "disable"));
    await expectNotFound(rotated);
    for (const bad of ["A".repeat(22), "short", "A".repeat(23), list.id, "abcdefghijklmnopqrstu=", "../../../etc/passwd"]) {
      await expectNotFound(bad);
    }
    expect(readSessionIdSpy).not.toHaveBeenCalled();
  });
});
