import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ListActionState } from "@/components/molecules/_contracts/list-actions";
import { LIST_FIELD, LIST_INPUT_LIMITS, sharedListPath } from "@/components/molecules/_contracts/list-actions";
import { fail } from "@/lib/result";
import { createCartService, type CartService } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import {
  LIST_NAME_MAX,
  MAX_ITEMS_PER_LIST,
  MAX_LISTS_PER_SESSION,
  MAX_QUANTITY_DESIRED,
  NOTE_MAX,
  createListService,
  type ListService,
} from "@/server/lists/list-service";
import { createRateLimiter } from "@/server/security/rate-limiter";
import {
  LIST_ACTION_FAILED,
  LIST_MESSAGES,
  addAllMessage,
  createListActions,
  echoValues,
  mapError,
  parseReturnTo,
  type ListActionDeps,
  type ListActions,
} from "./lists-core";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");

const TOTE = "prod_canvas-tote-bag"; // in stock
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0
const PRINT = "prod_limited-print-no-1"; // stock 1
const EARBUDS = "prod_true-wireless-earbuds"; // stock 2

type RevalidateFn = (path: string, type?: "page" | "layout") => void;

interface Harness {
  readonly db: Database;
  readonly lists: ListService;
  readonly cart: CartService;
  readonly actions: ListActions;
  readonly getOrCreate: ReturnType<typeof mock<() => Promise<string>>>;
  readonly read: ReturnType<typeof mock<() => Promise<string | null>>>;
  readonly revalidatePath: ReturnType<typeof mock<RevalidateFn>>;
  readonly logger: { error: ReturnType<typeof mock<(...args: unknown[]) => void>> };
  /** Cookie jar of the fake session: null = no cookie yet. */
  readonly session: { current: string | null; next: string };
  readonly clock: { ms: number };
}

function setup(overrides: Partial<ListActionDeps> = {}): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const session: { current: string | null; next: string } = { current: null, next: S1 };
  const clock = { ms: T0 };
  const getOrCreate = mock(async (): Promise<string> => {
    if (session.current === null) session.current = session.next;
    return session.current;
  });
  const read = mock(async (): Promise<string | null> => session.current);
  const revalidatePath = mock<RevalidateFn>(() => undefined);
  const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
  const lists = createListService({ db, now: () => new Date(clock.ms) });
  const cart = createCartService(db);
  const deps: ListActionDeps = {
    lists,
    cart,
    limiter: createRateLimiter(db, { now: () => clock.ms }),
    getOrCreateSessionId: getOrCreate,
    readSessionId: read,
    revalidatePath,
    logger,
    ...overrides,
  };
  return { db, lists, cart, actions: createListActions(deps), getOrCreate, read, revalidatePath, logger, session, clock };
}

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function paths(h: Harness): unknown[][] {
  return h.revalidatePath.mock.calls.map((c) => [...c]);
}

function itemRows(db: Database): { list_id: string; product_id: string; quantity_desired: number; priority: number; note: string | null; price_at_add_cents: number }[] {
  return db
    .query("SELECT list_id, product_id, quantity_desired, priority, note, price_at_add_cents FROM list_items ORDER BY product_id")
    .all() as { list_id: string; product_id: string; quantity_desired: number; priority: number; note: string | null; price_at_add_cents: number }[];
}

function listRows(db: Database): { id: string; session_id: string; name: string; is_default: number }[] {
  return db.query("SELECT id, session_id, name, is_default FROM lists ORDER BY created_at, id").all() as {
    id: string;
    session_id: string;
    name: string;
    is_default: number;
  }[];
}

function cartQty(db: Database, sessionId: string, productId: string): number {
  const row = db
    .query("SELECT quantity FROM cart_items WHERE cart_session_id = ? AND product_id = ?")
    .get(sessionId, productId) as { quantity: number } | null;
  return row?.quantity ?? 0;
}

function expectOk(state: ListActionState): Extract<ListActionState, { ok: true }> {
  if (state === null || !state.ok) throw new Error(`expected ok, got ${JSON.stringify(state)}`);
  return state;
}

function expectErr(state: ListActionState): Extract<ListActionState, { ok: false }> {
  if (state === null || state.ok) throw new Error(`expected error, got ${JSON.stringify(state)}`);
  return state;
}

/** S1 with a default list containing TOTE. Returns its id. */
async function seedDefault(h: Harness): Promise<string> {
  const state = expectOk(await h.actions.addToList(null, form({ productId: TOTE })));
  h.revalidatePath.mockClear();
  h.getOrCreate.mockClear();
  return state.listId ?? "";
}

function ownList(lists: ListService, sessionId: string, name: string): string {
  const r = lists.createList(sessionId, name);
  if (!r.ok) throw new Error("createList failed");
  return r.value.id;
}

