import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Badge } from "@/components/atoms/Badge";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Heading, Text } from "@/components/atoms/Typography";
import { listHref } from "@/components/organisms/ListView";
import { buildMetadata } from "@/lib/seo/metadata";
import { readCurrentUser } from "@/server/session/current-user";
import { readSessionId } from "@/server/session/session";

import { loadListsIndex, type ListSummary } from "./_lib/load-lists";
import {
  CreateListForm,
  LISTS_DESCRIPTION,
  LISTS_PATH,
  LISTS_TITLE,
  LIST_CREATED_MESSAGE,
  LIST_DELETED_MESSAGE,
  indexBreadcrumb,
  listKindLabel,
} from "./_lib/page-parts";
import { parseIndexParams, type SearchParamsRecord } from "./_lib/params";

export interface ListsPageProps {
  readonly searchParams: Promise<SearchParamsRecord>;
}

/** Lists are per device/owner: never indexed. */
export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({ title: LISTS_TITLE, description: LISTS_DESCRIPTION, path: LISTS_PATH, noindex: true });
}

const INDEX_HEADING_ID = "lists-index-heading";

function pluralItems(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

function ListIndexEntry({ list }: { list: ListSummary }) {
  const href = listHref(list.id);
  return (
    <Card as="li" className="flex flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {href === null ? (
          <span className="min-w-0 break-words font-semibold">{list.name}</span>
        ) : (
          <Link href={href} className="min-w-0 break-words font-semibold">
            {list.name}
          </Link>
        )}
        <Badge tone="neutral">{listKindLabel(list.kind)}</Badge>
        {list.kind === "wishlist" && list.isDefault ? <Badge tone="info">Default</Badge> : null}
        {list.kind === "wishlist" && list.isPublic ? <Badge tone="success">Shared</Badge> : null}
      </div>
      <Text variant="small" tone="secondary">
        {pluralItems(list.itemCount)}
      </Text>
    </Card>
  );
}

/**
 * `/lists`. Read-only render: the owner key comes from `readSessionId()`
 * (never minted here, SR10/criterion 4). No cookie or no lists -> empty state
 * (200); exactly one list -> redirect to it (unless a notice from a redirect
 * must be shown); several -> index + "Create a list".
 */
export default async function ListsPage({ searchParams }: ListsPageProps) {
  const params = parseIndexParams(await searchParams);
  const sessionId = await readSessionId();
  const data = loadListsIndex({ sessionId, now: new Date() });
  const hasNotice = params.deleted || params.created || params.createError !== null;
  if (data.kind === "single" && !hasNotice) {
    const href = listHref(data.listId);
    if (href !== null) redirect(href);
  }
  const signedIn = data.kind === "empty" && data.hasSession ? (await readCurrentUser()) !== null : false;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Breadcrumb items={indexBreadcrumb()} />
      <header className="flex min-w-0 flex-col gap-2">
        <Heading level={1} id={INDEX_HEADING_ID}>
          {LISTS_TITLE}
        </Heading>
      </header>

      {params.deleted ? <Notice tone="success">{LIST_DELETED_MESSAGE}</Notice> : null}
      {params.created ? <Notice tone="success">{LIST_CREATED_MESSAGE}</Notice> : null}

      {data.kind === "empty" ? (
        <Card className="flex max-w-prose flex-col gap-2">
          {signedIn ? (
            <Text className="font-semibold">You have no lists yet.</Text>
          ) : (
            <>
              <Text className="font-semibold">You have no lists yet.</Text>
              <Text tone="secondary">
                Your lists live on this device. Sign in to keep them with your account and see them anywhere.
              </Text>
            </>
          )}
          <div className="flex flex-wrap gap-3 pt-2">
            {signedIn ? null : (
              <Link href="/signin" variant="button">
                Sign in
              </Link>
            )}
            <Link href="/products" variant="button" buttonVariant="outline">
              Browse products
            </Link>
          </div>
        </Card>
      ) : (
        <section aria-labelledby={INDEX_HEADING_ID} className="min-w-0">
          <ul role="list" className="flex min-w-0 flex-col gap-3">
            {data.lists.map((list) => (
              <ListIndexEntry key={list.id} list={list} />
            ))}
          </ul>
        </section>
      )}

      <CreateListForm error={params.createError} />
    </div>
  );
}
