import type { Database } from "bun:sqlite";
import type { ListItem, ListItemPriority, Product, ProductList } from "@/lib/types";
import { err, fail, ok, type AppError, type Err, type Result } from "@/lib/result";
import { multiplyCents, sumCents } from "@/lib/money";
import { getDatabase, withTransaction } from "@/server/db/client";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { cleanText } from "@/server/security/text-guard";
import { isSessionId } from "@/server/session/session-id";
import { ListRepository, toPublicList, type ItemPatch, type ListRowFull } from "./list-repository";

/**
 * Lists service (server-only): wish lists and the save-for-later store.
 * All methods are synchronous (bun:sqlite + sync `withTransaction`).
 * Full rules: README.md in this folder.
 */

export const MAX_LISTS_PER_SESSION = 20;
export const MAX_ITEMS_PER_LIST = 200;
export const LIST_NAME_MAX = 60;
export const NOTE_MAX = 200;
export const MAX_QUANTITY_DESIRED = 99;

/** Name given to the automatically created default wishlist. */
export const DEFAULT_LIST_NAME = "Shopping List";
/** Name of the per-session save-for-later list (fixed; cannot be renamed). */
export const SAVE_FOR_LATER_NAME = "Saved for later";

export type ListSort = "added_desc" | "price_asc" | "price_desc" | "priority";
export const LIST_SORTS: readonly ListSort[] = ["added_desc", "price_asc", "price_desc", "priority"];
export const DEFAULT_LIST_SORT: ListSort = "added_desc";

export interface ListItemView extends ListItem {
  /** null when the product vanished from the catalogue. */
  readonly product: Product | null;
  /** stored price - current price when the current price is lower, else null. */
  readonly priceDroppedByCents: number | null;
  readonly purchasedSinceAdded: boolean;
  /** Product exists and has stock. */
  readonly available: boolean;
}

export interface ListView extends ProductList {
  readonly items: readonly ListItemView[];
  /** Number of items (rows), not the sum of desired quantities. */
  readonly itemCount: number;
  /** Sum of current price x quantity desired over items whose product still exists. */
  readonly totalCents: number;
}

/** Public, read-only view: no session id, no owner details, no list id. */
export interface SharedListView {
  readonly name: string;
  /** `listId` is always "" and `purchasedSinceAdded` always false here. */
  readonly items: readonly ListItemView[];
  readonly itemCount: number;
}

export interface ListItemOptions {
  readonly quantityDesired?: unknown;
  readonly priority?: unknown;
  readonly note?: unknown;
}

export interface ListService {
  ensureDefaultList(sessionId: string): Result<ProductList, AppError>;
  ensureSaveForLater(sessionId: string): Result<ProductList, AppError>;
  listLists(sessionId: string): readonly (ProductList & { itemCount: number })[];
  getList(sessionId: string, listId: string, sort?: ListSort | string): Result<ListView, AppError>;
  createList(sessionId: string, name: unknown): Result<ProductList, AppError>;
  renameList(sessionId: string, listId: string, name: unknown): Result<ProductList, AppError>;
  deleteList(sessionId: string, listId: string): Result<void, AppError>;
  addItem(
    sessionId: string,
    listId: string | null,
    productId: string,
    opts?: ListItemOptions,
  ): Result<{ item: ListItem; alreadyPresent: boolean; listId: string }, AppError>;
  updateItem(sessionId: string, listId: string, productId: string, patch: ListItemOptions): Result<ListItem, AppError>;
  removeItem(sessionId: string, listId: string, productId: string): Result<void, AppError>;
  moveItem(sessionId: string, fromListId: string, toListId: string, productId: string): Result<void, AppError>;
  setSharing(
    sessionId: string,
    listId: string,
    mode: "enable" | "disable" | "rotate",
  ): Result<{ shareToken: string | null }, AppError>;
  getByToken(token: unknown, sort?: ListSort | string): Result<SharedListView, AppError>;
  isInDefaultList(sessionId: string, productId: string): boolean;
}

export interface ListServiceDeps {
  readonly db: Database;
  /** Clock for stored timestamps and the "published" check. Defaults to `new Date()`. */
  readonly now?: () => Date;
}

/** 16 random bytes, base64url without padding. */
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_ID_LENGTH = 200;

/** Thrown inside a transaction to roll it back; converted to `Err` outside. */
class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}

function notFound(): Err<AppError> {
  return fail("NOT_FOUND", "List not found");
}