describe("contract limits mirror the service", () => {
  test("LIST_INPUT_LIMITS equals the list-service constants", () => {
    expect(LIST_INPUT_LIMITS).toEqual({
      nameMax: LIST_NAME_MAX,
      noteMax: NOTE_MAX,
      quantityMin: 1,
      quantityMax: MAX_QUANTITY_DESIRED,
      maxListsPerSession: MAX_LISTS_PER_SESSION,
      maxItemsPerList: MAX_ITEMS_PER_LIST,
    });
    expect(sharedListPath("abc")).toBe("/lists/shared/abc");
  });
});

describe("addToList", () => {
  test("first interaction (no cookie) creates session + default list + item", async () => {
    const h = setup();
    const state = expectOk(
      await h.actions.addToList(null, form({ productId: TOTE, productSlug: "canvas-tote-bag", returnTo: "/products/canvas-tote-bag?x=1#top" })),
    );
    expect(state.kind).toBe("added");
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    const [list] = listRows(h.db);
    expect(list).toMatchObject({ session_id: S1, is_default: 1, name: "Shopping List" });
    expect(state.listId).toBe(list?.id ?? "missing");
    expect(itemRows(h.db)).toEqual([expect.objectContaining({ list_id: list?.id, product_id: TOTE, quantity_desired: 1, priority: 0 })]);
    expect(paths(h)).toEqual([
      ["/lists"],
      [`/lists/${list?.id}`],
      ["/products/canvas-tote-bag"],
      ["/products/canvas-tote-bag"],
    ]);
  });

  test("second add reports already_present and changes nothing", async () => {
    const h = setup();
    const listId = await seedDefault(h);
    const state = expectOk(await h.actions.addToList(null, form({ productId: TOTE, quantityDesired: "5" })));
    expect(state).toMatchObject({ kind: "already_present", listId, message: LIST_MESSAGES.alreadyPresent });
    expect(itemRows(h.db)[0]?.quantity_desired).toBe(1);
    expect(paths(h)).toEqual([]);
  });

  test("adds to a named own list with options; forged sessionId/ownerKey/price/isDefault ignored", async () => {
    const h = setup();
    h.session.current = S1;
    const listId = ownList(h.lists, S1, "Gifts");
    const state = expectOk(
      await h.actions.addToList(
        null,
        form({
          listId,
          productId: TOTE,
          quantityDesired: "3",
          priority: "2",
          note: "  for  mum \u0007 ",
          sessionId: S2,
          ownerKey: S2,
          price: "1",
          priceAtAddCents: "1",
          isDefault: "1",
        }),
      ),
    );
    expect(state).toMatchObject({ kind: "added", listId });
    const price = (h.db.query("SELECT price_cents FROM products WHERE id = ?").get(TOTE) as { price_cents: number }).price_cents;
    expect(itemRows(h.db)).toEqual([
      { list_id: listId, product_id: TOTE, quantity_desired: 3, priority: 2, note: "for mum", price_at_add_cents: price },
    ]);
    expect(listRows(h.db).every((l) => l.session_id === S1)).toBe(true);
  });

  test.each(["0", "-1", "2.5", "abc", "100", "1e1", " ", "999999999999999999"])(
    "quantity %p is rejected without creating a session or rows",
    async (quantityDesired) => {
      const h = setup();
      const state = await h.actions.addToList(null, form({ productId: TOTE, quantityDesired }));
      if (quantityDesired.trim() === "") {
        // empty = default quantity
        expectOk(state);
        return;
      }
      const e = expectErr(state);
      expect(e.error.code).toBe("INVALID_QUANTITY");
      expect(e.fieldErrors).toEqual({ quantityDesired: LIST_MESSAGES.quantity });
      expect(h.getOrCreate).not.toHaveBeenCalled();
      expect(listRows(h.db)).toEqual([]);
      expect(paths(h)).toEqual([]);
    },
  );

  test.each(["3", "-1", "x", "1.0"])("priority %p is rejected without state change", async (priority) => {
    const h = setup();
    const e = expectErr(await h.actions.addToList(null, form({ productId: TOTE, priority })));
    expect(e.error).toMatchObject({ code: "VALIDATION_FAILED", details: { field: "priority" } });
    expect(e.fieldErrors).toEqual({ priority: LIST_MESSAGES.priority });
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(listRows(h.db)).toEqual([]);
  });

  test("note > 200 is TOO_LONG with a truncated echo and no state change", async () => {
    const h = setup();
    const note = "n".repeat(250);
    const e = expectErr(await h.actions.addToList(null, form({ productId: TOTE, note })));
    expect(e.error.code).toBe("TOO_LONG");
    expect(e.fieldErrors).toEqual({ note: LIST_MESSAGES.noteTooLong });
    expect(e.values).toEqual({ note: "n".repeat(200) });
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(itemRows(h.db)).toEqual([]);
  });

  test("malformed productId / listId are INVALID_INPUT before any session", async () => {
    const h = setup();
    const cases: Record<string, string | Blob>[] = [
      {},
      { productId: "" },
      { productId: "   " },
      { productId: "p".repeat(201) },
      { productId: new Blob(["x"]) },
      { productId: TOTE, listId: "l".repeat(201) },
      { productId: TOTE, listId: new Blob(["x"]) },
    ];
    for (const fields of cases) {
      const e = expectErr(await h.actions.addToList(null, form(fields)));
      expect(e.error.code).toBe("INVALID_INPUT");
    }
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(listRows(h.db)).toEqual([]);
  });

  test("unknown product -> PRODUCT_NOT_FOUND and the lazily created default list is rolled back", async () => {
    const h = setup();
    const e = expectErr(await h.actions.addToList(null, form({ productId: "prod_nope" })));
    expect(e).toMatchObject({ error: { code: "PRODUCT_NOT_FOUND" }, message: LIST_MESSAGES.productNotFound });
    expect(listRows(h.db)).toEqual([]);
    expect(paths(h)).toEqual([]);
  });

  test("adding to the save-for-later list also revalidates /cart", async () => {
    const h = setup();
    h.session.current = S1;
    const sfl = h.lists.ensureSaveForLater(S1);
    if (!sfl.ok) throw new Error("sfl");
    expectOk(await h.actions.addToList(null, form({ productId: TOTE, listId: sfl.value.id })));
    expect(paths(h)).toEqual([["/lists"], [`/lists/${sfl.value.id}`], ["/cart"]]);
  });

  test("works with a multipart FormData body (no-JS replay shape)", async () => {
    const h = setup();
    const multipart = new FormData();
    multipart.append(LIST_FIELD.productId, TOTE);
    multipart.append(LIST_FIELD.quantityDesired, "2");
    multipart.append(LIST_FIELD.note, "line one\r\nline two");
    multipart.append("$ACTION_ID_abc", "");
    const request = new Request("http://localhost/products/canvas-tote-bag", { method: "POST", body: multipart });
    expect(request.headers.get("content-type")).toContain("multipart/form-data");
    const replayed = await request.formData();
    expectOk(await h.actions.addToList(null, replayed));
    expect(itemRows(h.db)[0]).toMatchObject({ quantity_desired: 2, note: "line one\nline two" });
  });
});

