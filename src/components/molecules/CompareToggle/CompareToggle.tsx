import { Button } from "@/components/atoms/Button";
import { Checkbox } from "@/components/atoms/Checkbox";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import {
  COMPARE_MAX,
  COMPARE_PARAM,
  COMPARE_PATH,
  buildComparePath,
  normaliseCompareSlugs,
} from "./compare-path";

export type CompareToggleMode = "form" | "link";

export interface CompareToggleProps {
  productSlug: string;
  productName: string;
  /** Current `?p=` slugs from the URL (deduped and capped here). */
  selected: readonly string[];
  /**
   * Listing page the form can return to (path, optionally with its query, e.g.
   * `/search?q=desk`). When set, form mode adds a secondary "Add to selection"
   * submit that GETs this path with the `p` selection, so shoppers can tick
   * products on several cards before comparing (multi-select without JS).
   * Its own query parameters (except `p`) are replayed as hidden inputs.
   * Omitted: only the "Compare (N)" submit to `/compare` is rendered.
   */
  basePath?: string;
  /** Defaults to 4. */
  max?: number;
  /** Defaults to "form". */
  mode?: CompareToggleMode;
  className?: string;
}

interface HiddenParam {
  name: string;
  value: string;
}

/** Splits `basePath` into an action path and its non-`p` query params. Same-site paths only. */
function parseBasePath(basePath: string | undefined): { action: string; params: HiddenParam[] } | null {
  if (basePath === undefined) return null;
  const trimmed = basePath.trim();
  // Reject protocol-relative and absolute URLs: the form must stay on-site.
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed, "http://local.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "http://local.invalid") return null;
  const params: HiddenParam[] = [];
  parsed.searchParams.forEach((value, name) => {
    if (name !== COMPARE_PARAM) params.push({ name, value });
  });
  return { action: parsed.pathname, params };
}

/**
 * Compare checkbox for listings and product pages. Server-safe (no client
 * state): the selection lives in the URL (`/compare?p=a&p=b`, D9).
 *
 * - `form` (default): `<form method="get" action="/compare">` with a `p`
 *   checkbox for this product plus hidden `p` inputs for the other selected
 *   slugs; works without JS. At the cap the checkbox is disabled with
 *   "You can compare up to N products".
 * - `link`: "Add to compare" / "Remove from compare" link built with
 *   `buildComparePath`.
 */
export function CompareToggle({
  productSlug,
  productName,
  selected,
  basePath,
  max = COMPARE_MAX,
  mode = "form",
  className,
}: CompareToggleProps) {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : COMPARE_MAX;
  const slug = productSlug.trim();
  const current = normaliseCompareSlugs(selected, limit);
  const isSelected = current.includes(slug);
  const isFull = !isSelected && current.length >= limit;
  const limitMessage = `You can compare up to ${limit} products`;
  if (slug === "") return null;
  const rootClasses = ["flex min-w-0 flex-col gap-2", className].filter(Boolean).join(" ");

  if (mode === "link") {
    return (
      <div className={rootClasses}>
        {isFull ? (
          <p className="text-small text-text-secondary">{limitMessage}</p>
        ) : (
          <Link
            href={buildComparePath(current, slug, limit)}
            variant="nav"
            prefetch={false}
            className="gap-2 text-small"
          >
            <Icon name="columns" size="sm" />
            {isSelected ? "Remove from compare" : "Add to compare"}
            <span className="sr-only">: {productName}</span>
          </Link>
        )}
      </div>
    );
  }

  const others = current.filter((s) => s !== slug);
  const listing = parseBasePath(basePath);
  const messageId = `compare-limit-${slug.replace(/[^A-Za-z0-9_-]/g, "_")}`;

  return (
    <form method="get" action={COMPARE_PATH} className={rootClasses}>
      {others.map((s) => (
        <input key={s} type="hidden" name={COMPARE_PARAM} value={s} />
      ))}
      <Checkbox
        name={COMPARE_PARAM}
        value={slug}
        label={`Compare ${productName}`}
        size="sm"
        defaultChecked={isSelected}
        disabled={isFull}
        aria-describedby={isFull ? messageId : undefined}
        className="min-w-0 break-words"
      />
      {isFull ? (
        <p id={messageId} className="text-small text-text-secondary">
          {limitMessage}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" size="sm">
          <Icon name="columns" size="sm" />
          {`Compare (${current.length})`}
          <span className="sr-only">: selected products</span>
        </Button>
        {listing ? (
          <Button type="submit" variant="ghost" size="sm" formAction={listing.action}>
            Add to selection
          </Button>
        ) : null}
      </div>
      {listing
        ? listing.params.map((p, i) => (
            <input key={`${p.name}-${i}`} type="hidden" name={p.name} value={p.value} />
          ))
        : null}
    </form>
  );
}
