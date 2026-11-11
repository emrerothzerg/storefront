"use client";

import { useId, useSyncExternalStore } from "react";
import type { ChangeEvent } from "react";
import { Button } from "@/components/atoms/Button";
import { Icon } from "@/components/atoms/Icon";
import { Select, type SelectOption } from "@/components/atoms/Select";

export interface SortSelectControlsProps {
  value: string;
  options: readonly SelectOption[];
  /** Defaults to "Sort by". */
  label?: string;
}

const noopSubscribe = () => () => {};

/** false in server HTML and during hydration, true afterwards. */
function useIsHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Label + `<select name="sort">` + "Apply" submit. Below `md` the label
 * text is visually hidden (sort icon only, the text stays the accessible
 * name) and the select is a compact fixed width, so the listing toolbar stays
 * one row on phones (T179 U07). Server HTML shows the
 * button (works without JS). After hydration the select submits its form on
 * change (`requestSubmit`, falling back to `submit`) and the button becomes
 * visually hidden, reappearing while focused so keyboard users never land on
 * an invisible control.
 */
export function SortSelectControls({ value, options, label = "Sort by" }: SortSelectControlsProps) {
  const id = `${useId()}-sort`;
  const enhanced = useIsHydrated();

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const form = event.currentTarget.form;
    if (form === null) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="inline-flex items-center gap-1 text-small text-text-primary">
        <Icon name="sort" size="sm" />
        {/* Below md only the icon shows; the text stays the select's accessible name (U07). */}
        <span className="sr-only md:not-sr-only" data-slot="sort-label-text">
          {label}
        </span>
      </label>
      {/* Compact fixed width below md so Filter + Sort fit one row at 320 px (U07). */}
      <div className="w-28 min-w-0 sm:w-40 md:w-auto" data-slot="sort-select-box">
        <Select id={id} name="sort" options={options} defaultValue={value} onChange={handleChange} />
      </div>
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        data-enhanced={enhanced ? "true" : undefined}
        className={enhanced ? "sr-only focus:not-sr-only" : undefined}
      >
        Apply
      </Button>
    </div>
  );
}
