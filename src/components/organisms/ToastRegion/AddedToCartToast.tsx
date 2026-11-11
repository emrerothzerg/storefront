"use client";

import { useEffect, useRef } from "react";
import { useToast, type ToastApi } from "@/components/atoms/Toast";
import { isAllowedInternalHref } from "@/content/routes";

/** Raise a toast each time `count` increases. */
export interface AddedToCartTrigger {
  /** Monotonically increasing submission counter; 0 / unchanged = no toast. */
  readonly count: number;
  /** Optional description under the title, e.g. "2 x Canvas Tote Bag". Rendered as text. */
  readonly description?: string;
}

export interface AddedToCartToastProps {
  trigger: AddedToCartTrigger | null;
  /**
   * Cart path for the "View cart" action. Default "/cart". Must pass
   * `isAllowedInternalHref`; anything else (external, `javascript:`,
   * protocol-relative, unknown route) falls back to "/cart".
   */
  cartHref?: string;
  /** Navigation used by "View cart"; defaults to `window.location.assign`. Injected in tests. */
  navigate?: (href: string) => void;
}

export const ADDED_TO_CART_TITLE = "Added to cart";

/** Where "View cart" goes when `cartHref` is missing or fails the internal-href guard. */
export const DEFAULT_CART_HREF = "/cart";

/** `href` when it passes `isAllowedInternalHref`, else {@link DEFAULT_CART_HREF}. */
export function safeCartHref(href: unknown): string {
  return typeof href === "string" && isAllowedInternalHref(href) ? href : DEFAULT_CART_HREF;
}

/** `useToast()` without a provider throws; here that just means "no toasts" (never throws). */
function useOptionalToast(): ToastApi | null {
  try {
    return useToast();
  } catch {
    return null;
  }
}

function assignLocation(href: string): void {
  window.location.assign(href);
}

/**
 * Renders nothing. When `trigger.count` increases it queues a polite,
 * auto-dismissing success toast ("Added to cart" + "View cart" action) through
 * the layout's `ToastProvider`. No provider -> no-op. The toast is an
 * enhancement: the form keeps its own inline live-region message.
 */
export function AddedToCartToast({
  trigger,
  cartHref = DEFAULT_CART_HREF,
  navigate = assignLocation,
}: AddedToCartToastProps) {
  const api = useOptionalToast();
  const toast = api?.toast;
  const lastCount = useRef(0);
  const count = trigger?.count ?? 0;
  const description = trigger?.description;

  useEffect(() => {
    if (!Number.isSafeInteger(count) || count <= lastCount.current) return;
    lastCount.current = count;
    if (!toast) return;
    toast({
      title: ADDED_TO_CART_TITLE,
      description: description && description.trim() !== "" ? description : undefined,
      tone: "success",
      action: { label: "View cart", onClick: () => navigate(safeCartHref(cartHref)) },
    });
  }, [count, description, toast, cartHref, navigate]);

  return null;
}