function invalidSession(): Err<AppError> {
  return fail("INVALID_INPUT", "A valid session is required");
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** 128-bit token from `crypto.getRandomValues`, base64url (22 chars). */
export function generateShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function isListSort(value: unknown): value is ListSort {
  return typeof value === "string" && (LIST_SORTS as readonly string[]).includes(value);
}

/** Accepts numbers and short canonical digit strings (form values). */
function toIntegerish(value: unknown): unknown {
  if (typeof value === "string" && /^\d{1,3}$/.test(value)) return Number(value);
  return value;
}

function validateQuantityDesired(value: unknown): Result<number> {
  const v = toIntegerish(value);
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_QUANTITY_DESIRED) {
    return fail("INVALID_QUANTITY", `Quantity must be a whole number from 1 to ${MAX_QUANTITY_DESIRED}.`, {
      max: MAX_QUANTITY_DESIRED,
    });
  }
  return ok(v);
}

function validatePriority(value: unknown): Result<ListItemPriority> {
  const v = toIntegerish(value);
  if (v === 0 || v === 1 || v === 2) return ok(v);
  return fail("VALIDATION_FAILED", "Priority must be 0 (low), 1 (medium) or 2 (high).", { field: "priority" });
}

/** null/undefined/blank → null; otherwise cleaned (max 200). */
function validateNote(value: unknown): Result<string | null> {
  if (value === null || value === undefined) return ok(null);
  const cleaned = cleanText(value, { max: NOTE_MAX, multiline: true });
  if (!cleaned.ok) return cleaned;
  return ok(cleaned.value === "" ? null : cleaned.value);
}

function validateName(value: unknown): Result<string> {
  return cleanText(value, { max: LIST_NAME_MAX, min: 1 });
}

function compareAddedDesc(a: ListItemView, b: ListItemView): number {
  return a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0;
}

/** Stable sort; vanished products sort last for price sorts. */
function sortItems(items: readonly ListItemView[], sort: ListSort): ListItemView[] {
  const copy = [...items];
  switch (sort) {
    case "added_desc":
      return copy.sort(compareAddedDesc);
    case "price_asc":
    case "price_desc": {
      const dir = sort === "price_asc" ? 1 : -1;
      return copy.sort((a, b) => {
        if (a.product === null || b.product === null) {
          return a.product === b.product ? compareAddedDesc(a, b) : a.product === null ? 1 : -1;
        }
        const diff = (a.product.priceCents - b.product.priceCents) * dir;
        return diff !== 0 ? diff : compareAddedDesc(a, b);
      });
    }
    case "priority":
      return copy.sort((a, b) => b.priority - a.priority || compareAddedDesc(a, b));
  }
}

class SqliteListService implements ListService {
  private readonly db: Database;
  private readonly repo: ListRepository;
  private readonly products: SqliteProductRepository;
  private readonly now: () => Date;