describe("foreign / unknown ids", () => {
  async function twoOwners(): Promise<{ h: Harness; foreign: string; mine: string }> {
    const h = setup();
    h.session.current = S2;
    const foreignAdd = await h.actions.addToList(null, form({ productId: TOTE }));
    const foreign = expectOk(foreignAdd).listId ?? "";
    ownList(h.lists, S2, "Second"); // so S2's default would be deletable
    h.session.current = S1;
    const mine = expectOk(await h.actions.addToList(null, form({ productId: EARBUDS }))).listId ?? "";
    h.revalidatePath.mockClear();
    return { h, foreign, mine };
  }

  test("every action returns the same NOT_FOUND for a foreign and an unknown id and writes nothing", async () => {
    const { h, foreign, mine } = await twoOwners();
    const before = { lists: listRows(h.db), items: itemRows(h.db) };
    const shareBefore = h.db.query("SELECT id, share_token, is_public FROM lists ORDER BY id").all();
    const unknown = "00000000-0000-4000-8000-00000000abcd";
    const run = async (listId: string): Promise<ListActionState[]> => [
      await h.actions.addToList(null, form({ listId, productId: TOTE })),
      await h.actions.removeFromList(null, form({ listId, productId: TOTE })),
      await h.actions.updateListItem(null, form({ listId, productId: TOTE, quantityDesired: "4" })),
      await h.actions.moveListItem(null, form({ listId, toListId: mine, productId: TOTE })),
      await h.actions.moveListItem(null, form({ listId: mine, toListId: listId, productId: EARBUDS })),
      await h.actions.renameList(null, form({ listId, name: "Pwned" })),
      await h.actions.deleteList(null, form({ listId, confirm: "yes" })),
      await h.actions.setListSharing(null, form({ listId, mode: "enable" })),
      await h.actions.addAllToCart(null, form({ listId })),
    ];
    // `values` only echoes the posted name back to its own form; strip it for the comparison.
    const strip = (states: ListActionState[]): ListActionState[] =>
      states.map((st) => {
        if (st === null || st.ok) return st;
        return { ok: false, error: st.error, message: st.message };
      });
    const foreignStates = strip(await run(foreign));
    const unknownStates = strip(await run(unknown));
    expect(foreignStates).toEqual(unknownStates);
    for (const state of foreignStates) {
      expect(state).toEqual({ ok: false, error: { code: "NOT_FOUND", message: LIST_MESSAGES.notFound }, message: LIST_MESSAGES.notFound });
    }
    expect({ lists: listRows(h.db), items: itemRows(h.db) }).toEqual(before);
    expect(h.db.query("SELECT id, share_token, is_public FROM lists ORDER BY id").all()).toEqual(shareBefore);
    expect(cartQty(h.db, S1, TOTE)).toBe(0);
    expect(paths(h)).toEqual([]);
  });

  test("an item missing from an own list gives the same NOT_FOUND", async () => {
    const { h, mine } = await twoOwners();
    const e = expectErr(await h.actions.updateListItem(null, form({ listId: mine, productId: POUR_OVER, quantityDesired: "2" })));
    expect(e.message).toBe(LIST_MESSAGES.notFound);
  });
});

