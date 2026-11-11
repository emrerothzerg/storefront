/**
 * SiteFooter v3 (T150) data. Link data lives in `@/content/navigation`
 * (`FOOTER_QUICK_LINKS`, `FOOTER_COLUMNS`, `LEGAL_LINKS`); this module
 * re-exports it under the footer's names and adds the placeholder copy.
 */
import { FOOTER_COLUMNS, FOOTER_QUICK_LINKS, LEGAL_LINKS } from "@/content/navigation";

export { FOOTER_QUICK_LINKS, LEGAL_LINKS };

/** The four link columns; the fifth ("Get the app") holds the StoreBadge placeholder. */
export const SITE_FOOTER_COLUMNS = FOOTER_COLUMNS;

/** Heading of the column appended when given columns omit legal links. */
export const LEGAL_HEADING = "Legal";

/** Fifth column: non-interactive app placeholder (BACKLOG-phase3 section 4). */
export const FOOTER_APP_HEADING = "Get the app";

/** Payment-marks row: generic text placeholders only, never brand names. */
export const FOOTER_PAYMENT_HEADING = "Ways to pay";
export const FOOTER_PAYMENT_LABELS: readonly string[] = ["Card", "Gift card", "Pay later: coming soon"];
