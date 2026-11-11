import type { Database } from "bun:sqlite";

import type { ListViewOtherList } from "@/components/organisms/ListView";
import type { ListKind } from "@/lib/types";
import { getDatabase } from "@/server/db/client";
import {
  createListService,
  type ListService,
  type ListSort,
  type ListView,
  type SharedListView,
} from "@/server/lists/list-service";
import { isSessionId } from "@/server/session/session-id";

import { isListIdShape, isShareTokenShape } from "./params";

/**
 * Read-only loaders for the lists pages (T99). Server-only. Nothing here
 * writes: no session is minted (pages pass `readSessionId()`), no list is
 * created, and invalid input returns before any database access.
 *
 * Every "you cannot see this" outcome (no cookie, malformed id, unknown id,
 * another owner's id, malformed/revoked/rotated token) is the single value
 * `null`, so the page has exactly one `notFound()` path (criteria 1 and 2).
 */

export interface ListsLoaderDeps {
  /** Defaults to the app database (`getDatabase()`); tests pass a `:memory:` DB. */
  readonly db?: Database;
}

function listService(now: Date, deps: ListsLoaderDeps): ListService {
  return createListService({ db: deps.db ?? getDatabase(), now: () => now });
}

/** Errors that mean "not yours / not there"; anything else is a server fault and throws. */
function isHiddenError(code: string): boolean {
  return code === "NOT_FOUND" || code === "INVALID_INPUT";
}

export interface ListSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: ListKind;
  readonly isDefault: boolean;
  readonly isPublic: boolean;
  readonly itemCount: number;
}

export type ListsIndexData =
  /** No usable cookie, or a cookie with no lists yet. */
  | { readonly kind: "empty"; readonly hasSession: boolean }
  /** Exactly one list: the page redirects to it (unless it must show a notice). */
  | { readonly kind: "single"; readonly listId: string; readonly lists: readonly [ListSummary] }
  | { readonly kind: "index"; readonly lists: readonly ListSummary[] };

export interface ListsIndexInput {
  readonly sessionId: string | null;
  readonly now: Date;
}

function toSummary(list: ListSummary): ListSummary {
  // Explicit copy: never forwards `shareToken` or any other field to the index.
  return {
    id: list.id,
    name: list.name,
    kind: list.kind,
    isDefault: list.isDefault,
    isPublic: list.isPublic,
    itemCount: list.itemCount,
  };
}

/** `/lists` data. Without a valid owner key the database is never opened (criterion 4). */
export function loadListsIndex(input: ListsIndexInput, deps: ListsLoaderDeps = {}): ListsIndexData {
  if (!isSessionId(input.sessionId)) return { kind: "empty", hasSession: false };
  const lists = listService(input.now, deps).listLists(input.sessionId).map(toSummary);
  if (lists.length === 0) return { kind: "empty", hasSession: true };
  const [only] = lists;
  if (lists.length === 1 && only !== undefined) return { kind: "single", listId: only.id, lists: [only] };
  return { kind: "index", lists };
}

export interface OwnerListInput {
  readonly sessionId: string | null;
  readonly id: string;
  readonly sort: ListSort;
  readonly now: Date;
}

export interface OwnerListData {
  readonly list: ListView;
  /** All of the owner's lists (ListView filters out the current one). */
  readonly otherLists: readonly ListViewOtherList[];
}

/**
 * `/lists/[id]` data for the owner, or `null`. Shape checks run first; the
 * only DB branch is the owner-scoped lookup (`id AND session_id`), which is
 * the same query for unknown and foreign ids.
 */
export function loadOwnerList(input: OwnerListInput, deps: ListsLoaderDeps = {}): OwnerListData | null {
  if (!isSessionId(input.sessionId) || !isListIdShape(input.id)) return null;
  const service = listService(input.now, deps);
  const result = service.getList(input.sessionId, input.id, input.sort);
  if (!result.ok) {
    if (isHiddenError(result.error.code)) return null;
    throw new Error(`Lists page: list view failed (${result.error.code})`);
  }
  const otherLists = service.listLists(input.sessionId).map(
    (list): ListViewOtherList => ({ id: list.id, name: list.name, itemCount: list.itemCount, kind: list.kind }),
  );
  return { list: result.value, otherLists };
}

export interface SharedListInput {
  readonly token: string;
  readonly sort: ListSort;
  readonly now: Date;
}

/**
 * `/lists/shared/[token]` data, or `null`. Takes no owner key on purpose: the
 * public view never depends on who is looking. Malformed tokens never reach
 * the database.
 */
export function loadSharedList(input: SharedListInput, deps: ListsLoaderDeps = {}): SharedListView | null {
  if (!isShareTokenShape(input.token)) return null;
  const result = listService(input.now, deps).getByToken(input.token, input.sort);
  if (!result.ok) {
    if (isHiddenError(result.error.code)) return null;
    throw new Error(`Lists page: shared list view failed (${result.error.code})`);
  }
  return result.value;
}
