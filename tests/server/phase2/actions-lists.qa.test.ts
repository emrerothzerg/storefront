import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// QA-W2-T48 (T54 part 1): adversarial tests for the list server actions.
//
// Part 1 drives `createListActions` (lists-core) with the real ListService,
// real CartService v2 and real T31 limiter over in-memory SQLite, and
// recording fakes for the session helpers so call ORDER can be asserted.
// Part 2 drives the `'use server'` wrappers with `next/headers` and
// `next/cache` mocked (registered before anything imports them).
// No test touches ./data.
// ---------------------------------------------------------------------------

interface SetCall {
  readonly name: string;
  readonly value: string;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  getAll(): { name: string; value: string }[] {
    return [...this.jar].map(([name, value]) => ({ name, value }));
  }
  has(name: string): boolean {
    return this.jar.has(name);
  }
  set(name: string, value: string): void {
    this.setCalls.push({ name, value });
    this.jar.set(name, value);
  }
  delete(name: string): void {
    this.jar.delete(name);
  }
}

let fakeStore = new FakeCookieStore();
const wiredRevalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/cache", () => ({ revalidatePath: wiredRevalidatePath }));
// R-T85-1 (T99): deleteList redirects to /lists?deleted=1 on success.
class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT (test sentinel) ${url}`);
  }
}
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({
  ...realNavigation,
  redirect: (url: string): never => {
    throw new RedirectSentinel(url);
  },
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
type ListActionState = import("@/components/molecules/_contracts/list-actions").ListActionState;
const { LIST_FIELD } = await import("@/components/molecules/_contracts/list-actions");
const { createListActions, LIST_MESSAGES } = await import("@/app/actions/lists-core");
type ListActionDeps = import("@/app/actions/lists-core").ListActionDeps;
type ListActions = import("@/app/actions/lists-core").ListActions;
const { createListService } = await import("@/server/lists/list-service");
type ListService = import("@/server/lists/list-service").ListService;
const { createCartService } = await import("@/server/cart/cart-service");
const { createRateLimiter } = await import("@/server/security/rate-limiter");
type RateLimiter = import("@/server/security/rate-limiter").RateLimiter;
const { createDatabase, closeDatabase, getDatabase } = await import("@/server/db/client");
const { runMigrations } = await import("@/server/db/schema");
const { seedDatabase } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");

const wired = await import("@/app/actions/lists");

const ROOT = join(import.meta.dir, "..", "..", "..");

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const HOUR_MS = 3_600_000;
const TOTE = "prod_canvas-tote-bag"; // stock 42
const PIN = "prod_enamel-pin-set"; // stock 100
const SKILLET = "prod_cast-iron-skillet"; // stock 30
const WALNUT = "prod_walnut-desk"; // stock 3
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0

type Entry = readonly [string, string | Blob];

function fd(entries: readonly Entry[]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

function spyFormData(entries: readonly Entry[]): { form: FormData; reads: string[] } {
  const target = fd(entries);
  const reads: string[] = [];
  const form = new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function") {
        reads.push(`prop:${String(prop)}`);
        return value;
      }
      return (...args: unknown[]) => {
        reads.push(`${String(prop)}:${args.map(String).join(",")}`);
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { form, reads };
}

async function browserMultipart(fields: readonly (readonly [string, string])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundaryQaLists7Q";
  const body =
    fields
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join("") + `--${boundary}--\r\n`;
  return new Request("http://localhost:3000/lists", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, origin: "http://localhost:3000" },
    body,
  }).formData();
}

type Failure = Extract<NonNullable<ListActionState>, { ok: false }>;
type Success = Extract<NonNullable<ListActionState>, { ok: true }>;

function errorOf(state: ListActionState): Failure {
  if (state === null || state.ok) throw new Error(`expected error state, got ${JSON.stringify(state)}`);
  expect(state.message).toBe(state.error.message);
  return state;
}

function okOf(state: ListActionState): Success {
  if (state === null || !state.ok) throw new Error(`expected ok state, got ${JSON.stringify(state)}`);
  return state;
}

function snapshot(db: Database): unknown {
  return {
    lists: db.query("SELECT id, session_id, name, kind, is_default, is_public, share_token FROM lists ORDER BY id").all(),
    items: db.query("SELECT list_id, product_id, quantity_desired, priority, note FROM list_items ORDER BY list_id, product_id").all(),
    cart: db.query("SELECT cart_session_id, product_id, quantity FROM cart_items ORDER BY 1, 2").all(),
  };
}

function cartQty(db: Database, s: string, p: string): number {
  return (
    db.query<{ q: number }, [string, string]>("SELECT quantity AS q FROM cart_items WHERE cart_session_id = ? AND product_id = ?").get(s, p)?.q ?? 0
  );
}

interface Harness {
  db: Database;
  lists: ListService;
  calls: string[];
  session: { current: string | null; next: string };
  clock: { ms: number };
  logger: { error: ReturnType<typeof mock<(...args: unknown[]) => void>> };
  revalidate: ReturnType<typeof mock<(path: string, type?: "page" | "layout") => void>>;
  actions: ListActions;
}

function setup(overrides: Partial<ListActionDeps> = {}): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(T0) });
  const calls: string[] = [];
  const session: { current: string | null; next: string } = { current: null, next: S1 };
  const clock = { ms: T0 };
  const realLists = createListService({ db, now: () => new Date(clock.ms) });
  const lists = new Proxy(realLists, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (prop !== "listLists") calls.push(`lists.${String(prop)}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const cart = createCartService(db, { now: () => clock.ms });
  const realLimiter = createRateLimiter(db, { now: () => clock.ms });
  const limiter: RateLimiter = {
    check: (key, rule) => {
      calls.push(`limiter:${key}`);
      return realLimiter.check(key, rule);
    },
  };
  const revalidate = mock<(path: string, type?: "page" | "layout") => void>((path, type) => {
    calls.push(`revalidate:${path}${type === undefined ? "" : `:${type}`}`);
  });
  const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
  const deps: ListActionDeps = {
    lists,
    cart,
    limiter,
    getOrCreateSessionId: async () => {
      calls.push("getOrCreateSessionId");
      if (session.current === null) session.current = session.next;
      return session.current;
    },
    readSessionId: async () => {
      calls.push("readSessionId");
      return session.current;
    },
    revalidatePath: revalidate,
    logger,
    ...overrides,
  };
  return { db, lists: realLists, calls, session, clock, logger, revalidate, actions: createListActions(deps) };
}

