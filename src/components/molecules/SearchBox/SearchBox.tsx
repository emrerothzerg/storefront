"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FocusEvent } from "react";
import { Button } from "@/components/atoms/Button";
import { Icon } from "@/components/atoms/Icon";
import { SearchField } from "@/components/atoms/SearchField";
import type { SearchSuggestion } from "@/components/atoms/SearchField";
import { Select } from "@/components/atoms/Select";
import {
  MAX_QUERY_LENGTH,
  RECENT_SEARCHES_KEY,
  SUGGEST_DEBOUNCE_MS,
  buildEmptyStateSuggestions,
  clearRecentSearches,
  getBrowserStorage,
  isSafeSuggestionHref,
  parseRecentSearches,
  parseSuggestBody,
  pushRecentSearch,
  shouldFetchSuggestions,
} from "./search-helpers";
import type { SearchBoxSuggestion } from "./search-helpers";

export interface SearchBoxDepartment {
  readonly slug: string;
  readonly name: string;
}

export interface SearchBoxProps {
  /**
   * Options of the department select (posted as `dept`); "All departments"
   * (`""`) is always first. Omitted = no select at all (no `Select`, no
   * `form=` link, no `dept` field): the Phase 3 header (T148 ruling). Pass an
   * array (even `[]`) to keep the select.
   */
  departments?: readonly SearchBoxDepartment[];
  /** Initial query (e.g. the current `q` on /search). */
  defaultQuery?: string;
  /** Initially selected department slug; unknown slugs fall back to "All departments". Ignored without `departments`. */
  defaultDept?: string;
  /** Suggest endpoint (T53 contract). Defaults to `/api/search/suggest`. */
  suggestUrl?: string;
  /** Shown (after recents) when the input is empty and focused. */
  popularSearches?: readonly string[];
  /**
   * Accessible label of the query field (visually hidden). Defaults to
   * `SEARCH_BOX_DEFAULT_LABEL` ("Search products", the header's). Pass a
   * distinct label when a page renders a second search field (e.g. the 404
   * page) so the two fields are distinguishable.
   */
  label?: string;
  /**
   * Accessible name of the search landmark (SearchField's `landmarkLabel`).
   * Omitted: SearchField's default "Site search" (the header's). A page that
   * renders a second search box passes its own name (e.g. the 404 page's
   * "Search the store") so the two landmarks are distinguishable.
   */
  landmarkLabel?: string;
  /** `lg` gives the field more room (home hero); `md` is the header size. Defaults to "md". */
  size?: "md" | "lg";
  /**
   * Navigation used when a suggestion is chosen. Defaults to
   * `window.location.assign`. T80 may pass a client-router push.
   */
  onNavigate?: (href: string) => void;
  className?: string;
}

const DEFAULT_SUGGEST_URL = "/api/search/suggest";
export const SEARCH_BOX_DEFAULT_LABEL = "Search products";
/** Placeholder of the query field (Phase 3 header design, T143). */
export const SEARCH_BOX_PLACEHOLDER = "Search products, categories and more";

// --- recent-searches store (localStorage + same-tab notifications) ---------

const recentListeners = new Set<() => void>();

