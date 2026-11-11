import { Badge } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Chip } from "@/components/atoms/Chip";
import { Link } from "@/components/atoms/Link";
import { Select } from "@/components/atoms/Select";
import { Heading } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { ListItemRow, type ListAddToCartAction } from "@/components/molecules/ListItemRow";
import { ShareListPanel } from "@/components/molecules/ShareListPanel";
import type { ListActionFn, ListActionState } from "@/components/molecules/_contracts/list-actions";
// Type-only: organisms never import server code at runtime.
import type {
  ListSort,
  ListView as ListViewData,
  SharedListView as SharedListViewData,
} from "@/server/lists/list-service";
import {
  AddAllToCartForm,
  DeleteListForm,
  ListSwitcher,
  RenameListForm,
  SharedListItemRow,
  type ListSwitcherEntry,
} from "./ListViewIslands";
import {
  BEST_SELLERS_PATH,
  BROWSE_PRODUCTS_PATH,
  LISTS_INDEX_PATH,
  LIST_EMPTY_MESSAGE,
  LIST_SORT_OPTIONS,
  LIST_SORT_PARAM,
  addableCount,
  itemNames,
  listCurrency,
  listHref,
  listTotalText,
  normaliseListSort,
  pluralItems,
  productHref,
  safeListBase,
  sortHref,
} from "./list-view-model";

export const LIST_VIEW_HEADING_ID = "list-view-heading";
export const LIST_SORT_SELECT_ID = "list-sort";

export interface ListViewOtherList {
  readonly id: string;
  readonly name: string;
  readonly itemCount: number;
  readonly kind: "wishlist" | "save_for_later";
}

export interface ListViewActions {
  readonly renameList: ListActionFn;
  readonly deleteList: ListActionFn;
  readonly setListSharing: ListActionFn;
  readonly addAllToCart: ListActionFn;
  readonly updateListItem: ListActionFn;
  readonly removeFromList: ListActionFn;
  readonly moveListItem: ListActionFn;
  /** Per-item "Add to cart" (posts `productId`); omit to hide it. */
  readonly addToCart?: ListAddToCartAction;
}

interface ListViewCommonProps {
  /** Current sort, parsed by the page (unknown values already ignored). */
  sort: ListSort;
  /** Page path without query: `/lists/<id>` or `/lists/shared/<token>`. */
  basePath: string;
  /** Level of the list name heading. Defaults to 1 (the page's `<h1>`). */
  headingLevel?: 1 | 2;
  className?: string;
}

export interface OwnerListViewProps extends ListViewCommonProps {
  mode: "owner";
  list: ListViewData;
  /** The viewer's lists (the current one is filtered out). */
  otherLists: readonly ListViewOtherList[];
  actions: ListViewActions;
  /** Forwarded to ShareListPanel (defaults to NEXT_PUBLIC_SITE_URL there). */
  siteUrl?: string;
  /** Last addAllToCart state, if the page has it (initial state of the add-all form). */
  addAllResult?: ListActionState;
  shared?: never;
}

export interface SharedListViewProps extends ListViewCommonProps {
  mode: "shared";
  shared: SharedListViewData;
  list?: never;
  actions?: never;
  otherLists?: never;
}

export type ListViewProps = OwnerListViewProps | SharedListViewProps;

function rootClass(className: string | undefined): string {
  return ["flex min-w-0 max-w-full flex-col gap-6", className].filter(Boolean).join(" ");
}

function EmptyState({ hint }: { hint: string }) {
  return (
    <Card tone="sunken" padding="md" className="flex min-w-0 flex-col items-start gap-2">
      <p className="text-body font-semibold text-text-primary">{LIST_EMPTY_MESSAGE}</p>
      <p className="text-small text-text-secondary">{hint}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Link href={BROWSE_PRODUCTS_PATH} variant="button" buttonVariant="primary" buttonSize="sm">
          Browse products
        </Link>
        <Link href={BEST_SELLERS_PATH} variant="button" buttonVariant="outline" buttonSize="sm">
          Best sellers
        </Link>
      </div>
    </Card>
  );
}