/** S1 with a default wish list holding TOTE; returns its id. */
async function seeded(h: Harness): Promise<string> {
  h.session.current = S1;
  const listId = okOf(await h.actions.addToList(null, fd([["productId", TOTE]]))).listId ?? "";
  h.calls.length = 0;
  h.revalidate.mockClear();
  return listId;
}

let consoleSpies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  for (const s of consoleSpies) s.mockRestore();
});

function allLogText(h?: Harness): string {
  const parts: unknown[] = [];
  for (const s of consoleSpies) parts.push(...s.mock.calls.flat());
  if (h !== undefined) parts.push(...h.logger.error.mock.calls.flat());
  return parts.map((p) => (p instanceof Error ? `${p.message} ${p.stack ?? ""}` : String(p))).join("\n");
}

// ---------------------------------------------------------------------------
// Part 1: core
// ---------------------------------------------------------------------------

describe("QA T48 session rules (criterion 1 + ruling)", () => {
  test("addToList as the very first interaction mints a session after parsing and creates default list + item", async () => {
    const h = setup();
    const state = okOf(await h.actions.addToList(null, fd([["productId", TOTE], ["productSlug", "canvas-tote-bag"]])));
    expect(state.kind).toBe("added");
    expect(typeof state.listId).toBe("string");
    expect(h.calls.slice(0, 3)).toEqual(["getOrCreateSessionId", `limiter:list.mutate:${S1}`, "lists.addItem"]);
    const lists = h.lists.listLists(S1);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ id: state.listId, kind: "wishlist", isDefault: true });
    const again = okOf(await h.actions.addToList(null, fd([["productId", TOTE]])));
    expect(again).toMatchObject({ kind: "already_present", listId: state.listId });
  });

  test("createList as the first interaction mints a session (ruling 2026-11-07)", async () => {
    const h = setup();
    const state = okOf(await h.actions.createList(null, fd([["name", "Birthday"]])));
    expect(state.kind).toBe("created");
    expect(h.calls[0]).toBe("getOrCreateSessionId");
    expect(h.session.current).toBe(S1);
  });

  test("invalid input to addToList/createList mints NO session", async () => {
    const h = setup();
    errorOf(await h.actions.addToList(null, fd([["productId", ""]])));
    errorOf(await h.actions.addToList(null, fd([["productId", TOTE], ["quantityDesired", "0"]])));
    errorOf(await h.actions.createList(null, fd([["name", "   "]])));
    errorOf(await h.actions.createList(null, fd([])));
    expect(h.calls).toEqual([]);
    expect(h.session.current).toBeNull();
  });

  const others: readonly [keyof ListActions, Entry[]][] = [
    ["removeFromList", [["listId", "L"], ["productId", TOTE]]],
    ["updateListItem", [["listId", "L"], ["productId", TOTE], ["priority", "1"]]],
    ["moveListItem", [["listId", "L"], ["toListId", "M"], ["productId", TOTE]]],
    ["renameList", [["listId", "L"], ["name", "X"]]],
    ["deleteList", [["listId", "L"], ["confirm", "yes"]]],
    ["setListSharing", [["listId", "L"], ["mode", "enable"]]],
    ["addAllToCart", [["listId", "L"]]],
  ];
  for (const [name, entries] of others) {
    test(`${name} with no cookie: NOT_FOUND, never mints, never calls limiter/service`, async () => {
      const h = setup();
      const err = errorOf(await h.actions[name](null, fd(entries)));
      expect(err.error).toEqual({ code: "NOT_FOUND", message: LIST_MESSAGES.notFound });
      expect(h.calls).toEqual(["readSessionId"]);
      expect(h.session.current).toBeNull();
    });
  }
});

