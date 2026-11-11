import { useId, type ReactNode } from "react";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Price } from "@/components/atoms/Price";
import { Rating } from "@/components/atoms/Rating";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/atoms/Table";
import { Heading } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { COMPARE_MAX } from "@/components/molecules/CompareToggle/compare-path";
import { getStockUrgency, StockUrgency } from "@/components/molecules/StockUrgency";
import {
  CART_FIELD,
  normalizeStock,
  type CartActionFn,
} from "@/components/molecules/_contracts/cart-actions";
import { isAllowedInternalHref } from "@/content/routes";
import type { ProductDetail } from "@/lib/types";
import {
  linkSlugs,
  removeHref,
  safeCompareBase,
  specRows,
  toggleDifferencesHref,
  truncateProducts,
  valuesAllEqual,
  visibleRows,
} from "./compare-table-helpers";

export interface CompareTableProps {
  /** Products resolved by the page, in selection order (0-4; extras are truncated with a notice). */
  products: readonly ProductDetail[];
  /**
   * Slugs currently in the URL; used to build remove and toggle links. Only
   * slugs of shown products are kept; falls back to the products' slugs when
   * none match.
   */
  selectedSlugs: readonly string[];
  /** Hide rows whose values are identical in every column (`diff=1`). */
  differencesOnly?: boolean;
  /** Compare route. Defaults to `/compare`. */
  basePath?: string;
  /** Cart server action. When given, each column posts an "Add to cart" form (productId, quantity=1); else a link to the product page. */
  addToCart?: CartActionFn;
  /** Level of the section heading. Defaults to 2. */
  headingLevel?: 2 | 3;
  className?: string;
}

export const COMPARE_TABLE_LABEL = "Product comparison";
/** Section heading; deliberately differs from the table region label so landmarks stay unique. */
export const COMPARE_SECTION_HEADING = "Side-by-side comparison";
export const COMPARE_MIN_HINT = "Add at least two products to compare";

/** `<form action>` signature; the action's result is intentionally ignored. */
type FormAction = (formData: FormData) => void;

interface AttributeRow {
  readonly key: string;
  readonly label: string;
  readonly allEqual: boolean;
  readonly cells: readonly ReactNode[];
}

function devWarn(message: string): void {
  if (process.env.NODE_ENV !== "production") console.warn(`[CompareTable] ${message}`);
}

/** `/products/<slug>` when it passes `isAllowedInternalHref`, else null (dev warning). */
function productHref(slug: string): string | null {
  const href = `/products/${encodeURIComponent(slug)}`;
  if (isAllowedInternalHref(href)) return href;
  devWarn(`product href for slug ${JSON.stringify(slug)} is not an allowed internal link; rendering plain text`);
  return null;
}

/** Product name as a link to its page, or plain text when the href is invalid. */
function ProductName({ product }: { product: ProductDetail }) {
  const href = productHref(product.slug);
  return href === null ? (
    <span className="break-words font-semibold">{product.name}</span>
  ) : (
    <Link href={href} className="inline-flex min-h-touch items-center break-words font-semibold">
      {product.name}
    </Link>
  );
}

function NotSpecified() {
  return <span aria-label="not specified">—</span>;
}

function brandOf(product: ProductDetail): string | null {
  const name = product.brand?.name ?? product.brandName ?? "";
  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
}

function priceKey(product: ProductDetail): string {
  return `${product.currency}:${product.priceCents}:${product.listPriceCents ?? ""}`;
}

function ratingKey(product: ProductDetail): string {
  return product.ratingCount > 0 ? `${product.ratingAvg}:${product.ratingCount}` : "none";
}

