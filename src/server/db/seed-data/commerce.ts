import type { CouponKind } from "@/lib/types";

/** Demo coupons. Codes are upper case (the DB enforces it). */
export interface SeedCoupon {
  readonly code: string;
  readonly kind: CouponKind;
  readonly value: number;
  readonly minSubtotalCents: number;
  readonly maxUses: number | null;
  readonly usedCount: number;
  readonly startsAt: string | null;
  readonly expiresAt: string | null;
  readonly isActive: boolean;
  /** Advertised in the UI. */
  readonly promoted: boolean;
}

export const SEED_COUPONS: readonly SeedCoupon[] = [
  { code: "WELCOME10", kind: "percent", value: 10, minSubtotalCents: 0, maxUses: null, usedCount: 0, startsAt: null, expiresAt: null, isActive: true, promoted: true },
  { code: "SAVE5", kind: "fixed", value: 500, minSubtotalCents: 2500, maxUses: null, usedCount: 0, startsAt: null, expiresAt: null, isActive: true, promoted: false },
  { code: "FREESHIP", kind: "free_shipping", value: 0, minSubtotalCents: 2000, maxUses: null, usedCount: 0, startsAt: null, expiresAt: null, isActive: true, promoted: true },
  { code: "EXPIRED10", kind: "percent", value: 10, minSubtotalCents: 0, maxUses: null, usedCount: 0, startsAt: "2025-01-01T00:00:00.000Z", expiresAt: "2025-12-31T23:59:59.000Z", isActive: true, promoted: false },
  { code: "MAXED5", kind: "fixed", value: 500, minSubtotalCents: 0, maxUses: 1, usedCount: 1, startsAt: null, expiresAt: null, isActive: true, promoted: false },
];

export interface SeedShippingMethod {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly freeOverCents: number | null;
  readonly minDays: number;
  readonly maxDays: number;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export const SEED_SHIPPING_METHODS: readonly SeedShippingMethod[] = [
  { id: "standard", name: "Standard", description: "Delivered in 5-8 business days. Free on orders of $35 or more.", priceCents: 499, freeOverCents: 3500, minDays: 5, maxDays: 8, sortOrder: 1, isActive: true },
  { id: "express", name: "Express", description: "Delivered in 2-3 business days.", priceCents: 999, freeOverCents: null, minDays: 2, maxDays: 3, sortOrder: 2, isActive: true },
  { id: "next_day", name: "Next Day", description: "Order today, delivered next business day.", priceCents: 1999, freeOverCents: null, minDays: 1, maxDays: 1, sortOrder: 3, isActive: true },
];
