"use client";

import { useEffect, useRef } from "react";
import type { RecordViewBeacon } from "@/components/molecules/_contracts/view-actions";

export interface ViewTrackerProps {
  productId: string;
  productSlug: string;
  /**
   * The page already recorded this view server-side (a session cookie
   * existed). When true the tracker does nothing.
   */
  recorded: boolean;
  /** The `recordProductView` server action (pass it directly). */
  recordView: RecordViewBeacon;
}

/**
 * PDP browsing-history beacon (T97). Renders nothing. When the server did not
 * record the view (no session cookie), it calls `recordView` ONCE after
 * hydration, never during render, so cookie-less crawlers (no JS) cause no
 * writes. The action may mint the session cookie; that is a client-initiated
 * mutation. The result is ignored (fire-and-forget) and failures are
 * swallowed. A ref guards against StrictMode's double effect run and against
 * re-renders; a different product (client navigation) is tracked again.
 */
export function ViewTracker({ productId, productSlug, recorded, recordView }: ViewTrackerProps) {
  const sentFor = useRef<string | null>(null);

  useEffect(() => {
    if (recorded) return;
    const key = `${productId}\u0000${productSlug}`;
    if (sentFor.current === key) return;
    sentFor.current = key;
    try {
      void Promise.resolve(recordView({ productId, productSlug })).catch(() => undefined);
    } catch {
      // A throwing action must never break the page.
    }
  }, [recorded, productId, productSlug, recordView]);

  return null;
}