function baseRows(products: readonly ProductDetail[]): AttributeRow[] {
  const brands = products.map(brandOf);
  return [
    {
      key: "price",
      label: "Price",
      allEqual: valuesAllEqual(products.map(priceKey)),
      cells: products.map((p) => (
        <Price
          key={p.id}
          amountCents={p.priceCents}
          currency={p.currency}
          compareAtCents={p.listPriceCents ?? undefined}
        />
      )),
    },
    {
      key: "rating",
      label: "Customer rating",
      allEqual: valuesAllEqual(products.map(ratingKey)),
      cells: products.map((p) =>
        p.ratingCount > 0 ? (
          <Rating key={p.id} value={p.ratingAvg} count={p.ratingCount} size="sm" />
        ) : (
          <span key={p.id} className="text-text-secondary">
            No reviews yet
          </span>
        ),
      ),
    },
    {
      key: "brand",
      label: "Brand",
      allEqual: valuesAllEqual(brands),
      cells: brands.map((brand, i) =>
        brand === null ? <NotSpecified key={i} /> : <span key={i}>{brand}</span>,
      ),
    },
    {
      key: "availability",
      label: "Availability",
      allEqual: valuesAllEqual(products.map((p) => getStockUrgency(p.stock).label)),
      cells: products.map((p) => <StockUrgency key={p.id} stock={p.stock} />),
    },
  ];
}

function attributeRows(products: readonly ProductDetail[]): AttributeRow[] {
  const specs: AttributeRow[] = specRows(products).map((row, index) => ({
    key: `spec-${index}`,
    label: row.label,
    allEqual: row.allEqual,
    cells: row.values.map((value, i) =>
      value === null ? <NotSpecified key={i} /> : <span key={i}>{value}</span>,
    ),
  }));
  return [...baseRows(products), ...specs];
}

function BuyAction({ product, addToCart }: { product: ProductDetail; addToCart?: CartActionFn }) {
  const name = <VisuallyHidden>{` for ${product.name}`}</VisuallyHidden>;
  if (addToCart === undefined) {
    const href = productHref(product.slug);
    if (href === null) {
      return <span className="text-text-secondary">Product page unavailable</span>;
    }
    return (
      <Link variant="button" href={href}>
        View product
        {name}
      </Link>
    );
  }
  if (normalizeStock(product.stock) === 0) {
    return (
      <Button type="button" disabled>
        Out of stock
        {name}
      </Button>
    );
  }
  // bind keeps a server action a server reference; the returned state is not
  // read here (no JS needed): the action revalidates the cart itself.
  const action: FormAction = addToCart.bind(null, null);
  return (
    <form action={action}>
      <input type="hidden" name={CART_FIELD.productId} value={product.id} />
      <input type="hidden" name={CART_FIELD.quantity} value="1" />
      <Button type="submit">
        Add to cart
        {name}
      </Button>
    </form>
  );
}

const stickyCell = "sticky left-0 z-raised bg-surface-raised";
const rowHeaderClasses = `${stickyCell} min-w-28`;
const productColumnClasses = "min-w-40";

function SingleProduct({
  product,
  removeTarget,
}: {
  product: ProductDetail;
  removeTarget: string;
}) {
  return (
    <Card padding="md" className="flex flex-col gap-2 xs:flex-row xs:items-start" data-testid="compare-single">
      <Image
        src={product.imageUrl}
        alt={product.name}
        width={96}
        height={96}
        rounded
        className="size-24 shrink-0 object-contain"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <ProductName product={product} />
        <Price
          amountCents={product.priceCents}
          currency={product.currency}
          compareAtCents={product.listPriceCents ?? undefined}
        />
        <Link variant="subtle" href={removeTarget}>
          Remove
          <VisuallyHidden>{` ${product.name}`}</VisuallyHidden> from comparison
        </Link>
      </div>
    </Card>
  );
}

/**
 * Side-by-side comparison of up to 4 products (T86). Server-safe: all state
 * lives in the URL (D9); remove and "Differences only" are plain links, Add to
 * cart is a `<form action>` that works without JavaScript.
 */