describe("QA T48 cross-session matrix + NOT_FOUND oracle (criterion 3)", () => {
  test("session B cannot read/modify A's list; foreign, unknown and no-cookie give one identical state", async () => {
    const h = setup();
    const aList = await seeded(h);
    okOf(await h.actions.addToList(null, fd([["productId", PIN], ["listId", aList]])));
    const aSecond = okOf(await h.actions.createList(null, fd([["name", "A second"]]))).listId ?? "";
    const before = snapshot(h.db);

    const matrix: readonly [keyof ListActions, (id: string) => Entry[]][] = [
      ["addToList", (id) => [["productId", SKILLET], ["listId", id]]],
      ["removeFromList", (id) => [["listId", id], ["productId", TOTE]]],
      ["updateListItem", (id) => [["listId", id], ["productId", TOTE], ["quantityDesired", "5"], ["note", "pwned"]]],
      ["moveListItem", (id) => [["listId", id], ["toListId", aSecond], ["productId", TOTE]]],
      ["renameList", (id) => [["listId", id], ["name", "pwned"]]],
      ["deleteList", (id) => [["listId", id], ["confirm", "yes"]]],
      ["setListSharing", (id) => [["listId", id], ["mode", "enable"]]],
      ["addAllToCart", (id) => [["listId", id]]],
    ];
    const unknownId = "00000000-0000-4000-8000-00000000abcd";
    for (const [name, build] of matrix) {
      h.session.current = S2;
      const foreign = errorOf(await h.actions[name](null, fd(build(aList))));
      const unknown = errorOf(await h.actions[name](null, fd(build(unknownId))));
      expect({ name, state: foreign }).toEqual({ name, state: unknown });
      expect(foreign.error.code).toBe("NOT_FOUND");
      expect(JSON.stringify(foreign)).not.toContain(aList);
      if (name !== "addToList") {
        h.session.current = null;
        const noCookie = errorOf(await h.actions[name](null, fd(build(aList))));
        expect({ name, state: noCookie }).toEqual({ name, state: foreign });
      }
    }
    // B moving its own item INTO A's list is NOT_FOUND too.
    h.session.current = S2;
    const bList = okOf(await h.actions.addToList(null, fd([["productId", SKILLET]]))).listId ?? "";
    const into = errorOf(await h.actions.moveListItem(null, fd([["listId", bList], ["toListId", aList], ["productId", SKILLET]])));
    expect(into.error.code).toBe("NOT_FOUND");

    const after = snapshot(h.db) as { lists: { session_id: string }[]; items: { list_id: string }[]; cart: unknown[] };
    const beforeA = before as typeof after;
    expect(after.lists.filter((l) => l.session_id === S1)).toEqual(beforeA.lists.filter((l) => l.session_id === S1));
    expect(after.items.filter((i) => i.list_id !== bList)).toEqual(beforeA.items);
    expect(after.cart).toEqual([]);
  });
});

describe("QA T48 validation without state change (criterion 2)", () => {
  const badQuantities = ["0", "-1", "2.5", "abc", "100", "1e1", "0x5", "٣", "５", "99999999999999999999", "+5"];
  for (const q of badQuantities) {
    test(`quantityDesired ${JSON.stringify(q)}: INVALID_QUANTITY field error on addToList and updateListItem, nothing written`, async () => {
      const h = setup();
      const listId = await seeded(h);
      const before = snapshot(h.db);
      for (const run of [
        () => h.actions.addToList(null, fd([["productId", PIN], ["quantityDesired", q]])),
        () => h.actions.updateListItem(null, fd([["listId", listId], ["productId", TOTE], ["quantityDesired", q]])),
      ]) {
        const err = errorOf(await run());
        expect(err.error.code).toBe("INVALID_QUANTITY");
        expect(err.fieldErrors).toEqual({ quantityDesired: LIST_MESSAGES.quantity });
      }
      expect(snapshot(h.db)).toEqual(before);
      expect(h.calls).toEqual([]);
    });
  }

  for (const p of ["3", "-1", "high", "1.0", " 1x", "x".repeat(17)]) {
    test(`priority ${JSON.stringify(p)}: VALIDATION_FAILED fieldErrors.priority, nothing written, no token spent`, async () => {
      const h = setup();
      const listId = await seeded(h);
      const before = snapshot(h.db);
      const err = errorOf(await h.actions.updateListItem(null, fd([["listId", listId], ["productId", TOTE], ["priority", p]])));
      expect(err.error.code).toBe("VALIDATION_FAILED");
      expect(err.fieldErrors).toEqual({ priority: LIST_MESSAGES.priority });
      expect(snapshot(h.db)).toEqual(before);
      expect(h.calls).toEqual([]);
    });
  }

  test("note of 201 chars (and 1 MB): TOO_LONG, echoed truncated to 200, nothing written; 200 chars accepted", async () => {
    const h = setup();
    const listId = await seeded(h);
    const before = snapshot(h.db);
    for (const note of ["n".repeat(201), "n".repeat(1_000_000)]) {
      const err = errorOf(await h.actions.updateListItem(null, fd([["listId", listId], ["productId", TOTE], ["note", note]])));
      expect(err.error.code).toBe("TOO_LONG");
      expect(err.fieldErrors).toEqual({ note: LIST_MESSAGES.noteTooLong });
      expect(err.values?.note).toBe("n".repeat(200));
    }
    expect(snapshot(h.db)).toEqual(before);
    okOf(await h.actions.updateListItem(null, fd([["listId", listId], ["productId", TOTE], ["note", "n".repeat(200)]])));
  });

  test("malformed ids (missing, empty, whitespace, 201 chars, File) are INVALID_INPUT with details.field, no session/limiter", async () => {
    const h = setup();
    h.session.current = S1;
    const bad: readonly (string | Blob | null)[] = [null, "", "   ", "x".repeat(201), new File(["x"], "x.txt")];
    for (const v of bad) {
      const entries: Entry[] = v === null ? [] : [["listId", v]];
      const err = errorOf(await h.actions.deleteList(null, fd([...entries, ["confirm", "yes"]])));
      expect(err.error).toEqual({ code: "INVALID_INPUT", message: LIST_MESSAGES.invalidRequest, details: { field: "listId" } });
      const p = v === null ? [] : ([["productId", v]] as Entry[]);
      const err2 = errorOf(await h.actions.addToList(null, fd(p)));
      expect(err2.error.details).toEqual({ field: "productId" });
    }
    expect(h.calls).toEqual([]);
  });

  test("list names: 61 chars TOO_LONG, zero-width-only VALIDATION_FAILED, HTML/RTL stored as text (not markup)", async () => {
    const h = setup();
    await seeded(h);
    const tooLong = errorOf(await h.actions.createList(null, fd([["name", "a".repeat(61)]])));
    expect(tooLong.error.code).toBe("TOO_LONG");
    expect(tooLong.values?.name).toBe("a".repeat(60));
    const invisible = errorOf(await h.actions.createList(null, fd([["name", "​‍⁠﻿"]])));
    expect(invisible.error.code).toBe("VALIDATION_FAILED");
    expect(invisible.fieldErrors).toEqual({ name: LIST_MESSAGES.nameRequired });
    const html = "<img src=x onerror=alert(1)>";
    const created = okOf(await h.actions.createList(null, fd([["name", html]])));
    const rtl = okOf(await h.actions.createList(null, fd([["name", "‮abc‬ שלום"]])));
    const rows = h.db.query<{ id: string; name: string }, []>("SELECT id, name FROM lists").all();
    expect(rows.find((r) => r.id === created.listId)?.name).toBe(html);
    expect(rows.find((r) => r.id === rtl.listId)?.name).toBe("abc שלום");
    expect(JSON.stringify(created)).not.toContain("<img");
  });
});