  constructor(deps: ListServiceDeps) {
    this.db = deps.db;
    this.repo = new ListRepository(deps.db);
    this.products = new SqliteProductRepository(deps.db);
    this.now = deps.now ?? (() => new Date());
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  /** Runs `fn` in a transaction; `Abort` rolls back and becomes `Err`. */
  private tx<T>(fn: () => T): Result<T> {
    try {
      return ok(withTransaction(this.db, () => fn()));
    } catch (e) {
      if (e instanceof Abort) return err(e.error);
      throw e;
    }
  }

  private requireOwned(sessionId: string, listId: unknown): ListRowFull {
    const list = isId(listId) ? this.repo.findOwned(sessionId, listId) : null;
    if (list === null) throw new Abort({ code: "NOT_FOUND", message: "List not found" });
    return list;
  }

  /** Inside a transaction: returns the default wishlist, creating or repairing it. */
  private ensureDefaultRow(sessionId: string): ListRowFull {
    const existing = this.repo.findDefault(sessionId);
    if (existing !== null) return existing;
    const now = this.nowIso();
    const oldest = this.repo.findOldestWishlist(sessionId);
    if (oldest !== null) {
      // Repair: wishlists exist but none is default (never produced by this service).
      this.repo.setDefault(sessionId, oldest.id, now);
    } else {
      this.repo.insertWishlist(sessionId, crypto.randomUUID(), DEFAULT_LIST_NAME, true, now);
    }
    const created = this.repo.findDefault(sessionId);
    if (created === null) throw new Error("ListService: default list missing after creation");
    return created;
  }

  ensureDefaultList(sessionId: string): Result<ProductList> {
    if (!isSessionId(sessionId)) return invalidSession();
    return this.tx(() => toPublicList(this.ensureDefaultRow(sessionId)));
  }

  ensureSaveForLater(sessionId: string): Result<ProductList> {
    if (!isSessionId(sessionId)) return invalidSession();
    return this.tx(() => {
      this.repo.insertSaveForLater(sessionId, crypto.randomUUID(), SAVE_FOR_LATER_NAME, this.nowIso());
      const row = this.repo.findSaveForLater(sessionId);
      if (row === null) throw new Error("ListService: save-for-later list missing after insert");
      return toPublicList(row);
    });
  }

  listLists(sessionId: string): readonly (ProductList & { itemCount: number })[] {
    if (!isSessionId(sessionId)) return [];
    return this.repo.listBySession(sessionId).map((row) => ({ ...toPublicList(row), itemCount: row.itemCount }));
  }

  private buildItems(items: readonly ListItem[], purchased: ReadonlySet<string>, sort: ListSort): ListItemView[] {
    const products = this.products.getManyByIds(items.map((i) => i.productId));
    const byId = new Map(products.map((p) => [p.id, p]));
    const views = items.map((item): ListItemView => {
      const product = byId.get(item.productId) ?? null;
      const drop =
        product !== null && product.priceCents < item.priceAtAddCents ? item.priceAtAddCents - product.priceCents : null;
      return {
        ...item,
        product,
        priceDroppedByCents: drop,
        purchasedSinceAdded: purchased.has(item.productId),
        available: product !== null && product.stock > 0,
      };
    });
    return sortItems(views, sort);
  }

  getList(sessionId: string, listId: string, sort?: ListSort | string): Result<ListView> {
    if (!isSessionId(sessionId)) return invalidSession();
    if (!isId(listId)) return notFound();
    const list = this.repo.findOwned(sessionId, listId);
    if (list === null) return notFound();
    const items = this.buildItems(
      this.repo.getItems(list.id),
      this.repo.purchasedSinceAdded(sessionId, list.id),
      isListSort(sort) ? sort : DEFAULT_LIST_SORT,
    );
    const lines: number[] = [];
    for (const item of items) {
      if (item.product === null) continue;
      const line = multiplyCents(item.product.priceCents, item.quantityDesired);
      if (!line.ok) return fail("MONEY_OVERFLOW", "This list total is too large to compute.");
      lines.push(line.value);
    }
    const total = sumCents(lines);
    if (!total.ok) return fail("MONEY_OVERFLOW", "This list total is too large to compute.");
    return ok({ ...toPublicList(list), items, itemCount: items.length, totalCents: total.value });
  }

  createList(sessionId: string, name: unknown): Result<ProductList> {
    if (!isSessionId(sessionId)) return invalidSession();
    const cleaned = validateName(name);
    if (!cleaned.ok) return cleaned;
    return this.tx(() => {
      if (this.repo.countWishlists(sessionId) >= MAX_LISTS_PER_SESSION) {
        throw new Abort({
          code: "LIMIT_REACHED",
          message: `You can have at most ${MAX_LISTS_PER_SESSION} lists.`,
          details: { max: MAX_LISTS_PER_SESSION },
        });
      }
      const id = crypto.randomUUID();
      // The first wishlist of a session becomes its default.
      const isDefault = this.repo.findDefault(sessionId) === null;
      this.repo.insertWishlist(sessionId, id, cleaned.value, isDefault, this.nowIso());
      const row = this.repo.findOwned(sessionId, id);
      if (row === null) throw new Error("ListService: list missing after insert");
      return toPublicList(row);
    });
  }

  renameList(sessionId: string, listId: string, name: unknown): Result<ProductList> {
    if (!isSessionId(sessionId)) return invalidSession();
    const cleaned = validateName(name);
    return this.tx(() => {
      const list = this.requireOwned(sessionId, listId);
      if (list.kind === "save_for_later") {
        throw new Abort({ code: "FORBIDDEN", message: "Saved for later cannot be renamed." });
      }
      if (!cleaned.ok) throw new Abort(cleaned.error);
      this.repo.rename(sessionId, list.id, cleaned.value, this.nowIso());
      const row = this.repo.findOwned(sessionId, list.id);
      if (row === null) throw new Error("ListService: list missing after rename");
      return toPublicList(row);
    });
  }

  deleteList(sessionId: string, listId: string): Result<void> {
    if (!isSessionId(sessionId)) return invalidSession();
    return this.tx(() => {
      const list = this.requireOwned(sessionId, listId);
      if (list.kind === "save_for_later") {
        throw new Abort({ code: "FORBIDDEN", message: "Saved for later cannot be deleted." });
      }
      if (list.isDefault) {
        const successor = this.repo.findOldestWishlist(sessionId, list.id);
        if (successor === null) {
          throw new Abort({ code: "FORBIDDEN", message: "Your only list cannot be deleted." });
        }
        this.repo.delete(sessionId, list.id);
        this.repo.setDefault(sessionId, successor.id, this.nowIso());
        return;
      }
      this.repo.delete(sessionId, list.id);
    });
  }

  addItem(
    sessionId: string,
    listId: string | null,
    productId: string,
    opts: ListItemOptions = {},
  ): Result<{ item: ListItem; alreadyPresent: boolean; listId: string }> {
    if (!isSessionId(sessionId)) return invalidSession();
    if (listId !== null && !isId(listId)) return notFound();
    if (!isId(productId)) return fail("PRODUCT_NOT_FOUND", "Product not found");
    const quantity = opts.quantityDesired === undefined ? ok(1) : validateQuantityDesired(opts.quantityDesired);
    if (!quantity.ok) return quantity;
    const priority: Result<ListItemPriority> = opts.priority === undefined ? ok(0) : validatePriority(opts.priority);
    if (!priority.ok) return priority;
    const note = validateNote(opts.note);
    if (!note.ok) return note;

    return this.tx(() => {
      const list = listId === null ? this.ensureDefaultRow(sessionId) : this.requireOwned(sessionId, listId);
      const existing = this.repo.getItem(list.id, productId);
      if (existing !== null) return { item: existing, alreadyPresent: true, listId: list.id };
      const now = this.nowIso();
      const price = this.repo.getPublishedPrice(productId, now);
      if (price === null) {
        throw new Abort({ code: "PRODUCT_NOT_FOUND", message: "Product not found", details: { productId } });
      }
      if (this.repo.countItems(list.id) >= MAX_ITEMS_PER_LIST) {
        throw new Abort({
          code: "LIMIT_REACHED",
          message: `A list can hold at most ${MAX_ITEMS_PER_LIST} items.`,
          details: { max: MAX_ITEMS_PER_LIST },
        });
      }
      this.repo.insertItem(list.id, {
        productId,
        quantityDesired: quantity.value,
        priority: priority.value,
        priceAtAddCents: price,
        note: note.value,
        addedAt: now,
      });
      this.repo.touch(list.id, now);
      const item = this.repo.getItem(list.id, productId);
      if (item === null) throw new Error("ListService: item missing after insert");
      return { item, alreadyPresent: false, listId: list.id };
    });
  }

  updateItem(sessionId: string, listId: string, productId: string, patch: ListItemOptions): Result<ListItem> {
    if (!isSessionId(sessionId)) return invalidSession();
    if (!isId(listId)) return notFound();
    const changes: { quantityDesired?: number; priority?: ListItemPriority; note?: string | null } = {};
    if (patch.quantityDesired !== undefined) {
      const q = validateQuantityDesired(patch.quantityDesired);
      if (!q.ok) return q;
      changes.quantityDesired = q.value;
    }
    if (patch.priority !== undefined) {
      const p = validatePriority(patch.priority);
      if (!p.ok) return p;
      changes.priority = p.value;
    }
    if (patch.note !== undefined) {
      const n = validateNote(patch.note);
      if (!n.ok) return n;
      changes.note = n.value;
    }
    const itemPatch: ItemPatch = changes;
    return this.tx(() => {
      const list = this.requireOwned(sessionId, listId);
      if (!isId(productId) || this.repo.getItem(list.id, productId) === null) {
        throw new Abort({ code: "NOT_FOUND", message: "Item not found in this list" });
      }
      if (Object.keys(itemPatch).length > 0) {
        this.repo.updateItem(list.id, productId, itemPatch);
        this.repo.touch(list.id, this.nowIso());
      }
      const item = this.repo.getItem(list.id, productId);
      if (item === null) throw new Error("ListService: item missing after update");
      return item;
    });
  }

  removeItem(sessionId: string, listId: string, productId: string): Result<void> {
    if (!isSessionId(sessionId)) return invalidSession();
    if (!isId(listId)) return notFound();
    return this.tx(() => {
      const list = this.requireOwned(sessionId, listId);
      if (!isId(productId) || this.repo.getItem(list.id, productId) === null) return; // idempotent
      this.repo.deleteItem(list.id, productId);
      this.repo.touch(list.id, this.nowIso());
    });
  }

  moveItem(sessionId: string, fromListId: string, toListId: string, productId: string): Result<void> {
    if (!isSessionId(sessionId)) return invalidSession();
    if (!isId(fromListId) || !isId(toListId)) return notFound();
    return this.tx(() => {
      const from = this.requireOwned(sessionId, fromListId);
      const to = this.requireOwned(sessionId, toListId);
      const source = isId(productId) ? this.repo.getItem(from.id, productId) : null;
      if (source === null) throw new Abort({ code: "NOT_FOUND", message: "Item not found in this list" });
      if (from.id === to.id) return;
      const now = this.nowIso();
      const target = this.repo.getItem(to.id, productId);
      if (target === null) {
        if (this.repo.countItems(to.id) >= MAX_ITEMS_PER_LIST) {
          throw new Abort({
            code: "LIMIT_REACHED",
            message: `A list can hold at most ${MAX_ITEMS_PER_LIST} items.`,
            details: { max: MAX_ITEMS_PER_LIST },
          });
        }
        // Same wish, new place: keeps its price snapshot, priority, note and added_at.
        this.repo.insertItem(to.id, source);
      } else {
        const patch: { quantityDesired?: number; note?: string | null } = {};
        if (source.quantityDesired > target.quantityDesired) patch.quantityDesired = source.quantityDesired;
        if (target.note === null && source.note !== null) patch.note = source.note;
        if (Object.keys(patch).length > 0) this.repo.updateItem(to.id, productId, patch);
      }
      this.repo.deleteItem(from.id, productId);
      this.repo.touch(from.id, now);
      this.repo.touch(to.id, now);
    });
  }

  setSharing(sessionId: string, listId: string, mode: "enable" | "disable" | "rotate"): Result<{ shareToken: string | null }> {
    if (!isSessionId(sessionId)) return invalidSession();
    if (!isId(listId)) return notFound();
    if (mode !== "enable" && mode !== "disable" && mode !== "rotate") {
      return fail("INVALID_INPUT", "Unknown sharing mode");
    }
    return this.tx(() => {
      const list = this.requireOwned(sessionId, listId);
      if (list.kind === "save_for_later") {
        throw new Abort({ code: "FORBIDDEN", message: "Saved for later cannot be shared." });
      }
      const now = this.nowIso();
      if (mode === "disable") {
        this.repo.setShare(sessionId, list.id, null, now);
        return { shareToken: null };
      }
      if (mode === "enable" && list.isPublic && list.shareToken !== null) return { shareToken: list.shareToken };
      // UNIQUE collision on a 128-bit token is practically impossible; retry anyway.
      for (let attempt = 0; attempt < 3; attempt++) {
        const token = generateShareToken();
        if (this.repo.findByShareTokenAny(token)) continue;
        this.repo.setShare(sessionId, list.id, token, now);
        return { shareToken: token };
      }
      throw new Error("ListService: could not allocate a share token");
    });
  }

  getByToken(token: unknown, sort?: ListSort | string): Result<SharedListView> {
    if (typeof token !== "string" || !SHARE_TOKEN_RE.test(token)) return notFound();
    const list = this.repo.findByShareToken(token);
    if (list === null || list.kind !== "wishlist") return notFound();
    const items = this.buildItems(this.repo.getItems(list.id), new Set(), isListSort(sort) ? sort : DEFAULT_LIST_SORT)
      // Strip the list id: the shared view must not carry ids usable for mutation.
      .map((item): ListItemView => ({ ...item, listId: "" }));
    return ok({ name: list.name, items, itemCount: items.length });
  }

  isInDefaultList(sessionId: string, productId: string): boolean {
    if (!isSessionId(sessionId) || !isId(productId)) return false;
    return this.repo.isInDefaultList(sessionId, productId);
  }
}

export function createListService(deps: ListServiceDeps): ListService {
  return new SqliteListService(deps);
}

const globalForLists = globalThis as typeof globalThis & {
  __storefrontListService?: { readonly db: Database; readonly service: ListService };
};

/** App-wide singleton over `getDatabase()` (rebuilt if the shared DB changes). */
export function getListService(): ListService {
  const db = getDatabase();
  const cached = globalForLists.__storefrontListService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createListService({ db });
  globalForLists.__storefrontListService = { db, service };
  return service;
}
