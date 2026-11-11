"use client";

import { Fragment, useActionState, useId, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Checkbox } from "@/components/atoms/Checkbox";
import { Icon } from "@/components/atoms/Icon";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Price } from "@/components/atoms/Price";
import { Heading } from "@/components/atoms/Typography";
import {
  ADD_MANY_MAX_ITEMS,
  CART_FIELD,
  initialCartActionStateV2,
  type CartActionFnV2,
  type CartPerItemResult,
} from "@/components/molecules/_contracts/cart-actions";
import { isAllowedInternalHref } from "@/content/routes";
import { sumCents } from "@/lib/money";
import type { Product } from "@/lib/types";
import type { Bundle } from "@/server/recommendations/recommendation-service";

export interface FrequentlyBoughtTogetherProps {
  /** Main product first, then 1..2 companions. Fewer than 2 distinct items renders nothing. */
  bundle: Bundle;
  /** `addManyToCart` server action (repeated `productId` fields). */
  action: CartActionFnV2;
  /** Outline level of the section heading. Defaults to 2. */
  headingLevel?: 2 | 3;
  className?: string;
}

export const FBT_HEADING = "Frequently bought together";
export const FBT_SUBMIT_LABEL = "Add selected to cart";
export const FBT_PENDING_LABEL = "Adding…";

const RESULT_LABELS: Record<CartPerItemResult["result"], string> = {
  added: "Added",
  out_of_stock: "Out of stock",
  capped: "Already at the cart limit",
  unavailable: "Unavailable",
};

const RESULT_ORDER: readonly CartPerItemResult["result"][] = [
  "added",
  "out_of_stock",
  "capped",
  "unavailable",
];

/**
 * Plain-text summary of `addManyToCart` per-item outcomes, e.g.
 * "Added: A, B. Out of stock: C." Names come from `items`; ids the bundle
 * does not know are counted as "another item". Empty input returns "".
 */
export function describePerItem(
  perItem: readonly CartPerItemResult[],
  items: readonly Pick<Product, "id" | "name">[],
): string {
  const names = new Map(items.map((p) => [p.id, p.name]));
  const groups = new Map<CartPerItemResult["result"], string[]>();
  for (const entry of perItem) {
    const label = RESULT_LABELS[entry.result];
    if (label === undefined) continue;
    const list = groups.get(entry.result) ?? [];
    list.push(names.get(entry.productId) ?? "another item");
    groups.set(entry.result, list);
  }
  return RESULT_ORDER.filter((r) => groups.has(r))
    .map((r) => `${RESULT_LABELS[r]}: ${(groups.get(r) ?? []).join(", ")}.`)
    .join(" ");
}

/** Distinct items by id, main first, capped at `ADD_MANY_MAX_ITEMS`. */
export function bundleItems(bundle: Bundle): readonly Product[] {
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const item of bundle.items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length === ADD_MANY_MAX_ITEMS) break;
  }
  return out;
}

/** Exact integer total of the given items, or `null` if any price is invalid. */
export function totalCentsOf(items: readonly Product[]): number | null {
  const r = sumCents(items.map((p) => p.priceCents));
  return r.ok ? r.value : null;
}