/** GET form `?sort=` (works without JS; the page ignores unknown values). */
function SortForm({ base, sort }: { base: string; sort: ListSort }) {
  return (
    <form method="get" action={base} aria-label="Sort list" className="flex min-w-0 flex-wrap items-end gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={LIST_SORT_SELECT_ID} className="text-small font-semibold text-text-primary">
          Sort by
        </label>
        <Select
          id={LIST_SORT_SELECT_ID}
          name={LIST_SORT_PARAM}
          options={LIST_SORT_OPTIONS}
          defaultValue={normaliseListSort(sort)}
          className="min-w-0"
        />
      </div>
      <Button type="submit" variant="outline">
        Apply
      </Button>
    </form>
  );
}

/** Shared mode: the sort is a set of plain GET links (no forms at all), shown as pill chips. */
function SortLinks({ base, sort }: { base: string; sort: ListSort }) {
  const current = normaliseListSort(sort);
  return (
    <nav aria-label="Sort list" className="flex min-w-0 flex-col gap-2">
      <p className="text-small font-semibold text-text-primary">Sort by</p>
      <ul className="flex min-w-0 flex-wrap gap-2">
        {LIST_SORT_OPTIONS.map((option) => {
          const isCurrent = option.value === current;
          return (
            <li key={option.value} className="min-w-0">
              <Chip
                as="a"
                size="sm"
                href={sortHref(base, option.value)}
                label={option.label}
                selected={isCurrent}
                aria-current={isCurrent ? "page" : undefined}
              />
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Wish list page body. Server-safe; interactivity lives in the molecules and
 * the small islands in `ListViewIslands.tsx`. Every mutation is a
 * `<form action>` that works without JS (D9/SR2).
 *
 * - `mode="owner"`: name heading + kind badge, Rename / Delete (two-step),
 *   ShareListPanel, GET sort form, other-lists switcher, "Add all to cart (N)",
 *   editable ListItemRows, empty state, "N items · $X".
 * - `mode="shared"`: name heading, item count, sort links and read-only rows
 *   with a "View product" link each. No forms, no ids, no owner data.
 */
export function ListView(props: ListViewProps) {
  return props.mode === "shared" ? <SharedBody {...props} /> : <OwnerBody {...props} />;
}

function OwnerBody({
  list,
  otherLists,
  sort,
  basePath,
  actions,
  siteUrl,
  headingLevel = 1,
  addAllResult,
  className,
}: OwnerListViewProps) {
  const subLevel = headingLevel === 1 ? 2 : 3;
  const rowLevel = subLevel === 2 ? 3 : 4;
  const base = safeListBase(basePath, listHref(list.id) ?? LISTS_INDEX_PATH) ?? LISTS_INDEX_PATH;
  const isWishlist = list.kind === "wishlist";
  const others = otherLists.filter((other) => other.id !== list.id);
  const moveTargets = others.map((other) => ({ id: other.id, name: other.name }));
  const switcher: ListSwitcherEntry[] = others.flatMap((other) => {
    const href = listHref(other.id);
    return href === null ? [] : [{ href, label: `${other.name} (${pluralItems(other.itemCount)})` }];
  });
  const hasItems = list.items.length > 0;
  const names = [...itemNames(list.items).entries()];

  return (
    <section aria-labelledby={LIST_VIEW_HEADING_ID} className={rootClass(className)}>
      <header className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Heading level={headingLevel} id={LIST_VIEW_HEADING_ID} className="min-w-0 break-words">
            {list.name}
          </Heading>
          {isWishlist && list.isDefault ? (
            <Badge tone="info" shape="pill">
              Default
            </Badge>
          ) : null}
          {!isWishlist ? (
            <Badge tone="neutral" shape="pill">
              Saved for later
            </Badge>
          ) : null}
          {isWishlist && list.isPublic ? (
            <Badge tone="success" shape="pill">
              Shared
            </Badge>
          ) : null}
        </div>
        <p className="text-small text-text-secondary" data-testid="list-total">
          {listTotalText(list.itemCount, list.totalCents, listCurrency(list.items))}
        </p>
        {isWishlist ? (
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:gap-6">
            <RenameListForm listId={list.id} listName={list.name} action={actions.renameList} />
            <DeleteListForm listId={list.id} listName={list.name} action={actions.deleteList} />
          </div>
        ) : null}
      </header>

      <ShareListPanel
        listId={list.id}
        listName={list.name}
        kind={list.kind}
        isPublic={list.isPublic}
        shareToken={list.shareToken}
        action={actions.setListSharing}
        siteUrl={siteUrl}
        headingLevel={subLevel}
      />

      <Card
        padding="sm"
        className="flex min-w-0 flex-col gap-4 md:flex-row md:flex-wrap md:items-end md:justify-between"
        data-slot="list-toolbar"
      >
        {hasItems ? <SortForm base={base} sort={sort} /> : null}
        <ListSwitcher lists={switcher} />
        {hasItems ? (
          <AddAllToCartForm
            listId={list.id}
            count={addableCount(list.items)}
            names={names}
            action={actions.addAllToCart}
            initialState={addAllResult ?? null}
          />
        ) : null}
      </Card>

      <div className="flex min-w-0 flex-col gap-2">
        <Heading level={subLevel} size="h3">
          Items<VisuallyHidden> in {list.name}</VisuallyHidden>
        </Heading>
        {hasItems ? (
          <ul role="list" className="min-w-0">
            {list.items.map((item) => (
              <ListItemRow
                key={item.productId}
                item={item}
                listId={list.id}
                otherLists={moveTargets}
                actions={{
                  update: actions.updateListItem,
                  remove: actions.removeFromList,
                  move: actions.moveListItem,
                  addToCart: actions.addToCart,
                }}
                headingLevel={rowLevel}
              />
            ))}
          </ul>
        ) : (
          <EmptyState hint="Find something you like and save it here." />
        )}
      </div>
    </section>
  );
}

function SharedBody({ shared, sort, basePath, headingLevel = 1, className }: SharedListViewProps) {
  const subLevel = headingLevel === 1 ? 2 : 3;
  const rowLevel = subLevel === 2 ? 3 : 4;
  const base = safeListBase(basePath, null);
  const hasItems = shared.items.length > 0;
  const count = typeof shared.itemCount === "number" && shared.itemCount > 0 ? Math.floor(shared.itemCount) : 0;

  return (
    <section aria-labelledby={LIST_VIEW_HEADING_ID} className={rootClass(className)}>
      <header className="flex min-w-0 flex-col gap-2">
        <Heading level={headingLevel} id={LIST_VIEW_HEADING_ID} className="min-w-0 break-words">
          {shared.name}
        </Heading>
        <p className="text-small text-text-secondary" data-testid="list-total">
          {pluralItems(count)}
        </p>
        <p className="text-small text-text-secondary">A shared wish list. You can view it but not change it.</p>
      </header>

      {hasItems && base !== null ? <SortLinks base={base} sort={sort} /> : null}

      <div className="flex min-w-0 flex-col gap-2">
        <Heading level={subLevel} size="h3">
          Items<VisuallyHidden> in {shared.name}</VisuallyHidden>
        </Heading>
        {hasItems ? (
          <ul role="list" className="min-w-0">
            {shared.items.map((item, index) => {
              const href = item.product !== null ? productHref(item.product.slug) : null;
              return (
                <li key={`${item.productId}-${index}`} className="flex min-w-0 flex-col gap-2 pb-2">
                  <SharedListItemRow item={item} headingLevel={rowLevel} />
                  {href !== null && item.product !== null ? (
                    <div>
                      <Link href={href} variant="button" buttonVariant="outline" buttonSize="sm">
                        View product<VisuallyHidden> {item.product.name}</VisuallyHidden>
                      </Link>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState hint="There is nothing in this list yet." />
        )}
      </div>
    </section>
  );
}