describe("no cookie", () => {
  test("every action except addToList/createList returns NOT_FOUND without creating a session", async () => {
    const h = setup();
    const listId = "00000000-0000-4000-8000-000000000001";
    const states = [
      await h.actions.removeFromList(null, form({ listId, productId: TOTE })),
      await h.actions.updateListItem(null, form({ listId, productId: TOTE, priority: "1" })),
      await h.actions.moveListItem(null, form({ listId, toListId: listId, productId: TOTE })),
      await h.actions.renameList(null, form({ listId, name: "Gifts" })),
      await h.actions.deleteList(null, form({ listId, confirm: "yes" })),
      await h.actions.setListSharing(null, form({ listId, mode: "enable" })),
      await h.actions.addAllToCart(null, form({ listId })),
    ];
    for (const state of states) expect(expectErr(state).error.code).toBe("NOT_FOUND");
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.session.current).toBeNull();
    expect(listRows(h.db)).toEqual([]);
    expect(h.db.query("SELECT COUNT(*) AS n FROM rate_limits").get()).toEqual({ n: 0 });
  });
});

describe("removeFromList / updateListItem / moveListItem", () => {
  test("remove deletes the item and revalidates the list paths", async () => {
    const h = setup();
    const listId = await seedDefault(h);
    const state = expectOk(await h.actions.removeFromList(null, form({ listId, productId: TOTE, productSlug: "canvas-tote-bag" })));
    expect(state).toMatchObject({ kind: "removed", listId });
    expect(itemRows(h.db)).toEqual([]);
    expect(paths(h)).toEqual([["/lists"], [`/lists/${listId}`], ["/products/canvas-tote-bag"]]);
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  test("update changes quantity/priority/note; absent fields unchanged; empty note clears", async () => {
    const h = setup();
    const listId = await seedDefault(h);
    expectOk(await h.actions.updateListItem(null, form({ listId, productId: TOTE, quantityDesired: "4", priority: "1", note: "hi" })));
    expect(itemRows(h.db)[0]).toMatchObject({ quantity_desired: 4, priority: 1, note: "hi" });
    expectOk(await h.actions.updateListItem(null, form({ listId, productId: TOTE, priority: "2" })));
    expect(itemRows(h.db)[0]).toMatchObject({ quantity_desired: 4, priority: 2, note: "hi" });
    expectOk(await h.actions.updateListItem(null, form({ listId, productId: TOTE, note: "   " })));
    expect(itemRows(h.db)[0]).toMatchObject({ quantity_desired: 4, priority: 2, note: null });
    expect(paths(h)).toContainEqual([`/lists/${listId}`]);
  });

  test.each([
    ["quantityDesired", "0", "INVALID_QUANTITY"],
    ["quantityDesired", "-1", "INVALID_QUANTITY"],
    ["quantityDesired", "2.5", "INVALID_QUANTITY"],
    ["quantityDesired", "abc", "INVALID_QUANTITY"],
    ["quantityDesired", "100", "INVALID_QUANTITY"],
    ["priority", "3", "VALIDATION_FAILED"],
    ["priority", "-1", "VALIDATION_FAILED"],
    ["priority", "x", "VALIDATION_FAILED"],
    ["note", "z".repeat(201), "TOO_LONG"],
  ])("update %s=%p -> %s with no state change", async (field, value, code) => {
    const h = setup();
    const listId = await seedDefault(h);
    const before = itemRows(h.db);
    const e = expectErr(await h.actions.updateListItem(null, form({ listId, productId: TOTE, [field]: value })));
    expect(e.error.code).toBe(code as "INVALID_QUANTITY");
    expect(Object.keys(e.fieldErrors ?? {})).toEqual([field]);
    expect(itemRows(h.db)).toEqual(before);
    expect(paths(h)).toEqual([]);
    expect(h.db.query("SELECT COUNT(*) AS n FROM rate_limits").get()).toEqual({ n: 1 }); // only the seeding add
  });

  test("move between own lists revalidates both; into save-for-later also /cart", async () => {
    const h = setup();
    const from = await seedDefault(h);
    const to = ownList(h.lists, S1, "Later maybe");
    const state = expectOk(await h.actions.moveListItem(null, form({ listId: from, toListId: to, productId: TOTE })));
    expect(state).toMatchObject({ kind: "moved", listId: to });
    expect(itemRows(h.db)).toEqual([expect.objectContaining({ list_id: to, product_id: TOTE })]);
    expect(paths(h)).toEqual([["/lists"], [`/lists/${from}`], [`/lists/${to}`]]);

    h.revalidatePath.mockClear();
    const sfl = h.lists.ensureSaveForLater(S1);
    if (!sfl.ok) throw new Error("sfl");
    expectOk(await h.actions.moveListItem(null, form({ listId: to, toListId: sfl.value.id, productId: TOTE })));
    expect(paths(h)).toEqual([["/lists"], [`/lists/${to}`], [`/lists/${sfl.value.id}`], ["/cart"]]);
  });

  test("move requires toListId", async () => {
    const h = setup();
    const from = await seedDefault(h);
    const e = expectErr(await h.actions.moveListItem(null, form({ listId: from, productId: TOTE })));
    expect(e.error).toMatchObject({ code: "INVALID_INPUT", details: { field: "toListId" } });
  });
});

describe("createList / renameList / deleteList", () => {
  test("createList as the first interaction (no cookie) creates the session lazily", async () => {
    const h = setup();
    const created = expectOk(await h.actions.createList(null, form({ name: "Gifts", sessionId: S2 })));
    expect(created.kind).toBe("created");
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.session.current).toBe(S1);
    expect(listRows(h.db)).toEqual([expect.objectContaining({ id: created.listId, session_id: S1, name: "Gifts", is_default: 1 })]);
    expect(h.db.query("SELECT COUNT(*) AS n FROM rate_limits").get()).toEqual({ n: 1 });
    expect(paths(h)).toEqual([["/lists"], [`/lists/${created.listId}`]]);
  });

  test("createList with an invalid name creates no session", async () => {
    const h = setup();
    const cases: Record<string, string>[] = [{}, { name: "   " }, { name: "x".repeat(61) }];
    for (const fields of cases) {
      expect(expectErr(await h.actions.createList(null, form(fields))).ok).toBe(false);
    }
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.session.current).toBeNull();
    expect(listRows(h.db)).toEqual([]);
  });

  test("create, rename and delete with confirm", async () => {
    const h = setup();
    const defaultId = await seedDefault(h);
    const created = expectOk(await h.actions.createList(null, form({ name: "  Birthday   gifts ", isDefault: "1" })));
    expect(created.kind).toBe("created");
    const id = created.listId ?? "";
    expect(listRows(h.db).find((l) => l.id === id)).toMatchObject({ name: "Birthday gifts", is_default: 0, session_id: S1 });
    expect(paths(h)).toEqual([["/lists"], [`/lists/${id}`]]);

    h.revalidatePath.mockClear();
    expect(expectOk(await h.actions.renameList(null, form({ listId: id, name: "Gifts" }))).kind).toBe("renamed");
    expect(listRows(h.db).find((l) => l.id === id)?.name).toBe("Gifts");
    expect(paths(h)).toEqual([["/lists"], [`/lists/${id}`]]);

    h.revalidatePath.mockClear();
    expect(expectOk(await h.actions.deleteList(null, form({ listId: id, confirm: "yes" }))).kind).toBe("deleted");
    expect(listRows(h.db).map((l) => l.id)).toEqual([defaultId]);
    expect(paths(h)).toEqual([["/lists"], [`/lists/${id}`]]);
  });

  test("deleteList without confirm=yes is INVALID_INPUT and deletes nothing", async () => {
    const h = setup();
    await seedDefault(h);
    const id = ownList(h.lists, S1, "Keep me");
    for (const confirm of [undefined, "", "no", "YES", "yes "]) {
      const fields: Record<string, string> = { listId: id };
      if (confirm !== undefined) fields.confirm = confirm;
      const e = expectErr(await h.actions.deleteList(null, form(fields)));
      expect(e.error).toMatchObject({ code: "INVALID_INPUT", details: { field: "confirm" } });
      expect(e.message).toBe(LIST_MESSAGES.confirmRequired);
    }
    expect(listRows(h.db).some((l) => l.id === id)).toBe(true);
    expect(paths(h)).toEqual([]);
  });

  test("deleting the only wish list is FORBIDDEN", async () => {
    const h = setup();
    const id = await seedDefault(h);
    const e = expectErr(await h.actions.deleteList(null, form({ listId: id, confirm: "yes" })));
    expect(e).toMatchObject({ error: { code: "FORBIDDEN" }, message: LIST_MESSAGES.forbiddenDelete });
  });

  test("name validation: blank, missing, too long (truncated echo), File", async () => {
    const h = setup();
    await seedDefault(h);
    const blank = expectErr(await h.actions.createList(null, form({ name: " \u0000 " })));
    expect(blank).toMatchObject({ error: { code: "VALIDATION_FAILED" }, fieldErrors: { name: LIST_MESSAGES.nameRequired } });
    const missing = expectErr(await h.actions.createList(null, form({})));
    expect(missing.fieldErrors).toEqual({ name: LIST_MESSAGES.nameRequired });
    const long = expectErr(await h.actions.createList(null, form({ name: `a\u0007${"b".repeat(80)}` })));
    expect(long).toMatchObject({ error: { code: "TOO_LONG" }, fieldErrors: { name: LIST_MESSAGES.nameTooLong } });
    expect(long.values).toEqual({ name: `a ${"b".repeat(58)}` });
    const file = expectErr(await h.actions.createList(null, form({ name: new Blob(["x"]) })));
    expect(file.error.code).toBe("INVALID_INPUT");
    expect(listRows(h.db)).toHaveLength(1);
  });

  test("21st list -> LIMIT_REACHED", async () => {
    const h = setup();
    await seedDefault(h);
    for (let i = 2; i <= 20; i++) expectOk(await h.actions.createList(null, form({ name: `L${i}` })));
    const e = expectErr(await h.actions.createList(null, form({ name: "L21" })));
    expect(e).toMatchObject({ error: { code: "LIMIT_REACHED", details: { max: 20 } }, message: LIST_MESSAGES.listsLimit, values: { name: "L21" } });
  });

  test("save-for-later cannot be renamed or shared or deleted", async () => {
    const h = setup();
    await seedDefault(h);
    const sfl = h.lists.ensureSaveForLater(S1);
    if (!sfl.ok) throw new Error("sfl");
    const id = sfl.value.id;
    expect(expectErr(await h.actions.renameList(null, form({ listId: id, name: "x" }))).message).toBe(LIST_MESSAGES.forbiddenRename);
    expect(expectErr(await h.actions.setListSharing(null, form({ listId: id, mode: "enable" }))).message).toBe(LIST_MESSAGES.forbiddenSharing);
    expect(expectErr(await h.actions.deleteList(null, form({ listId: id, confirm: "yes" }))).error.code).toBe("FORBIDDEN");
  });
});

