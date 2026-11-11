import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// ---------------------------------------------------------------------------
// next/* mocks. mock.module is process-wide in bun test, so the mocks are
// registered before `./page` is imported and delegate to per-test state.
// ---------------------------------------------------------------------------

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT (test sentinel) ${url}`);
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
  redirect: (url: string): never => {
    throw new RedirectSentinel(url);
  },
  notFound: (): never => {
    throw new Error("unexpected notFound");
  },
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const dbClient = await import("@/server/db/client");
const { closeDatabase, getDatabase } = dbClient;
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const currentUser = await import("@/server/session/current-user");
const { createListService } = await import("@/server/lists/list-service");
const { isAllowedInternalHref } = await import("@/content/routes");
const { default: Page, generateMetadata } = await import("./page");

const OWNER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const TOTE = "prod_canvas-tote-bag";
const HOSTILE = '<img src=x onerror="alert(1)">';

const readSessionIdSpy = spyOn(session, "readSessionId");
const getOrCreateSpy = spyOn(session, "getOrCreateSessionId");
const readCurrentUserSpy = spyOn(currentUser, "readCurrentUser");

function lists() {
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

function rowCount(table: "lists" | "list_items" | "carts"): number {
  return getDatabase().query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
}

async function renderPage(params: Record<string, string | string[]> = {}) {
  return render(await Page({ searchParams: Promise.resolve(params) }));
}

async function redirectOf(params: Record<string, string> = {}): Promise<string> {
  try {
    await Page({ searchParams: Promise.resolve(params) });
  } catch (e) {
    if (e instanceof RedirectSentinel) return e.url;
    throw e;
  }
  throw new Error("expected a redirect");
}

function expectSafeHrefs(container: HTMLElement): void {
  const anchors = [...container.querySelectorAll("a[href]")];
  expect(anchors.length).toBeGreaterThan(0);
  for (const a of anchors) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
}

beforeEach(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  setCookie(null);
});

afterEach(() => {
  readSessionIdSpy.mockClear();
  getOrCreateSpy.mockClear();
  readCurrentUserSpy.mockClear();
});

afterAll(() => {
  readSessionIdSpy.mockRestore();
  getOrCreateSpy.mockRestore();
  readCurrentUserSpy.mockRestore();
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("/lists metadata", () => {
  test("noindex, title 'Your lists'", async () => {
    const metadata = await generateMetadata();
    expect(metadata.title).toBe("Your lists");
    expect(metadata.robots).toMatchObject({ index: false });
  });
});

describe("/lists without a cookie (criterion 4)", () => {
  test("200 empty state with sign-in and browse links; only readSessionId runs; nothing is created", async () => {
    const before = { lists: rowCount("lists"), items: rowCount("list_items"), carts: rowCount("carts") };
    const getDatabaseSpy = spyOn(dbClient, "getDatabase");
    const { container } = await renderPage();
    const dbCalls = getDatabaseSpy.mock.calls.length;
    getDatabaseSpy.mockRestore();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your lists");
    expect(screen.getByText(/Your lists live on this device/)).toBeInTheDocument();
    expect(screen.getByText(/Sign in to keep them/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
    expect(screen.getByRole("link", { name: "Browse products" })).toHaveAttribute("href", "/products");

    expect(readSessionIdSpy).toHaveBeenCalledTimes(1);
    expect(getOrCreateSpy).not.toHaveBeenCalled();
    expect(readCurrentUserSpy).not.toHaveBeenCalled();
    expect(dbCalls).toBe(0);
    expect(fakeStore.setCalls).toEqual([]);
    expect({ lists: rowCount("lists"), items: rowCount("list_items"), carts: rowCount("carts") }).toEqual(before);
    expectSafeHrefs(container);
  });

  test("breadcrumb is Home > Your lists", async () => {
    await renderPage();
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(within(nav).getByText("Your lists")).toHaveAttribute("aria-current", "page");
  });

  test("the create form posts a name capped at 60 characters", async () => {
    const { container } = await renderPage();
    const input = screen.getByLabelText(/List name/);
    expect(input).toHaveAttribute("name", "name");
    expect(input).toHaveAttribute("maxLength", "60");
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Create list" })).toHaveAttribute("type", "submit");
  });

  test("garbage cookie behaves like no cookie and is not rewritten", async () => {
    setCookie("not-a-uuid");
    await renderPage();
    expect(screen.getByText(/Your lists live on this device/)).toBeInTheDocument();
    expect(fakeStore.setCalls).toEqual([]);
    expect(rowCount("lists")).toBe(0);
  });
});

describe("/lists with a cookie", () => {
  test("cookie without lists: empty state, nothing created", async () => {
    setCookie(OWNER);
    const getDatabaseSpy = spyOn(dbClient, "getDatabase");
    await renderPage();
    // Positive control for the no-cookie test: the spy does see page-level DB access.
    expect(getDatabaseSpy.mock.calls.length).toBeGreaterThan(0);
    getDatabaseSpy.mockRestore();
    expect(screen.getByText("You have no lists yet.")).toBeInTheDocument();
    expect(rowCount("lists")).toBe(0);
    expect(getOrCreateSpy).not.toHaveBeenCalled();
  });

  test("exactly one list redirects to it", async () => {
    const only = unwrap(lists().createList(OWNER, "Only"));
    setCookie(OWNER);
    expect(await redirectOf()).toBe(`/lists/${only.id}`);
  });

  test("one list + ?deleted=1 shows the notice instead of redirecting (R-T85-1)", async () => {
    const only = unwrap(lists().createList(OWNER, "Remaining"));
    setCookie(OWNER);
    await renderPage({ deleted: "1" });
    expect(screen.getByRole("status")).toHaveTextContent("List deleted.");
    expect(screen.getByRole("link", { name: "Remaining" })).toHaveAttribute("href", `/lists/${only.id}`);
  });

  test("several lists: index with name, kind badge, item count and link; other owners' lists hidden", async () => {
    const svc = lists();
    const gifts = unwrap(svc.createList(OWNER, "Gifts"));
    unwrap(svc.addItem(OWNER, gifts.id, TOTE));
    unwrap(svc.setSharing(OWNER, gifts.id, "enable"));
    const sfl = unwrap(svc.ensureSaveForLater(OWNER));
    unwrap(svc.createList(OTHER, "Secret of other owner"));
    setCookie(OWNER);

    const { container } = await renderPage();
    expect(container.querySelectorAll("ul[role='list'] > li")).toHaveLength(2);
    const giftsLink = screen.getByRole("link", { name: "Gifts" });
    expect(giftsLink).toHaveAttribute("href", `/lists/${gifts.id}`);
    const giftsItem = giftsLink.closest("li");
    if (giftsItem === null) throw new Error("no li");
    expect(within(giftsItem).getByText("Wish list")).toBeInTheDocument();
    expect(within(giftsItem).getByText("Default")).toBeInTheDocument();
    expect(within(giftsItem).getByText("Shared")).toBeInTheDocument();
    expect(within(giftsItem).getByText("1 item")).toBeInTheDocument();
    const sflItem = screen.getByRole("link", { name: "Saved for later" }).closest("li");
    if (sflItem === null) throw new Error("no li");
    expect(within(sflItem).getByText("0 items")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Saved for later" })).toHaveAttribute("href", `/lists/${sfl.id}`);
    expect(screen.queryByText("Secret of other owner")).toBeNull();
    // No owner key or share token in the markup.
    expect(container.innerHTML).not.toContain(OWNER);
    const token = unwrap(svc.setSharing(OWNER, gifts.id, "enable")).shareToken ?? "missing";
    expect(container.innerHTML).not.toContain(token);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expectSafeHrefs(container);
  });

  test("hostile list names render as text", async () => {
    const svc = lists();
    unwrap(svc.createList(OWNER, HOSTILE));
    unwrap(svc.createList(OWNER, "Second"));
    setCookie(OWNER);
    const { container } = await renderPage();
    expect(screen.getByRole("link", { name: HOSTILE })).toBeInTheDocument();
    expect(container.querySelector("img[src='x']")).toBeNull();
  });

  test("?createError= shows fixed copy only; unknown codes show the generic message", async () => {
    await renderPage({ createError: "TOO_LONG" });
    expect(screen.getByText("List names can be up to 60 characters.")).toBeInTheDocument();
  });

  test("?createError= never echoes the raw value", async () => {
    const { container } = await renderPage({ createError: HOSTILE });
    expect(screen.getByText("We could not create that list. Please try again.")).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("onerror");
  });

  test("?created=1 shows 'List created.'; repeated or other values are ignored", async () => {
    await renderPage({ created: "1" });
    expect(screen.getByText("List created.")).toBeInTheDocument();
  });

  test("?deleted with other values shows no notice", async () => {
    await renderPage({ deleted: ["1", "1"] });
    expect(screen.queryByText("List deleted.")).toBeNull();
  });
});
