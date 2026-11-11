/**
 * Shared domain types. Safe to import from server and client code.
 *
 * Conventions:
 * - Money is always an integer number of minor units (e.g. cents) in a
 *   field ending in `Cents`, paired with an ISO 4217 `currency` code.
 * - Everything is `readonly`; build new values instead of mutating.
 * - No enums; string-literal unions only, so values stay JSON-serializable.
 */

/** Every error code the application can return. */
export const ERROR_CODES = [
  "PRODUCT_NOT_FOUND",
  "OUT_OF_STOCK",
  "INSUFFICIENT_STOCK",
  "INVALID_QUANTITY",
  "INVALID_INPUT",
  "VALIDATION_FAILED",
  "EMPTY_CART",
  "STOCK_CHANGED",
  "ORDER_NOT_FOUND",
  "PAYMENT_FAILED",
  "MONEY_OVERFLOW",
  // Phase 2
  "NOT_FOUND",
  "DUPLICATE",
  "ALREADY_VOTED",
  "COUPON_INVALID",
  "COUPON_EXPIRED",
  "COUPON_MIN_SUBTOTAL",
  /** max_uses reached. */
  "COUPON_EXHAUSTED",
  /** This session already redeemed the coupon. */
  "COUPON_USED",
  "LIST_NOT_FOUND",
  "ORDER_NOT_CANCELLABLE",
  "LIMIT_REACHED",
  /** Free-text input over its length cap (also a field-level validation code). */
  "TOO_LONG",
  "RATE_LIMITED",
  "FORBIDDEN",
  // Accounts
  "INVALID_CREDENTIALS",
  "EMAIL_TAKEN",
  "UNAUTHENTICATED",
  "ACCOUNT_LOCKED",
  /** Unexpected failure that is not the caller's fault (generic, never carries internals). */
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** ISO 4217 currency code, e.g. "USD", "EUR", "JPY". */
export type CurrencyCode = string;

/** ISO 3166-1 alpha-2 country code, upper case, e.g. "US", "DE". */
export type CountryCode = string;

/** ISO 8601 timestamp string, e.g. "2026-11-06T12:00:00.000Z". */
export type IsoDateTimeString = string;

/**
 * Lightweight product shape used by cards, carts and lists.
 *
 * The optional summary fields are SPARSE: repositories set a field only when
 * it carries information, so a plain product has exactly the eight required
 * keys. Absent means: no list price, no reviews (count 0), no brand, no
 * category, not featured, no SKU. `publishedAt` is set on every summary whose
 * row has a publish time (D-T170-1: cards derive the "New" badge from it);
 * `updatedAt` is only set on `ProductDetail`.
 */
export interface Product {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly currency: CurrencyCode;
  /** Primary image. */
  readonly imageUrl: string;
  /** Units available to sell; non-negative integer. */
  readonly stock: number;
  /** "Was" price in minor units, always >= `priceCents`. Null only on `ProductDetail`. */
  readonly listPriceCents?: number | null;
  /** Number of reviews; set only when > 0 (on `ProductDetail` always). */
  readonly ratingCount?: number;
  /** Mean star rating rounded to one decimal (1.0-5.0); 0 only on `ProductDetail` with no reviews. */
  readonly ratingAvg?: number;
  readonly brandName?: string;
  readonly brandSlug?: string;
  readonly categoryName?: string;
  readonly categorySlug?: string;
  /** Set (to true) only for featured products. */
  readonly isFeatured?: boolean;
  readonly publishedAt?: IsoDateTimeString;
  /** Last change to the product row; only set on `ProductDetail` (see `listSlugsWithUpdatedAt` for sitemaps). */
  readonly updatedAt?: IsoDateTimeString;
  readonly sku?: string;
}

/** One row of a product's specification table. */
export interface ProductSpec {
  readonly label: string;
  readonly value: string;
}

/** A gallery image; `url` is site-relative, `alt` describes the view. */
export interface ProductImage {
  readonly url: string;
  readonly alt: string;
}

/** Two-level taxonomy: departments have `parentId === null`, categories point at a department. */
export interface Category {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly parentId: string | null;
  readonly sortOrder: number;
  readonly imageUrl: string | null;
}

export interface CategoryWithCount extends Category {
  /** Products directly in this category plus, for a department, in its children. */
  readonly productCount: number;
}

export interface Brand {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
}

export interface BrandWithCount extends Brand {
  readonly productCount: number;
}

/** Full product page shape. Every rich field is always present. */
export interface ProductDetail extends Product {
  /** "About this item" bullet points. */
  readonly bullets: readonly string[];
  readonly specs: readonly ProductSpec[];
  /** Gallery, primary image first; never empty (falls back to `imageUrl`). */
  readonly images: readonly ProductImage[];
  readonly listPriceCents: number | null;
  readonly ratingCount: number;
  /** 0 when there are no reviews. */
  readonly ratingAvg: number;
  readonly brand: Brand | null;
  /** The product's (leaf) category; use the category repository's `getPath` for breadcrumbs. */
  readonly category: Category | null;
  readonly publishedAt: IsoDateTimeString;
  readonly updatedAt: IsoDateTimeString;
}

/** Moderation state of user-generated content; hidden rows are excluded from public reads and ratings. */
export type ContentStatus = "published" | "hidden";

/** Star rating, 1-5. */
export type StarRating = 1 | 2 | 3 | 4 | 5;

/*
 * Session ids are deliberately absent from every public-content type below
 * (reviews, Q&A, lists): they are bearer credentials (the session cookie) and
 * must never be sent to another shopper. Services compare them server-side.
 */

export interface Review {
  readonly id: string;
  readonly productId: string;
  readonly displayName: string;
  readonly rating: StarRating;
  readonly title: string;
  readonly body: string;
  readonly verifiedPurchase: boolean;
  readonly helpfulCount: number;
  readonly status: ContentStatus;
  readonly createdAt: IsoDateTimeString;
  readonly updatedAt: IsoDateTimeString;
}

export interface ReviewSummary {
  readonly count: number;
  /** Mean rounded to one decimal; 0 when count is 0. */
  readonly avg: number;
  /** Number of reviews per star value. */
  readonly histogram: Readonly<Record<StarRating, number>>;
}

export interface Answer {
  readonly id: string;
  readonly questionId: string;
  readonly displayName: string;
  readonly body: string;
  /** Answered by the store (staff badge). */
  readonly isStore: boolean;
  readonly helpfulCount: number;
  readonly status: ContentStatus;
  readonly createdAt: IsoDateTimeString;
}

export interface Question {
  readonly id: string;
  readonly productId: string;
  readonly displayName: string;
  readonly body: string;
  readonly helpfulCount: number;
  readonly status: ContentStatus;
  readonly createdAt: IsoDateTimeString;
  /** Present when the query loaded answers. */
  readonly answers?: readonly Answer[];
}

export type ListKind = "wishlist" | "save_for_later";

/** 0 = low, 1 = medium, 2 = high. */
export type ListItemPriority = 0 | 1 | 2;

export interface ListItem {
  readonly listId: string;
  readonly productId: string;
  readonly quantityDesired: number;
  readonly priority: ListItemPriority;
  /** Product price when added, minor units (for "price dropped" badges). */
  readonly priceAtAddCents: number;
  readonly note: string | null;
  readonly addedAt: IsoDateTimeString;
  /** Present when the query joined the product (null if it no longer exists). */
  readonly product?: Product | null;
}

export interface ProductList {
  readonly id: string;
  readonly name: string;
  readonly kind: ListKind;
  /** The session's default wishlist (at most one per session). */
  readonly isDefault: boolean;
  readonly isPublic: boolean;
  /** Unguessable token for the public share URL; null until shared. */
  readonly shareToken: string | null;
  readonly createdAt: IsoDateTimeString;
  readonly updatedAt: IsoDateTimeString;
  /** Present when the query loaded items. */
  readonly items?: readonly ListItem[];
}

export interface ProductView {
  readonly productId: string;
  readonly viewedAt: IsoDateTimeString;
}

export type CouponKind = "percent" | "fixed" | "free_shipping";

export interface Coupon {
  /** Upper case. */
  readonly code: string;
  readonly kind: CouponKind;
  /** Percent 1-100 for "percent", minor units for "fixed", 0 for "free_shipping". */
  readonly value: number;
  readonly minSubtotalCents: number;
  readonly maxUses: number | null;
  readonly usedCount: number;
  readonly startsAt: IsoDateTimeString | null;
  readonly expiresAt: IsoDateTimeString | null;
  readonly isActive: boolean;
  /** Advertised in the UI (banners, cart hint). */
  readonly promoted: boolean;
}

export interface CouponRedemption {
  readonly couponCode: string;
  readonly orderId: string | null;
  readonly createdAt: IsoDateTimeString;
}

export interface ShippingMethod {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  /** Subtotal (minor units) at or above which this method is free; null = never free. */
  readonly freeOverCents: number | null;
  readonly minDays: number;
  readonly maxDays: number;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

/** Fulfilment lifecycle, separate from the payment `OrderStatus`. */
export type FulfillmentStatus =
  | "processing"
  | "packed"
  | "shipped"
  | "out_for_delivery"
  | "delivered"
  | "cancelled";

/** One step of an order's fulfilment timeline (at most one per status). */
export interface OrderEvent {
  readonly id: number;
  readonly orderId: string;
  readonly status: FulfillmentStatus;
  readonly at: IsoDateTimeString;
  readonly note: string | null;
}

/** Back-in-stock request, session scoped (no email collected). */
export interface StockAlert {
  readonly id: string;
  readonly productId: string;
  readonly createdAt: IsoDateTimeString;
  /** Set once the shopper has seen the "back in stock" notice. */
  readonly acknowledgedAt: IsoDateTimeString | null;
}

export interface ContactMessage {
  readonly id: string;
  /** Short human-readable reference shown to the shopper, e.g. "C-7F3K2QAB" ("C-" + 8 Crockford base32 chars). */
  readonly reference: string;
  readonly name: string;
  readonly email: string;
  readonly topic: string;
  readonly orderId: string | null;
  readonly productSlug: string | null;
  readonly message: string;
  readonly createdAt: IsoDateTimeString;
}

/**
 * A registered shopper. Never carries the password hash or lockout counters
 * (those stay inside the auth repository). `ownerKey` is the UUID stored in
 * the `session_id` columns of owner-keyed tables for this user's data.
 */
export interface User {
  readonly id: string;
  /** Trimmed, lower case. */
  readonly email: string;
  readonly displayName: string;
  readonly ownerKey: string;
  readonly createdAt: IsoDateTimeString;
  readonly lastLoginAt: IsoDateTimeString | null;
}

/** A login session (the token itself is never stored, only its hash). */
export interface AuthSession {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: IsoDateTimeString;
  readonly expiresAt: IsoDateTimeString;
  readonly lastSeenAt: IsoDateTimeString;
  readonly revokedAt: IsoDateTimeString | null;
  /** User-Agent captured at sign-in (cut to 512 chars), or null when none was sent. */
  readonly userAgent: string | null;
}

/** Address-book entry (session scoped). Unlike checkout `Address`, has a phone and no email. */
export interface SavedAddress {
  readonly id: string;
  /** e.g. "Home", "Work"; may be empty. */
  readonly label: string;
  readonly fullName: string;
  readonly phone?: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: CountryCode;
  readonly isDefault: boolean;
  readonly createdAt: IsoDateTimeString;
  readonly updatedAt: IsoDateTimeString;
}

/**
 * State of a cart line relative to the current catalogue:
 * - "ok": product exists, enough stock, price unchanged or refreshed
 * - "unavailable": product removed or out of stock
 * - "reduced": quantity was lowered to the available stock
 */
export type CartItemStatus = "ok" | "unavailable" | "reduced";

export interface CartItem {
  readonly productId: string;
  readonly quantity: number;
  /** Current catalogue price per unit, in minor units. */
  readonly unitPriceCents: number;
  readonly status: CartItemStatus;
}

/** Alias kept because the backlog uses both names. */
export type CartLine = CartItem;

export interface Cart {
  readonly sessionId: string;
  readonly items: readonly CartItem[];
  readonly subtotalCents: number;
  readonly currency: CurrencyCode;
}

export interface Address {
  readonly fullName: string;
  readonly email: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: CountryCode;
}

/**
 * Raw card details entered at checkout. Lives only for the duration of a
 * payment request: NEVER persist, log or return this to a client.
 */
export interface CardInput {
  readonly number: string;
  readonly expMonth: number;
  readonly expYear: number;
  readonly cvc: string;
  readonly nameOnCard: string;
}

export interface PaymentSuccess {
  readonly providerRef: string;
  readonly last4: string;
}

export type PaymentFailureCode =
  | "DECLINED"
  | "INSUFFICIENT_FUNDS"
  | "PROCESSING_ERROR"
  | "INVALID_AMOUNT";

export interface PaymentFailure {
  readonly code: PaymentFailureCode;
  /** Safe to show to the shopper; contains no card data. */
  readonly message: string;
}

export type OrderStatus = "paid" | "payment_failed";

/** Snapshot of a purchased line, frozen at purchase time. */
export interface OrderItem {
  readonly productId: string;
  readonly name: string;
  readonly unitPriceCents: number;
  readonly quantity: number;
}

export interface Order {
  readonly id: string;
  readonly sessionId: string;
  readonly status: OrderStatus;
  readonly items: readonly OrderItem[];
  readonly subtotalCents: number;
  /** Shipping charged, minor units (0 when free). */
  readonly shippingCents: number;
  readonly totalCents: number;
  readonly currency: CurrencyCode;
  readonly address: Address;
  readonly cardLast4: string;
  /** Set only when `status === "payment_failed"`. */
  readonly failureCode?: PaymentFailureCode;
  readonly idempotencyKey: string;
  readonly createdAt: IsoDateTimeString;
  /*
   * Phase 2 fields. Optional so pre-phase-2 orders and fixtures stay valid;
   * repositories reading the v2 columns should always set fulfillmentStatus
   * (DB default 'processing'). Absent fulfillmentStatus means "processing".
   */
  readonly fulfillmentStatus?: FulfillmentStatus;
  readonly couponCode?: string;
  /** Discount applied to the subtotal, minor units (>= 0). */
  readonly discountCents?: number;
  readonly shippingMethodId?: string;
  readonly shippingMethodName?: string;
  readonly estimatedDeliveryStart?: IsoDateTimeString;
  readonly estimatedDeliveryEnd?: IsoDateTimeString;
  readonly cancelledAt?: IsoDateTimeString;
  readonly shippedAt?: IsoDateTimeString;
  readonly deliveredAt?: IsoDateTimeString;
  readonly phone?: string;
  readonly deliveryNote?: string;
  /** Present when the query loaded the timeline, oldest first. */
  readonly events?: readonly OrderEvent[];
}