describe("setListSharing", () => {
  test("enable / rotate / disable return sharePath for the owner; token never logged", async () => {
    const errorSpy = mock<(...args: unknown[]) => void>(() => undefined);
    const original = console.error;
    console.error = errorSpy;
    try {
      const h = setup();
      const listId = await seedDefault(h);
      const enabled = expectOk(await h.actions.setListSharing(null, form({ listId, mode: "enable" })));
      expect(enabled).toMatchObject({ kind: "sharing", listId, message: LIST_MESSAGES.sharingEnabled });
      expect(enabled.sharePath).toMatch(/^\/lists\/shared\/[A-Za-z0-9_-]{22}$/);
      const token = (h.db.query("SELECT share_token FROM lists WHERE id = ?").get(listId) as { share_token: string }).share_token;
      expect(enabled.sharePath).toBe(sharedListPath(token));
      expect(paths(h)).toEqual([["/lists"], [`/lists/${listId}`]]);

      const again = expectOk(await h.actions.setListSharing(null, form({ listId, mode: "enable" })));
      expect(again.sharePath).toBe(enabled.sharePath);

      const rotated = expectOk(await h.actions.setListSharing(null, form({ listId, mode: "rotate" })));
      expect(rotated.message).toBe(LIST_MESSAGES.sharingRotated);
      expect(rotated.sharePath).not.toBe(enabled.sharePath);

      const disabled = expectOk(await h.actions.setListSharing(null, form({ listId, mode: "disable" })));
      expect(disabled).toMatchObject({ sharePath: null, message: LIST_MESSAGES.sharingDisabled });

      for (const mode of ["", "ENABLE", "public", "on"]) {
        const e = expectErr(await h.actions.setListSharing(null, form({ listId, mode })));
        expect(e.error).toMatchObject({ code: "INVALID_INPUT", details: { field: "mode" } });
        expect("sharePath" in e).toBe(false);
      }
      const logged = [...errorSpy.mock.calls, ...h.logger.error.mock.calls].flat().map(String).join("\n");
      expect(logged).not.toContain(token);
      expect(logged).not.toContain((rotated.sharePath ?? "").slice(-22));
    } finally {
      console.error = original;
    }
  });
});