function productHref(product: Product): string | null {
  const href = `/products/${encodeURIComponent(product.slug)}`;
  return isAllowedInternalHref(href) ? href : null;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

/** White tile with a soft border around each bundle image (Phase 3 card look). */
const FBT_IMAGE_TILE_CLASSES = "shrink-0 rounded-lg border border-border-default bg-surface-raised p-1";

/**
 * "Frequently bought together": item images joined by plus signs, one
 * checkbox per item (all checked by default) and an "Add selected to cart"
 * form posting the checked ids as repeated `productId` fields. Without JS the
 * form posts whatever is checked and the server-rendered total is the full
 * bundle total; with JS the total follows the checkboxes. The main item
 * cannot be unchecked while it is the only checked item.
 */
export function FrequentlyBoughtTogether({
  bundle,
  action,
  headingLevel = 2,
  className,
}: FrequentlyBoughtTogetherProps) {
  const autoId = useId();
  const [state, formAction, isPending] = useActionState(action, initialCartActionStateV2);
  // Tracking UNchecked ids keeps "everything checked" the default for any bundle.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(EMPTY);

  const items = bundleItems(bundle);
  const main = items[0];
  if (main === undefined || items.length < 2) return null;

  const checkedItems = items.filter((p) => !unchecked.has(p.id));
  const mainChecked = !unchecked.has(main.id);
  const othersChecked = checkedItems.some((p) => p.id !== main.id);
  const mainLocked = mainChecked && !othersChecked;
  const checkedCount = checkedItems.length;
  const total = totalCentsOf(checkedItems);
  const currency = main.currency;

  const toggle = (id: string, checked: boolean) => {
    if (!checked && id === main.id && mainLocked) return;
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const headingId = `fbt-${autoId}-heading`;
  const resultText =
    state?.ok === true
      ? describePerItem(state.value.perItem ?? [], items) || state.value.message
      : "";
  const classes = ["flex flex-col gap-4", className].filter(Boolean).join(" ");

  return (
    <Card as="section" padding="md" aria-labelledby={headingId} className={classes}>
      <Heading level={headingLevel} size={headingLevel === 2 ? "h3" : "h4"} id={headingId}>
        {FBT_HEADING}
      </Heading>

      <div className="flex flex-wrap items-center gap-2">
        {items.map((product, index) => {
          const href = productHref(product);
          const image = (
            <Image
              src={product.imageUrl}
              alt={product.name}
              width={200}
              height={200}
              sizes="96px"
              rounded
              className="block size-16 object-contain sm:size-24"
            />
          );
          return (
            <Fragment key={product.id}>
              {index > 0 ? (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-text-secondary">
                  <Icon name="plus" size="sm" />
                </span>
              ) : null}
              {href !== null ? (
                <Link href={href} variant="nav" className={FBT_IMAGE_TILE_CLASSES}>
                  {image}
                </Link>
              ) : (
                <span className={FBT_IMAGE_TILE_CLASSES}>{image}</span>
              )}
            </Fragment>
          );
        })}
      </div>

      <form
        action={formAction}
        onReset={() => setUnchecked(EMPTY)}
        className="flex min-w-0 flex-col gap-3"
      >
        <fieldset className="m-0 flex min-w-0 flex-col rounded-lg border-0 bg-surface-sunken px-3 py-1">
          <legend className="sr-only">Choose items to add</legend>
          {items.map((product, index) => {
            const isMain = index === 0;
            const locked = isMain && mainLocked;
            return (
              <Checkbox
                key={product.id}
                name={CART_FIELD.productId}
                value={product.id}
                checked={!unchecked.has(product.id)}
                onChange={(event) => toggle(product.id, event.currentTarget.checked)}
                disabled={locked}
                description={
                  locked ? "Stays selected while it is the only item selected." : undefined
                }
                label={
                  <span className="break-words">
                    {isMain ? <span className="font-semibold">This item: </span> : null}
                    {product.name}
                    {" — "}
                    <Price amountCents={product.priceCents} currency={product.currency} />
                  </span>
                }
              />
            );
          })}
        </fieldset>
        {/* A disabled checkbox does not post, so the locked main item posts here. */}
        {mainLocked ? <input type="hidden" name={CART_FIELD.productId} value={main.id} /> : null}

        <p aria-live="polite" aria-atomic="true" className="text-body font-semibold">
          {checkedCount === 0 ? (
            "Select at least one item."
          ) : total === null ? (
            "Total unavailable."
          ) : (
            <>
              {`Total for ${checkedCount} ${checkedCount === 1 ? "item" : "items"}: `}
              <Price amountCents={total} currency={currency} />
            </>
          )}
        </p>

        <Button
          type="submit"
          loading={isPending}
          disabled={checkedCount === 0}
          className="self-start"
        >
          {isPending ? FBT_PENDING_LABEL : FBT_SUBMIT_LABEL}
        </Button>

        {state?.ok === false ? (
          <p role="alert" className="text-small text-danger">
            {state.error.message}
          </p>
        ) : null}
        <p aria-live="polite" aria-atomic="true" className="text-small text-text-primary">
          {resultText}
        </p>
      </form>
    </Card>
  );
}
