import type { BadgeEmphasis, BadgeTone } from "@/components/atoms/Badge";
import type { BreadcrumbItem } from "@/components/atoms/Breadcrumb";
import { PRODUCT_CARD_BADGES, cardBadges, type CardBadgeProduct, type DerivedCardBadge } from "@/components/molecules/ProductCard";
import { isAllowedInternalHref } from "@/content/routes";
import type { ProductDetail } from "@/lib/types";

import type { PdpCrumb } from "./pdp-data";

/** Pure view helpers for the PDP (kept out of page.tsx so they are unit-tested). */

/** The href when it passes the internal-route allow-list, else null. */
export function safeHref(href: string | null): string | null {
  return href !== null && isAllowedInternalHref(href) ? href : null;
}

/** Breadcrumb atom items; a crumb whose href is not allowed renders as text. */
export function breadcrumbItems(crumbs: readonly PdpCrumb[]): BreadcrumbItem[] {
  return crumbs.map((crumb, index) => {
    const href = index < crumbs.length - 1 ? safeHref(crumb.href ?? null) : null;
    return href !== null ? { label: crumb.label, href } : { label: crumb.label };
  });
}

const oneDecimal = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("en-US");

/** "4.3 out of 5, 128 ratings" (accessible name of the rating link). */
export function ratingLinkText(avg: number, count: number): string {
  const safeAvg = Number.isFinite(avg) ? Math.min(5, Math.max(0, avg)) : 0;
  const safeCount = Number.isSafeInteger(count) && count > 0 ? count : 0;
  return `${oneDecimal.format(safeAvg)} out of 5, ${integer.format(safeCount)} ${safeCount === 1 ? "rating" : "ratings"}`;
}

export interface InfoRow {
  readonly label: string;
  readonly value: string;
}

const DIMENSION_LABEL = /^(dimensions?|size|weight|item weight|product dimensions)$/i;

/**
 * "Product information" rows: SKU, brand, category and, when the specs carry
 * them, dimensions/weight. Blank values are skipped.
 */
export function infoRows(product: Pick<ProductDetail, "sku" | "brand" | "category" | "specs">): InfoRow[] {
  const rows: InfoRow[] = [];
  const push = (label: string, value: string | null | undefined) => {
    const v = value?.trim() ?? "";
    if (v !== "") rows.push({ label, value: v });
  };
  push("SKU", product.sku);
  push("Brand", product.brand?.name);
  push("Category", product.category?.name);
  for (const spec of product.specs) {
    if (DIMENSION_LABEL.test(spec.label.trim()) && !rows.some((r) => r.label === spec.label.trim())) {
      push(spec.label.trim(), spec.value);
    }
  }
  return rows;
}

export interface PdpBadge {
  readonly key: DerivedCardBadge;
  readonly label: string;
  readonly tone: BadgeTone;
  readonly emphasis: BadgeEmphasis;
}

/**
 * Badge row under the PDP title (contract P-5): the same rules, priority
 * (Sale > New > Top pick), cap of 2 and labels as the product cards (L-12),
 * from the loader's single clock. Never throws; bad data yields no badge.
 */
export function pdpBadges(product: CardBadgeProduct, now: Date): PdpBadge[] {
  return cardBadges(
    {
      priceCents: product.priceCents,
      listPriceCents: product.listPriceCents,
      publishedAt: product.publishedAt,
      ratingAvg: product.ratingAvg,
      ratingCount: product.ratingCount,
    },
    now,
  ).map((key) => ({ key, ...PRODUCT_CARD_BADGES[key] }));
}