describe("addAllToCart", () => {
  test("adds in-stock items, caps low stock, skips out-of-stock; never oversells", async () => {
    const h = setup();
    const listId = await seedDefault(h); // TOTE qty 1
    expectOk(await h.actions.updateListItem(null, form({ listId, productId: TOTE, quantityDesired: "2" })));
    expectOk(await h.actions.addToList(null, form({ productId: POUR_OVER })));
    expectOk(await h.actions.addToList(null, form({ productId: PRINT, quantityDesired: "3" })));
    expectOk(await h.actions.addToList(null, form({ productId: EARBUDS, quantityDesired: "1" })));
    // The cart already holds all the earbuds in stock.
    const pre = h.cart.addItem(S1, EARBUDS, 2);
    expect(pre.ok).toBe(true);
    h.revalidatePath.mockClear();

    const state = expectOk(await h.actions.addAllToCart(null, form({ listId })));
    expect(state.kind).toBe("add_all");
    expect(state.listId).toBe(listId);
    const byProduct = Object.fromEntries((state.perItem ?? []).map((p) => [p.productId, p.result]));
    expect(byProduct).toEqual({ [TOTE]: "added", [POUR_OVER]: "out_of_stock", [PRINT]: "capped", [EARBUDS]: "capped" });
    expect(cartQty(h.db, S1, TOTE)).toBe(2);
    expect(cartQty(h.db, S1, POUR_OVER)).toBe(0);
    expect(cartQty(h.db, S1, PRINT)).toBe(1);
    expect(cartQty(h.db, S1, EARBUDS)).toBe(2);
    expect(state.message).toBe(addAllMessage(4, 2, 2, 1));
    expect(state.message).toBe("Added 2 items to your cart. Some quantities were limited by available stock. 1 unavailable item was skipped.");
    expect(paths(h)).toEqual([["/cart"], ["/", "layout"]]);
    // List itself is untouched.
    expect(itemRows(h.db)).toHaveLength(4);

    // Second run: everything is already at stock (tote has plenty, so it adds again).
    h.revalidatePath.mockClear();
    const second = expectOk(await h.actions.addAllToCart(null, form({ listId })));
    const secondBy = Object.fromEntries((second.perItem ?? []).map((p) => [p.productId, p.result]));
    expect(secondBy[PRINT]).toBe("capped");
    expect(cartQty(h.db, S1, PRINT)).toBe(1);
  });

  test("empty list: ok with a message, nothing revalidated for the cart", async () => {
    const h = setup();
    const listId = await seedDefault(h);
    expectOk(await h.actions.removeFromList(null, form({ listId, productId: TOTE })));
    h.revalidatePath.mockClear();
    const state = expectOk(await h.actions.addAllToCart(null, form({ listId })));
    expect(state).toMatchObject({ kind: "add_all", message: LIST_MESSAGES.addAllEmpty, perItem: [] });
    expect(paths(h)).toEqual([]);
  });

  test("maps cart PRODUCT_NOT_FOUND to unavailable and a throwing cart to unavailable (logged code only)", async () => {
    let call = 0;
    const cart: Pick<CartService, "addItem"> = {
      addItem: (_s, productId) => {
        call++;
        if (call === 1) return fail("PRODUCT_NOT_FOUND", "Product not found", { productId });
        throw new Error(`boom ${productId}`);
      },
    };
    const h = setup({ cart });
    const listId = await seedDefault(h);
    expectOk(await h.actions.addToList(null, form({ productId: EARBUDS })));
    const state = expectOk(await h.actions.addAllToCart(null, form({ listId })));
    expect((state.perItem ?? []).map((p) => p.result).sort()).toEqual(["unavailable", "unavailable"]);
    expect(state.message).toBe(LIST_MESSAGES.addAllNone);
    expect(h.logger.error.mock.calls).toEqual([[`[lists] ${LIST_ACTION_FAILED} action=addAllToCart.item`]]);
  });

  test("INSUFFICIENT_STOCK retry that loses a race to OUT_OF_STOCK reports out_of_stock", async () => {
    const calls: number[] = [];
    const cart: Pick<CartService, "addItem"> = {
      addItem: (_s, productId, quantity) => {
        calls.push(quantity);
        return calls.length === 1
          ? fail("INSUFFICIENT_STOCK", "x", { productId, available: 1, requested: quantity })
          : fail("OUT_OF_STOCK", "x", { productId, available: 0, requested: quantity });
      },
    };
    const h = setup({ cart });
    const listId = await seedDefault(h);
    expectOk(await h.actions.updateListItem(null, form({ listId, productId: TOTE, quantityDesired: "5" })));
    const state = expectOk(await h.actions.addAllToCart(null, form({ listId })));
    expect(state.perItem).toEqual([{ productId: TOTE, result: "out_of_stock" }]);
    expect(calls).toEqual([5, 1]);
  });
});