describe("QA T48 deleteList confirm (criterion 4)", () => {
  for (const confirm of [null, "", "YES", "yes ", " yes", "true", "1", "on"]) {
    test(`confirm=${JSON.stringify(confirm)}: INVALID_INPUT field confirm, list kept, no limiter token`, async () => {
      const h = setup();
      await seeded(h);
      const extra = okOf(await h.actions.createList(null, fd([["name", "Extra"]]))).listId ?? "";
      h.calls.length = 0;
      const entries: Entry[] = [["listId", extra]];
      if (confirm !== null) entries.push(["confirm", confirm]);
      const err = errorOf(await h.actions.deleteList(null, fd(entries)));
      expect(err.error).toEqual({ code: "INVALID_INPUT", message: LIST_MESSAGES.confirmRequired, details: { field: "confirm" } });
      expect(h.lists.listLists(S1).some((l) => l.id === extra)).toBe(true);
      expect(h.calls).toEqual([]);
    });
  }

  test("confirm=yes deletes and revalidates /lists + /lists/<id>", async () => {
    const h = setup();
    await seeded(h);
    const extra = okOf(await h.actions.createList(null, fd([["name", "Extra"]]))).listId ?? "";
    h.revalidate.mockClear();
    okOf(await h.actions.deleteList(null, fd([["listId", extra], ["confirm", "yes"]])));
    expect(h.lists.listLists(S1).some((l) => l.id === extra)).toBe(false);
    expect(h.revalidate.mock.calls).toEqual([["/lists"], [`/lists/${extra}`]]);
  });
});

describe("QA T48 setListSharing (criterion 5)", () => {
  test("owner gets sharePath for enable/rotate, null for disable; old token dies; B gets NOT_FOUND without any path", async () => {
    const h = setup();
    const listId = await seeded(h);
    const enabled = okOf(await h.actions.setListSharing(null, fd([["listId", listId], ["mode", "enable"]])));
    expect(enabled.sharePath).toMatch(/^\/lists\/shared\/[A-Za-z0-9_-]{22}$/);
    const rotated = okOf(await h.actions.setListSharing(null, fd([["listId", listId], ["mode", "rotate"]])));
    expect(rotated.sharePath).toMatch(/^\/lists\/shared\/[A-Za-z0-9_-]{22}$/);
    expect(rotated.sharePath).not.toBe(enabled.sharePath);
    const oldToken = (enabled.sharePath ?? "").split("/").pop() ?? "";
    expect(h.lists.getByToken(oldToken).ok).toBe(false);
    h.session.current = S2;
    for (const mode of ["enable", "rotate", "disable"]) {
      const err = errorOf(await h.actions.setListSharing(null, fd([["listId", listId], ["mode", mode]])));
      expect(err.error.code).toBe("NOT_FOUND");
      expect(JSON.stringify(err)).not.toContain("/lists/shared/");
    }
    h.session.current = S1;
    const disabled = okOf(await h.actions.setListSharing(null, fd([["listId", listId], ["mode", "disable"]])));
    expect(disabled.sharePath).toBeNull();
  });

  test("unknown mode values are INVALID_INPUT field mode", async () => {
    const h = setup();
    const listId = await seeded(h);
    for (const mode of ["", "ENABLE", "on", "public", "enable "]) {
      const err = errorOf(await h.actions.setListSharing(null, fd([["listId", listId], ["mode", mode]])));
      expect(err.error.details).toEqual({ field: "mode" });
    }
  });

  test("token never logged: revalidatePath throwing after the token is minted -> generic state, logs + revalidate args token-free", async () => {
    const seen: string[] = [];
    const h = setup({
      revalidatePath: (path: string) => {
        seen.push(path);
        throw new Error(`boom while revalidating ${path}`);
      },
    });
    h.session.current = S1;
    // createList itself hits the throwing revalidate (generic state) but the list is written.
    await h.actions.createList(null, fd([["name", "Shared"]]));
    const id = h.lists.listLists(S1).find((l) => l.name === "Shared")?.id ?? "";
    expect(id).not.toBe("");
    const state = await h.actions.setListSharing(null, fd([["listId", id], ["mode", "enable"]]));
    const err = errorOf(state);
    expect(err.error.details).toEqual({ reason: "unexpected" });
    const token = h.db.query<{ t: string | null }, [string]>("SELECT share_token AS t FROM lists WHERE id = ?").get(id)?.t ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const logs = allLogText(h);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(id);
    expect(seen.join(" ")).not.toContain(token);
    for (const call of h.logger.error.mock.calls) expect(String(call[0])).toMatch(/^\[lists\] LIST_ACTION_FAILED action=\w+$/);
  });

  test("successful sharing writes nothing to any console method and passes no token to revalidatePath", async () => {
    const h = setup();
    const listId = await seeded(h);
    const s = okOf(await h.actions.setListSharing(null, fd([["listId", listId], ["mode", "enable"]])));
    const token = (s.sharePath ?? "").split("/").pop() ?? "";
    expect(allLogText(h)).toBe("");
    expect(JSON.stringify(h.revalidate.mock.calls)).not.toContain(token);
  });
});

