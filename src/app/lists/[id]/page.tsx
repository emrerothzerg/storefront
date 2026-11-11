import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { Notice } from "@/components/atoms/Notice";
import { ListView, listHref } from "@/components/organisms/ListView";
import {
  addAllToCart,
  deleteList,
  moveListItem,
  removeFromList,
  renameList,
  setListSharing,
  updateListItem,
} from "@/app/actions/lists";
import { buildMetadata } from "@/lib/seo/metadata";
import { getSiteUrl } from "@/lib/seo/site";
import { readSessionId } from "@/server/session/session";

import { addToCartFromList } from "../_lib/list-form-actions";
import { loadOwnerList } from "../_lib/load-lists";
import { LISTS_PATH, LIST_CREATED_MESSAGE, listBreadcrumb } from "../_lib/page-parts";
import { isListIdShape, parseFlag, parseListSort, type SearchParamsRecord } from "../_lib/params";

export interface ListPageProps {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<SearchParamsRecord>;
}

/**
 * Static, noindex, no canonical: the list id never goes into the canonical /
 * OG URL, and metadata does no lookup (so it cannot differ between a foreign
 * and an unknown id).
 */
export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({ title: "Your list", description: "One of your lists.", noindex: true });
}

/**
 * `/lists/[id]`: the owner's list. The id shape is validated before anything
 * touches the database (including the cookie's owner-key lookup); no cookie,
 * malformed, unknown and foreign ids all reach the same single `notFound()`
 * (criterion 1). `?sort=` is validated; unknown values use the default.
 */
export default async function ListPage({ params, searchParams }: ListPageProps) {
  const { id } = await params;
  const query = await searchParams;
  const sort = parseListSort(query.sort);
  const data = isListIdShape(id)
    ? loadOwnerList({ sessionId: await readSessionId(), id, sort, now: new Date() })
    : null;
  if (data === null) notFound();

  const { list, otherLists } = data;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={listBreadcrumb(list.name)} />
      {parseFlag(query.created) ? <Notice tone="success">{LIST_CREATED_MESSAGE}</Notice> : null}
      <ListView
        mode="owner"
        list={list}
        otherLists={otherLists}
        sort={sort}
        basePath={listHref(list.id) ?? LISTS_PATH}
        siteUrl={getSiteUrl()}
        actions={{
          renameList,
          deleteList,
          setListSharing,
          addAllToCart,
          updateListItem,
          removeFromList,
          moveListItem,
          addToCart: addToCartFromList,
        }}
      />
    </div>
  );
}