describe("rate limit", () => {
  test("121st mutation in an hour -> RATE_LIMITED before the service; resets next window", async () => {
    const h = setup();
    const listId = await seedDefault(h); // 1
    for (let i = 2; i <= 120; i++) {
      expectOk(await h.actions.updateListItem(null, form({ listId, productId: TOTE, quantityDesired: String((i % 9) + 1) })));
    }
    const before = itemRows(h.db);
    const e = expectErr(await h.actions.updateListItem(null, form({ listId, productId: TOTE, quantityDesired: "42" })));
    expect(e.error.code).toBe("RATE_LIMITED");
    expect(e.retryAfterSeconds).toBeGreaterThan(0);
    expect(e.message).toMatch(/^Too many requests\. Please try again in \d+ minutes?\.$/);
    expect(itemRows(h.db)).toEqual(before);
    const add = expectErr(await h.actions.addToList(null, form({ productId: EARBUDS })));
    expect(add.error.code).toBe("RATE_LIMITED");
    expect(itemRows(h.db)).toEqual(before);
    const share = expectErr(await h.actions.setListSharing(null, form({ listId, mode: "enable" })));
    expect(share.error.code).toBe("RATE_LIMITED");
    expect("sharePath" in share).toBe(false);

    h.clock.ms += 60 * 60 * 1000;
    expectOk(await h.actions.updateListItem(null, form({ listId, productId: TOTE, quantityDesired: "42" })));
  });

  test("the limit is per session (no global backstop)", async () => {
    const h = setup();
    await seedDefault(h);
    h.db.run("UPDATE rate_limits SET count = 1000");
    expect(expectErr(await h.actions.createList(null, form({ name: "x" }))).error.code).toBe("RATE_LIMITED");
    h.session.current = S2;
    expectOk(await h.actions.addToList(null, form({ productId: TOTE })));
  });
});