describe("QA T48 addAllToCart (criterion 6)", () => {
  test("per-item results: added / capped (partial) / capped (nothing) / out_of_stock, never oversells, revalidates cart + layout", async () => {
    const h = setup();
    const listId = await seeded(h); // TOTE desired 1
    const add = async (productId: string, qty: string) =>
      okOf(await h.actions.addToList(null, fd([["productId", productId], ["listId", listId], ["quantityDesired", qty]])));
    await add(WALNUT, "5"); // stock 3 -> capped to 3
    await add(POUR_OVER, "1"); // stock 0
    await add(SKILLET, "2"); // cart already holds all stock -> capped, nothing added
    h.db.query("UPDATE products SET stock = 4 WHERE id = ?").run(SKILLET);
    okOf(await h.actions.addToList(null, fd([["productId", PIN], ["listId", listId], ["quantityDesired", "10"]])));
    const cart = createCartService(h.db, { now: () => h.clock.ms });
    expect(cart.addItem(S1, SKILLET, 4).ok).toBe(true);
    expect(cart.addItem(S1, PIN, 95).ok).toBe(true); // 95 + 10 > 99 -> INVALID_QUANTITY path
    h.calls.length = 0;
    h.revalidate.mockClear();

    const state = okOf(await h.actions.addAllToCart(null, fd([["listId", listId]])));
    const byId = Object.fromEntries((state.perItem ?? []).map((p) => [p.productId, p.result]));
    expect(byId).toEqual({ [TOTE]: "added", [WALNUT]: "capped", [POUR_OVER]: "out_of_stock", [SKILLET]: "capped", [PIN]: "capped" });
    expect(cartQty(h.db, S1, TOTE)).toBe(1);
    expect(cartQty(h.db, S1, WALNUT)).toBe(3);
    expect(cartQty(h.db, S1, POUR_OVER)).toBe(0);
    expect(cartQty(h.db, S1, SKILLET)).toBe(4);
    expect(cartQty(h.db, S1, PIN)).toBeLessThanOrEqual(99);
    expect(h.revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    // List untouched by addAll.
    expect(h.lists.getList(S1, listId).ok && h.lists.getList(S1, listId)).toBeTruthy();
  });

  test("nothing added (only out-of-stock / empty list): no /cart or layout revalidation", async () => {
    const h = setup();
    h.session.current = S1;
    const listId = okOf(await h.actions.addToList(null, fd([["productId", POUR_OVER]]))).listId ?? "";
    h.revalidate.mockClear();
    const s = okOf(await h.actions.addAllToCart(null, fd([["listId", listId]])));
    expect(s.perItem).toEqual([{ productId: POUR_OVER, result: "out_of_stock" }]);
    expect(s.message).toBe(LIST_MESSAGES.addAllNone);
    expect(h.revalidate.mock.calls).toEqual([]);
    const empty = okOf(await h.actions.createList(null, fd([["name", "Empty"]]))).listId ?? "";
    h.revalidate.mockClear();
    const e = okOf(await h.actions.addAllToCart(null, fd([["listId", empty]])));
    expect(e.perItem).toEqual([]);
    expect(h.revalidate.mock.calls).toEqual([]);
  });

  test("atomic per item: a failing addItem for one item does not undo or block the others", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedDatabase(db, { now: new Date(T0) });
    const real = createCartService(db, { now: () => T0 });
    const lists = createListService({ db, now: () => new Date(T0) });
    const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
    const actions = createListActions({
      lists,
      cart: {
        addItem: (s, p, q) => {
          if (p === PIN) throw new Error(`driver exploded for ${p} ${s}`);
          return real.addItem(s, p, q);
        },
      },
      limiter: createRateLimiter(db, { now: () => T0 }),
      getOrCreateSessionId: async () => S1,
      readSessionId: async () => S1,
      revalidatePath: () => undefined,
      logger,
    });
    const listId = okOf(await actions.addToList(null, fd([["productId", TOTE]]))).listId ?? "";
    okOf(await actions.addToList(null, fd([["productId", PIN], ["listId", listId]])));
    okOf(await actions.addToList(null, fd([["productId", SKILLET], ["listId", listId]])));
    const s = okOf(await actions.addAllToCart(null, fd([["listId", listId]])));
    expect(Object.fromEntries((s.perItem ?? []).map((p) => [p.productId, p.result]))).toEqual({
      [TOTE]: "added",
      [PIN]: "unavailable",
      [SKILLET]: "added",
    });
    expect(cartQty(db, S1, TOTE)).toBe(1);
    expect(cartQty(db, S1, PIN)).toBe(0);
    expect(cartQty(db, S1, SKILLET)).toBe(1);
    for (const call of logger.error.mock.calls) {
      expect(String(call[0])).toBe("[lists] LIST_ACTION_FAILED action=addAllToCart.item");
    }
  });

  test("two concurrent addAllToCart on a stock-limited list never oversell", async () => {
    const h = setup();
    const listId = await seeded(h);
    okOf(await h.actions.addToList(null, fd([["productId", WALNUT], ["listId", listId], ["quantityDesired", "3"]])));
    const results = await Promise.all([1, 2, 3].map(async () => {
      await Promise.resolve();
      return h.actions.addAllToCart(null, fd([["listId", listId]]));
    }));
    for (const r of results) okOf(r);
    expect(cartQty(h.db, S1, WALNUT)).toBe(3);
    expect(cartQty(h.db, S1, TOTE)).toBe(3);
  });
});