function subscribeRecents(listener: () => void): () => void {
  recentListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === RECENT_SEARCHES_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    recentListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function notifyRecents() {
  for (const listener of recentListeners) listener();
}

/** Raw string snapshot: strings compare by value, so the snapshot is stable. */
function readRawRecents(): string | null {
  const storage = getBrowserStorage();
  if (!storage) return null;
  try {
    return storage.getItem(RECENT_SEARCHES_KEY);
  } catch {
    return null;
  }
}

const serverRecents = () => null;

function recordRecent(q: string) {
  pushRecentSearch(getBrowserStorage(), q);
  notifyRecents();
}

// --- hydration flag ----------------------------------------------------------

const noopSubscribe = () => () => {};

function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

interface RemoteResult {
  readonly q: string;
  readonly items: readonly SearchBoxSuggestion[];
}

const EMPTY_RESULT: RemoteResult = { q: "", items: [] };

function defaultNavigate(href: string) {
  window.location.assign(href);
}

/**
 * Header search (T64; Phase 3 look T143): ONE GET form to `/search` with `dept` and `q`. The
 * department `Select` sits beside SearchField's `<form>` and joins it through
 * the HTML `form` attribute (forms cannot nest), so Enter submits
 * `/search?dept=&q=` without JavaScript. With JS: debounced suggestions from
 * the suggest route, recent searches (localStorage) and popular searches when
 * the input is empty, all shown through SearchField's combobox.
 * Phase 3: the query field is SearchField's wide `pill` with the round submit
 * inset at its end; the department select is a compact control before it.
 * An empty or whitespace-only query submits as-is (`/search?dept=&q=`), which
 * the search page treats as browse-all (no `required`, no client block).
 * Without `departments` (T148, the header) there is no select: the form posts
 * only `q` (`/search?q=`).
 */
export function SearchBox({
  departments,
  defaultQuery = "",
  defaultDept,
  suggestUrl = DEFAULT_SUGGEST_URL,
  popularSearches = [],
  label,
  landmarkLabel,
  size = "md",
  onNavigate = defaultNavigate,
  className,
}: SearchBoxProps) {
  const baseId = useId();
  const formId = `${baseId}-form`;
  const selectId = `${baseId}-dept`;
  const hydrated = useHydrated();

  const [query, setQuery] = useState(defaultQuery);
  const [remote, setRemote] = useState<RemoteResult>(EMPTY_RESULT);
  const [focusWithin, setFocusWithin] = useState(false);
  const inputNodeRef = useRef<HTMLInputElement | null>(null);

  const rawRecents = useSyncExternalStore(subscribeRecents, readRawRecents, serverRecents);
  const recents = useMemo(() => parseRecentSearches(rawRecents), [rawRecents]);

  const trimmed = query.trim();

  useEffect(() => {
    const q = query.trim();
    if (!shouldFetchSuggestions(q)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`${suggestUrl}?q=${encodeURIComponent(q)}`, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
            credentials: "same-origin",
          });
          if (!response.ok) {
            if (!controller.signal.aborted) setRemote({ q, items: [] });
            return;
          }
          const body: unknown = await response.json();
          if (!controller.signal.aborted) setRemote({ q, items: parseSuggestBody(body) });
        } catch {
          // Network error, abort, invalid JSON: hide the list silently.
          if (!controller.signal.aborted) setRemote({ q, items: [] });
        }
      })();
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, suggestUrl]);

  const items: readonly SearchBoxSuggestion[] = useMemo(() => {
    if (trimmed === "") return buildEmptyStateSuggestions(recents, popularSearches);
    if (shouldFetchSuggestions(trimmed) && remote.q === trimmed) return remote.items;
    return [];
  }, [trimmed, recents, popularSearches, remote]);

  const fieldSuggestions: SearchSuggestion[] = useMemo(
    () => items.map(({ id, label, href }) => ({ id, label, href })),
    [items],
  );

  const handleSelect = (choice: SearchSuggestion) => {
    const item = items.find((candidate) => candidate.id === choice.id);
    if (!item || !isSafeSuggestionHref(item.href)) return;
    const recorded = item.query ?? trimmed;
    if (recorded !== "") recordRecent(recorded);
    onNavigate(item.href);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setFocusWithin(false);
  };

  const clearRecents = () => {
    clearRecentSearches(getBrowserStorage());
    notifyRecents();
    inputNodeRef.current?.focus();
  };

  const showDepartmentSelect = departments !== undefined;
  const deptOptions = useMemo(
    () => [
      { value: "", label: "All departments" },
      ...(departments ?? [])
        .filter((d) => typeof d.slug === "string" && d.slug !== "" && typeof d.name === "string" && d.name !== "")
        .map((d) => ({ value: d.slug, label: d.name })),
    ],
    [departments],
  );
  const initialDept = deptOptions.some((o) => o.value === defaultDept) ? (defaultDept ?? "") : "";

  const showClearRecents = hydrated && focusWithin && trimmed === "" && recents.length > 0;

  return (
    <div
      className={["flex w-full min-w-0 flex-col", size === "lg" ? "gap-3" : "gap-2", className]
        .filter(Boolean)
        .join(" ")}
      onFocus={() => setFocusWithin(true)}
      onBlur={handleBlur}
      data-size={size}
    >
      <div className={["flex w-full min-w-0 flex-col sm:flex-row sm:items-center", size === "lg" ? "gap-3" : "gap-2"].join(" ")}>
        {showDepartmentSelect ? (
          <Select
            id={selectId}
            name="dept"
            form={formId}
            aria-label="Search in department"
            options={deptOptions}
            defaultValue={initialDept}
            className={["shrink-0 sm:w-auto", size === "lg" ? "sm:max-w-60" : "sm:max-w-48"].join(" ")}
          />
        ) : null}
        <SearchField
          id={formId}
          className="min-w-0 flex-1"
          label={typeof label === "string" && label.trim() !== "" ? label.trim() : SEARCH_BOX_DEFAULT_LABEL}
          landmarkLabel={landmarkLabel}
          variant="pill"
          placeholder={SEARCH_BOX_PLACEHOLDER}
          defaultValue={defaultQuery}
          inputRef={inputNodeRef}
          maxLength={MAX_QUERY_LENGTH}
          onChange={setQuery}
          onSubmit={(_event, submitted) => {
            // Record, then let the native GET submit proceed.
            if (submitted.trim() !== "") recordRecent(submitted);
          }}
          suggestions={fieldSuggestions}
          onSelect={handleSelect}
        />
      </div>
      {showClearRecents ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            // Keep focus in the input when clicked with a pointer.
            onMouseDown={(event) => event.preventDefault()}
            onClick={clearRecents}
          >
            <Icon name="clock" size="sm" />
            Clear recent searches
          </Button>
        </div>
      ) : null}
    </div>
  );
}