describe("always settles", () => {
  test("a throwing service or session reader becomes a generic error state, logged by code only", async () => {
    const throwing = new Proxy({} as ListService, {
      get: () => () => {
        throw new Error(`SQLITE_BUSY secret-${S1}`);
      },
    });
    const h = setup({ lists: throwing });
    const state = expectErr(await h.actions.addToList(null, form({ productId: TOTE, note: "keep" })));
    expect(state).toEqual({
      ok: false,
      error: { code: "VALIDATION_FAILED", message: LIST_MESSAGES.unexpected, details: { reason: "unexpected" } },
      message: LIST_MESSAGES.unexpected,
    });
    expect(h.logger.error.mock.calls).toEqual([[`[lists] ${LIST_ACTION_FAILED} action=addToList`]]);

    const h2 = setup({
      readSessionId: async () => {
        throw new Error("cookies() unavailable");
      },
    });
    const settled = await h2.actions.setListSharing(null, form({ listId: "x", mode: "enable" }));
    expect(expectErr(settled).message).toBe(LIST_MESSAGES.unexpected);
    expect(h2.logger.error.mock.calls).toEqual([[`[lists] ${LIST_ACTION_FAILED} action=setListSharing`]]);
  });

  test("service INVALID_INPUT (bad owner key) maps to a generic message", async () => {
    const h = setup({ readSessionId: async () => "not-a-uuid" });
    const e = expectErr(await h.actions.removeFromList(null, form({ listId: "l", productId: TOTE })));
    expect(e).toMatchObject({ error: { code: "INVALID_INPUT" }, message: LIST_MESSAGES.invalidRequest });
  });
});

describe("helpers", () => {
  test("parseReturnTo accepts same-origin paths only", () => {
    const rt = (v: string | Blob): string | null => parseReturnTo(form({ returnTo: v }));
    expect(rt("/products/canvas-tote-bag")).toBe("/products/canvas-tote-bag");
    expect(rt("/lists?sort=price_asc#x")).toBe("/lists");
    expect(rt("/")).toBe("/");
    for (const bad of [
      "",
      "products",
      "//evil.example",
      "/%2Fevil.example",
      "/\\evil.example",
      "https://evil.example/",
      "javascript:alert(1)",
      "/a/../b",
      "/a/%2e%2e/b",
      "/a\nb",
      "/%0a",
      "/%E0%A4%A",
      `/${"a".repeat(600)}`,
    ]) {
      expect(rt(bad)).toBeNull();
    }
    expect(rt(new Blob(["/x"]))).toBeNull();
    expect(parseReturnTo(form({}))).toBeNull();
  });

  test("echoValues strips control chars, keeps note line breaks, truncates without splitting surrogates", () => {
    const name = `${"a".repeat(59)}\u{1F600}`;
    expect(echoValues(form({ name, note: "x\u0000y\nz" }), ["name", "note"])).toEqual({ name: "a".repeat(59), note: "xy\nz" });
    expect(echoValues(form({ name: new Blob(["x"]) }), ["name"])).toEqual({});
  });

  test("mapError never forwards raw service details", () => {
    const f = mapError("addToList", { code: "PRODUCT_NOT_FOUND", message: "raw", details: { productId: "<script>" } });
    expect(f.error).toEqual({ code: "PRODUCT_NOT_FOUND", message: LIST_MESSAGES.productNotFound });
    const items = mapError("moveListItem", { code: "LIMIT_REACHED", message: "raw", details: { max: 200 } });
    expect(items.error).toEqual({ code: "LIMIT_REACHED", message: LIST_MESSAGES.itemsLimit, details: { max: 200 } });
    const other = mapError("addToList", { code: "MONEY_OVERFLOW", message: "raw" });
    expect(other.error).toEqual({ code: "MONEY_OVERFLOW", message: LIST_MESSAGES.invalidRequest });
    const rl = mapError("addToList", { code: "RATE_LIMITED", message: "raw" });
    expect(rl.error).toEqual({ code: "RATE_LIMITED", message: LIST_MESSAGES.rateLimitedFallback });
  });
});