describe("QA T48 rate limit (criterion 7)", () => {
  test("120 mutations/hour pass, 121st RATE_LIMITED with retryAfterSeconds and no service call; shared across actions; resets next window", async () => {
    const h = setup();
    const listId = await seeded(h); // 1 token used
    for (let i = 1; i < 120; i++) {
      const action = i % 2 === 0 ? h.actions.updateListItem : h.actions.setListSharing;
      const entries: Entry[] = i % 2 === 0 ? [["listId", listId], ["productId", TOTE], ["priority", String(i % 3)]] : [["listId", listId], ["mode", "rotate"]];
      okOf(await action(null, fd(entries)));
    }
    h.calls.length = 0;
    const limited = errorOf(await h.actions.renameList(null, fd([["listId", listId], ["name", "Nope"]])));
    expect(limited.error.code).toBe("RATE_LIMITED");
    expect(limited.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(h.calls).toEqual(["readSessionId", `limiter:list.mutate:${S1}`]);
    // addToList / createList are limited too.
    expect(errorOf(await h.actions.addToList(null, fd([["productId", PIN]]))).error.code).toBe("RATE_LIMITED");
    expect(errorOf(await h.actions.createList(null, fd([["name", "x"]]))).error.code).toBe("RATE_LIMITED");
    // Another session is unaffected (no global backstop for lists).
    h.session.current = S2;
    okOf(await h.actions.addToList(null, fd([["productId", PIN]])));
    h.session.current = S1;
    h.clock.ms += HOUR_MS;
    okOf(await h.actions.renameList(null, fd([["listId", listId], ["name", "Later"]])));
  });
});

describe("QA T48 forged fields ignored", () => {
  test("addToList reads only contract fields; forged sessionId/price/verified/isStore/isDefault have no effect", async () => {
    const h = setup();
    const { form, reads } = spyFormData([
      ["$ACTION_ID_abc", ""],
      ["productId", TOTE],
      ["sessionId", S2],
      ["ownerKey", S2],
      ["price", "1"],
      ["priceAtAddCents", "1"],
      ["verified", "true"],
      ["isStore", "true"],
      ["isDefault", "0"],
      ["isPublic", "1"],
      ["shareToken", "AAAAAAAAAAAAAAAAAAAAAA"],
    ]);
    okOf(await h.actions.addToList(null, form));
    const allowed = new Set(Object.values(LIST_FIELD).map((f) => `get:${f}`));
    for (const r of reads) expect(allowed.has(r)).toBe(true);
    const row = h.db.query<{ session_id: string; is_public: number; share_token: string | null }, []>("SELECT session_id, is_public, share_token FROM lists").get();
    expect(row).toEqual({ session_id: S1, is_public: 0, share_token: null });
    const price = h.db.query<{ p: number }, []>("SELECT price_at_add_cents AS p FROM list_items").get()?.p;
    expect(price).toBe(1999);
  });
});

describe("QA T48 revalidation paths (criterion 8)", () => {
  test("per action: /lists and /lists/<id> (+ /cart for save-for-later, + product slug, + safe returnTo only)", async () => {
    const h = setup();
    const listId = await seeded(h);
    const second = okOf(await h.actions.createList(null, fd([["name", "Second"]]))).listId ?? "";
    const r = () => h.revalidate.mock.calls.map((c) => c.join(":"));

    h.revalidate.mockClear();
    okOf(await h.actions.addToList(null, fd([["productId", PIN], ["listId", listId], ["productSlug", "enamel-pin-set"], ["returnTo", "/products/enamel-pin-set?x=1#y"]])));
    expect(r()).toEqual(["/lists", `/lists/${listId}`, "/products/enamel-pin-set", "/products/enamel-pin-set"]);

    h.revalidate.mockClear();
    okOf(await h.actions.addToList(null, fd([["productId", PIN], ["listId", listId]]))); // already present
    expect(r()).toEqual([]);

    h.revalidate.mockClear();
    okOf(await h.actions.moveListItem(null, fd([["listId", listId], ["toListId", second], ["productId", PIN]])));
    expect(r()).toEqual(["/lists", `/lists/${listId}`, `/lists/${second}`]);

    for (const evil of ["//evil.example/x", "https://evil.example", "/a/../admin", "/%2e%2e/x", "/a\\b", "javascript:alert(1)", "/a%0d%0aSet-Cookie"]) {
      h.revalidate.mockClear();
      okOf(await h.actions.renameList(null, fd([["listId", second], ["name", "Renamed"], ["returnTo", evil], ["productSlug", "../etc"]])));
      expect(r()).toEqual(["/lists", `/lists/${second}`]);
    }

    // Save-for-later list (made by the cart service) -> /cart too.
    const cart = createCartService(h.db, { now: () => h.clock.ms });
    expect(cart.addItem(S1, SKILLET, 1).ok).toBe(true);
    expect(cart.saveForLater(S1, SKILLET).ok).toBe(true);
    const sfl = h.lists.listLists(S1).find((l) => l.kind === "save_for_later")?.id ?? "";
    h.revalidate.mockClear();
    okOf(await h.actions.removeFromList(null, fd([["listId", sfl], ["productId", SKILLET]])));
    expect(r()).toEqual(["/lists", `/lists/${sfl}`, "/cart"]);
  });

  test("failures never revalidate", async () => {
    const h = setup();
    const listId = await seeded(h);
    h.session.current = S2;
    errorOf(await h.actions.renameList(null, fd([["listId", listId], ["name", "x"]])));
    h.session.current = S1;
    errorOf(await h.actions.deleteList(null, fd([["listId", listId]])));
    expect(h.revalidate).not.toHaveBeenCalled();
  });
});

describe("QA T48 always settles", () => {
  test("service throwing (with ids/tokens in the message) -> generic state, log is code + action only", async () => {
    const h = setup();
    const throwing = new Proxy(h.lists, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return () => {
          throw new Error(`SQLITE_CORRUPT session=${S1} token=AAAAAAAAAAAAAAAAAAAAAA`);
        };
      },
    });
    const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
    const actions = createListActions({
      lists: throwing,
      cart: createCartService(h.db),
      limiter: createRateLimiter(h.db, { now: () => T0 }),
      getOrCreateSessionId: async () => S1,
      readSessionId: async () => S1,
      revalidatePath: () => undefined,
      logger,
    });
    const forms: Record<keyof ListActions, Entry[]> = {
      addToList: [["productId", TOTE]],
      removeFromList: [["listId", "L"], ["productId", TOTE]],
      updateListItem: [["listId", "L"], ["productId", TOTE], ["note", "secret note"]],
      moveListItem: [["listId", "L"], ["toListId", "M"], ["productId", TOTE]],
      createList: [["name", "secret name"]],
      renameList: [["listId", "L"], ["name", "secret name"]],
      deleteList: [["listId", "L"], ["confirm", "yes"]],
      setListSharing: [["listId", "L"], ["mode", "enable"]],
      addAllToCart: [["listId", "L"]],
    };
    for (const [name, entries] of Object.entries(forms) as [keyof ListActions, Entry[]][]) {
      const err = errorOf(await actions[name](null, fd(entries)));
      expect(err.error).toEqual({ code: "VALIDATION_FAILED", message: LIST_MESSAGES.unexpected, details: { reason: "unexpected" } });
      expect(JSON.parse(JSON.stringify(err))).toEqual(err);
    }
    const text = logger.error.mock.calls.flat().map(String).join("\n");
    expect(text).not.toContain(S1);
    expect(text).not.toContain("AAAAAAAAAAAAAAAAAAAAAA");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("SQLITE_CORRUPT");
  });

  test("getOrCreateSessionId rejecting still settles", async () => {
    const h = setup({ getOrCreateSessionId: async () => Promise.reject(new Error("cookie store gone")) });
    const err = errorOf(await h.actions.addToList(null, fd([["productId", TOTE]])));
    expect(err.error.details).toEqual({ reason: "unexpected" });
  });
});