export function CompareTable({
  products,
  selectedSlugs,
  differencesOnly = false,
  basePath,
  addToCart,
  headingLevel = 2,
  className,
}: CompareTableProps) {
  const base = safeCompareBase(basePath);
  const { shown, total, truncated } = truncateProducts(products);
  const slugs = linkSlugs(selectedSlugs, shown);
  const rootClasses = ["flex min-w-0 max-w-full flex-col gap-4", className].filter(Boolean).join(" ");
  const headingId = useId();
  const heading = (
    <Heading level={headingLevel} size="h3" id={headingId}>
      {COMPARE_SECTION_HEADING}
    </Heading>
  );

  if (shown.length < 2) {
    const only = shown[0];
    return (
      <section aria-labelledby={headingId} className={rootClasses}>
        {heading}
        <Notice tone="info" title={COMPARE_MIN_HINT}>
          Use “Add to compare” on product pages, or{" "}
          <Link href="/products">browse all products</Link>.
        </Notice>
        {only !== undefined ? (
          <SingleProduct
            product={only}
            removeTarget={removeHref(base, slugs, only.slug, differencesOnly)}
          />
        ) : null}
      </section>
    );
  }

  const rows = attributeRows(shown);
  const visible = visibleRows(rows, differencesOnly);

  return (
    <section aria-labelledby={headingId} className={rootClasses}>
      {heading}
      {truncated ? (
        <Notice tone="info">{`Showing the first ${COMPARE_MAX} of ${total} products.`}</Notice>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          variant="button"
          buttonVariant="outline"
          buttonSize="sm"
          href={toggleDifferencesHref(base, slugs, differencesOnly)}
          data-differences-only={differencesOnly ? "on" : "off"}
        >
          {differencesOnly ? "Show all details" : "Show differences only"}
        </Link>
        {differencesOnly ? (
          <p className="text-small text-text-secondary">Showing differences only.</p>
        ) : null}
      </div>
      <Table
        label={COMPARE_TABLE_LABEL}
        density="compact"
        wrapperClassName="max-w-full rounded-lg border border-border-default bg-surface-raised shadow-sm"
        className="min-w-full"
      >
        <TableCaption visuallyHidden>{COMPARE_TABLE_LABEL}</TableCaption>
        <TableHead>
          <TableRow>
            <TableHeaderCell scope="col" className={rowHeaderClasses}>
              <VisuallyHidden>Product</VisuallyHidden>
            </TableHeaderCell>
            {shown.map((product) => (
              <TableHeaderCell key={product.id} scope="col" className={productColumnClasses}>
                <div className="flex flex-col gap-2 font-normal">
                  <Image
                    src={product.imageUrl}
                    alt={product.name}
                    width={96}
                    height={96}
                    rounded
                    className="size-24 object-contain"
                  />
                  <ProductName product={product} />
                  <Link
                    variant="subtle"
                    href={removeHref(base, slugs, product.slug, differencesOnly)}
                  >
                    Remove
                    <VisuallyHidden>{` ${product.name}`}</VisuallyHidden> from comparison
                  </Link>
                </div>
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {visible.map((row) => (
            <TableRow key={row.key} data-row={row.key}>
              <TableHeaderCell scope="row" className={`${rowHeaderClasses} break-words`}>
                {row.label}
              </TableHeaderCell>
              {row.cells.map((cell, i) => (
                <TableCell key={shown[i]?.id ?? i} className="break-words">
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {visible.length === 0 ? (
            <TableRow data-row="no-differences">
              <TableHeaderCell scope="row" className={rowHeaderClasses}>
                Differences
              </TableHeaderCell>
              <TableCell colSpan={shown.length}>
                These products have the same details.
              </TableCell>
            </TableRow>
          ) : null}
          <TableRow data-row="buy">
            <TableHeaderCell scope="row" className={rowHeaderClasses}>
              Buy
            </TableHeaderCell>
            {shown.map((product) => (
              <TableCell key={product.id}>
                <BuyAction product={product} addToCart={addToCart} />
              </TableCell>
            ))}
          </TableRow>
        </TableBody>
      </Table>
    </section>
  );
}
