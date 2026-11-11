import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// next/headers + next/cache mocks. mock.module is process-wide in bun test, so
// the mocks are registered before `./lists` is imported and delegate to
// per-test state in this file (same pattern as cart.test.ts / stock-alerts.test.ts).
// ---------------------------------------------------------------------------

interface SetCall {
  readonly name: string;
  readonly value: string;
  readonly options: unknown;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string, options?: unknown): void {
    this.setCalls.push({ name, value, options });
    this.jar.set(name, value);
  }
}

let fakeStore = new FakeCookieStore();
const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));
mock.module("next/cache", () => ({ revalidatePath }));

/** Thrown by the mocked `redirect` (R-T85-1: deleteList redirects on success). */
class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT (test sentinel) ${url}`);
  }
}
const redirect = mock((url: string): never => {
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({ ...realNavigation, redirect }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const wired = await import("./lists");

const TOTE = "prod_canvas-tote-bag";
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0
const EXISTING = "33333333-3333-4333-8333-333333333333";
const FORGED = "44444444-4444-4444-8444-444444444444";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function lists(): { id: string; session_id: string }[] {
  return getDatabase().query("SELECT id, session_id FROM lists").all() as { id: string; session_id: string }[];
}

beforeEach(() => {
  closeDatabase(); // fresh in-memory DB per test
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

describe("'use server' module shape", () => {
  test("exports only the nine async functions", () => {
    const names = Object.keys(wired).sort();
    expect(names).toEqual([
      "addAllToCart",
      "addToList",
      "createList",
      "deleteList",
      "moveListItem",
      "removeFromList",
      "renameList",
      "setListSharing",
      "updateListItem",
    ]);
    for (const name of names) {
      const value: unknown = wired[name as keyof typeof wired];
      expect(typeof value).toBe("function");
      expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
    }
  });
});

describe("list server actions (wired)", () => {
  test("cold addToList sets the session cookie and creates the default list under it", async () => {
    const state = await wired.addToList(null, form({ productId: TOTE, sessionId: FORGED }));
    expect(state).toMatchObject({ ok: true, kind: "added" });
    expect(fakeStore.setCalls).toHaveLength(1);
    const call = fakeStore.setCalls[0];
    expect(call?.name).toBe(SESSION_COOKIE_NAME);
    expect(call?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    const [list] = lists();
    expect(list?.session_id).toBe(call?.value ?? "missing");
    expect(state !== null && state.ok ? state.listId : null).toBe(list?.id ?? "missing");
    expect(revalidatePath.mock.calls).toEqual([["/lists"], [`/lists/${list?.id}`]]);
  });

  test("invalid input sets no cookie", async () => {
    const state = await wired.addToList(null, form({ productId: TOTE, quantityDesired: "100" }));
    expect(state).toMatchObject({ ok: false, error: { code: "INVALID_QUANTITY" } });
    expect(fakeStore.setCalls).toEqual([]);
    expect(lists()).toEqual([]);
  });

  test("cold createList sets the session cookie; a blank name sets none", async () => {
    const bad = await wired.createList(null, form({ name: " " }));
    expect(bad).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(fakeStore.setCalls).toEqual([]);
    const state = await wired.createList(null, form({ name: "Gifts", sessionId: FORGED }));
    expect(state).toMatchObject({ ok: true, kind: "created" });
    expect(fakeStore.setCalls).toHaveLength(1);
    const call = fakeStore.setCalls[0];
    expect(call?.name).toBe(SESSION_COOKIE_NAME);
    expect(lists()).toEqual([{ id: state !== null && state.ok ? (state.listId ?? "") : "", session_id: call?.value ?? "missing" }]);
  });

  test("other actions (except addToList/createList) without a cookie return NOT_FOUND and set no cookie", async () => {
    const listId = "00000000-0000-4000-8000-000000000001";
    const states = [
      await wired.removeFromList(null, form({ listId, productId: TOTE })),
      await wired.updateListItem(null, form({ listId, productId: TOTE, priority: "1" })),
      await wired.moveListItem(null, form({ listId, toListId: listId, productId: TOTE })),
      await wired.renameList(null, form({ listId, name: "Gifts" })),
      await wired.deleteList(null, form({ listId, confirm: "yes" })),
      await wired.setListSharing(null, form({ listId, mode: "enable" })),
      await wired.addAllToCart(null, form({ listId })),
    ];
    for (const state of states) expect(state).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(fakeStore.setCalls).toEqual([]);
    expect(lists()).toEqual([]);
  });

  test("existing session: share, add all to cart, delete with confirm", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    const added = await wired.addToList(null, form({ productId: TOTE }));
    await wired.addToList(null, form({ productId: POUR_OVER }));
    expect(fakeStore.setCalls).toEqual([]);
    const listId = added !== null && added.ok ? (added.listId ?? "") : "";
    expect(lists()).toEqual([{ id: listId, session_id: EXISTING }]);

    const shared = await wired.setListSharing(null, form({ listId, mode: "enable" }));
    expect(shared).toMatchObject({ ok: true, kind: "sharing" });
    expect(shared !== null && shared.ok ? shared.sharePath : null).toMatch(/^\/lists\/shared\/[A-Za-z0-9_-]{22}$/);

    revalidatePath.mockClear();
    const all = await wired.addAllToCart(null, form({ listId }));
    expect(all).toMatchObject({ ok: true, kind: "add_all" });
    const perItem = all !== null && all.ok ? (all.perItem ?? []) : [];
    expect(Object.fromEntries(perItem.map((p) => [p.productId, p.result]))).toEqual({
      [TOTE]: "added",
      [POUR_OVER]: "out_of_stock",
    });
    expect(revalidatePath.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    const cartRow = getDatabase()
      .query("SELECT quantity FROM cart_items WHERE cart_session_id = ? AND product_id = ?")
      .get(EXISTING, TOTE) as { quantity: number } | null;
    expect(cartRow?.quantity).toBe(1);

    const created = await wired.createList(null, form({ name: "Second" }));
    expect(created).toMatchObject({ ok: true, kind: "created" });
    expect(await wired.deleteList(null, form({ listId }))).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(redirect).not.toHaveBeenCalled();
    let thrown: unknown = null;
    try {
      await wired.deleteList(null, form({ listId, confirm: "yes" }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RedirectSentinel);
    expect(redirect.mock.calls).toEqual([["/lists?deleted=1"]]);
    expect(lists().map((l) => l.id)).not.toContain(listId);
  });

  test("deleteList errors return the state and never redirect (R-T85-1)", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    const added = await wired.addToList(null, form({ productId: TOTE }));
    const listId = added !== null && added.ok ? (added.listId ?? "") : "";
    // Only wish list -> FORBIDDEN; foreign id -> NOT_FOUND; missing confirm -> INVALID_INPUT.
    expect(await wired.deleteList(null, form({ listId, confirm: "yes" }))).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await wired.deleteList(null, form({ listId: FORGED, confirm: "yes" }))).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await wired.deleteList(null, form({ listId }))).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(redirect).not.toHaveBeenCalled();
    expect(lists().map((l) => l.id)).toContain(listId);
  });
});