// ---------------------------------------------------------------------------
// Part 2: wired 'use server' module
// ---------------------------------------------------------------------------

describe("QA T48 'use server' module", () => {
  test("starts with 'use server' and exports exactly the nine async actions", () => {
    const src = readFileSync(join(ROOT, "src/app/actions/lists.ts"), "utf8");
    expect(src.trimStart().startsWith('"use server";')).toBe(true);
    const exportLines = src.split("\n").filter((l) => /^export\b/.test(l));
    expect(exportLines).toHaveLength(9);
    for (const l of exportLines) expect(l).toMatch(/^export async function \w+\(/);
    expect(Object.keys(wired).sort()).toEqual(
      ["addAllToCart", "addToList", "createList", "deleteList", "moveListItem", "removeFromList", "renameList", "setListSharing", "updateListItem"],
    );
    for (const v of Object.values(wired)) expect((v as () => unknown).constructor.name).toBe("AsyncFunction");
  });

  test("importing the module in a fresh process opens no database", async () => {
    const probeDb = join(import.meta.dir, `.qa-t48-probe-${process.pid}.sqlite`);
    const script = [
      `const before = globalThis.__storefrontDb;`,
      `await import(${JSON.stringify(join(ROOT, "src/app/actions/lists.ts"))});`,
      `console.log(JSON.stringify({ before: before === undefined, after: globalThis.__storefrontDb === undefined }));`,
    ].join("\n");
    const proc = Bun.spawnSync(["bun", "-e", script], { cwd: ROOT, env: { ...process.env, DATABASE_PATH: probeDb }, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString().trim().split("\n").pop() ?? "")).toEqual({ before: true, after: true });
    expect(await Bun.file(probeDb).exists()).toBe(false);
  });
});

describe("QA T48 wired actions (browser multipart, cookies)", () => {
  beforeEach(() => {
    env.DATABASE_PATH = ":memory:";
    closeDatabase();
    seedDatabase(getDatabase());
    fakeStore = new FakeCookieStore();
    wiredRevalidatePath.mockClear();
  });

  test("every action accepts a browser-shaped multipart body with $ACTION_* fields", async () => {
    const extras: [string, string][] = [["$ACTION_REF_1", ""], ["$ACTION_1:0", '{"id":"abc","bound":"$@1"}'], ["$ACTION_KEY", "k1"], ["sessionId", S2]];
    const add = okOf(await wired.addToList(null, await browserMultipart([...extras, ["productId", TOTE]])));
    expect(fakeStore.setCalls.map((c) => c.name)).toEqual([SESSION_COOKIE_NAME]);
    const owner = fakeStore.setCalls[0]?.value ?? "";
    expect(owner).not.toBe(S2);
    const listId = add.listId ?? "";
    const second = okOf(await wired.createList(null, await browserMultipart([...extras, ["name", "Second"]]))).listId ?? "";
    okOf(await wired.updateListItem(null, await browserMultipart([...extras, ["listId", listId], ["productId", TOTE], ["quantityDesired", "2"], ["priority", "2"], ["note", "line1\r\nline2"]])));
    okOf(await wired.moveListItem(null, await browserMultipart([...extras, ["listId", listId], ["toListId", second], ["productId", TOTE]])));
    okOf(await wired.renameList(null, await browserMultipart([...extras, ["listId", second], ["name", "Renamed"]])));
    const shared = okOf(await wired.setListSharing(null, await browserMultipart([...extras, ["listId", second], ["mode", "enable"]])));
    expect(shared.sharePath).toMatch(/^\/lists\/shared\//);
    const all = okOf(await wired.addAllToCart(null, await browserMultipart([...extras, ["listId", second]])));
    expect(all.perItem).toEqual([{ productId: TOTE, result: "added" }]);
    okOf(await wired.removeFromList(null, await browserMultipart([...extras, ["listId", second], ["productId", TOTE]])));
    await expect(wired.deleteList(null, await browserMultipart([...extras, ["listId", second], ["confirm", "yes"]]))).rejects.toMatchObject({ url: "/lists?deleted=1" });
    expect(fakeStore.setCalls).toHaveLength(1);
    const rows = getDatabase().query<{ s: string }, []>("SELECT DISTINCT session_id AS s FROM lists").all();
    expect(rows).toEqual([{ s: owner }]);
    expect(wiredRevalidatePath).toHaveBeenCalledWith("/cart");
    expect(wiredRevalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  test("no cookie: non-minting actions return NOT_FOUND and set no cookie; garbage cookie is not rewritten", async () => {
    for (const action of [wired.removeFromList, wired.renameList, wired.deleteList, wired.setListSharing, wired.addAllToCart]) {
      const s = await action(null, fd([["listId", "x"], ["productId", TOTE], ["name", "n"], ["confirm", "yes"], ["mode", "enable"]]));
      expect(errorOf(s).error.code).toBe("NOT_FOUND");
    }
    fakeStore.jar.set(SESSION_COOKIE_NAME, "not-a-uuid");
    expect(errorOf(await wired.deleteList(null, fd([["listId", "x"], ["confirm", "yes"]]))).error.code).toBe("NOT_FOUND");
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("createList through the wrapper mints exactly one cookie on a cold visit", async () => {
    okOf(await wired.createList(null, fd([["name", "Cold"]])));
    expect(fakeStore.setCalls.map((c) => c.name)).toEqual([SESSION_COOKIE_NAME]);
  });

  test("cross-session through the wrappers: cookie B cannot see or change cookie A's list", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
    const listId = okOf(await wired.addToList(null, fd([["productId", TOTE]]))).listId ?? "";
    fakeStore.jar.set(SESSION_COOKIE_NAME, S2);
    expect(errorOf(await wired.setListSharing(null, fd([["listId", listId], ["mode", "enable"]]))).error.code).toBe("NOT_FOUND");
    expect(errorOf(await wired.addAllToCart(null, fd([["listId", listId]]))).error.code).toBe("NOT_FOUND");
    expect(errorOf(await wired.addToList(null, fd([["productId", PIN], ["listId", listId]]))).error.code).toBe("NOT_FOUND");
    const items = getDatabase().query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?").get(listId)?.n;
    expect(items).toBe(1);
  });

  test("database cannot open: every wrapper settles with the generic state and logs a clean line", async () => {
    closeDatabase();
    env.DATABASE_PATH = "/dev/null/qa-t48/cannot.sqlite";
    try {
      fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
      for (const action of Object.values(wired)) {
        const state = await (action as (p: ListActionState, f: FormData) => Promise<ListActionState>)(null, fd([["productId", TOTE], ["listId", "x"], ["name", "n"]]));
        expect(errorOf(state).error).toEqual({ code: "VALIDATION_FAILED", message: LIST_MESSAGES.unexpected, details: { reason: "unexpected" } });
      }
      for (const spy of consoleSpies) {
        for (const call of spy.mock.calls) expect(String(call[0])).toMatch(/^\[lists\] LIST_ACTION_FAILED action=\w+$/);
      }
    } finally {
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
    }
  });
});

describe("QA T48 edge cases", () => {
  test("FORBIDDEN paths: deleting the only wish list, renaming/sharing/deleting save-for-later; distinct user-safe messages", async () => {
    const h = setup();
    const listId = await seeded(h);
    const onlyOne = errorOf(await h.actions.deleteList(null, fd([["listId", listId], ["confirm", "yes"]])));
    expect(onlyOne.error).toEqual({ code: "FORBIDDEN", message: LIST_MESSAGES.forbiddenDelete });
    const cart = createCartService(h.db, { now: () => h.clock.ms });
    expect(cart.addItem(S1, SKILLET, 1).ok).toBe(true);
    expect(cart.saveForLater(S1, SKILLET).ok).toBe(true);
    const sfl = h.lists.listLists(S1).find((l) => l.kind === "save_for_later")?.id ?? "";
    expect(errorOf(await h.actions.renameList(null, fd([["listId", sfl], ["name", "x"]]))).error.code).toBe("FORBIDDEN");
    expect(errorOf(await h.actions.setListSharing(null, fd([["listId", sfl], ["mode", "enable"]]))).error.code).toBe("FORBIDDEN");
    expect(errorOf(await h.actions.deleteList(null, fd([["listId", sfl], ["confirm", "yes"]]))).error.code).toBe("FORBIDDEN");
  });

  test("updateListItem with an empty patch and moveListItem onto the same list settle with a typed state", async () => {
    const h = setup();
    const listId = await seeded(h);
    const empty = await h.actions.updateListItem(null, fd([["listId", listId], ["productId", TOTE]]));
    expect(empty).not.toBeNull();
    const same = await h.actions.moveListItem(null, fd([["listId", listId], ["toListId", listId], ["productId", TOTE]]));
    expect(same).not.toBeNull();
    expect(h.lists.getList(S1, listId).ok).toBe(true);
    const items = h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?").get(listId)?.n;
    expect(items).toBe(1);
  });

  test("21st wish list -> LIMIT_REACHED with the lists message (save-for-later does not count)", async () => {
    const h = setup();
    await seeded(h);
    for (let i = 2; i <= 20; i++) okOf(await h.actions.createList(null, fd([["name", `L${i}`]])));
    const err = errorOf(await h.actions.createList(null, fd([["name", "L21"]])));
    expect(err.error).toEqual({ code: "LIMIT_REACHED", message: LIST_MESSAGES.listsLimit, details: { max: 20 } });
  });
});
