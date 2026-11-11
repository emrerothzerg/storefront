"use client";

import { useCallback, useId, useRef, useState, useSyncExternalStore } from "react";
import type {
  ChangeEvent,
  ComponentPropsWithRef,
  FocusEvent,
  FormEvent,
  KeyboardEvent,
  ReactNode,
  Ref,
} from "react";
import { Button } from "../Button";
import { Icon, type IconName } from "../Icon";
import { Input } from "../Input";

export interface SearchSuggestion {
  id: string;
  /** Visible text and the option's accessible name (e.g. "Recent: lamp"). */
  label: string;
  href: string;
  /** Decorative icon before the label (e.g. "clock" for recent searches). */
  icon?: IconName;
  /** Text placed in the input when chosen. Defaults to `label`. */
  value?: string;
}

export interface SearchFieldProps
  extends Omit<ComponentPropsWithRef<"form">, "children" | "onChange" | "onSubmit" | "onSelect" | "role"> {
  /** Accessible label of the input. Defaults to "Search". */
  label?: string;
  /** Show the label visually. Defaults to false (visually hidden, still announced). */
  showLabel?: boolean;
  /** Input id. Defaults to a generated id. */
  inputId?: string;
  /** Query parameter name. Defaults to "q". */
  name?: string;
  /** GET target used without JS (and with JS unless `onSubmit` prevents it). Defaults to "/search". */
  action?: string;
  defaultValue?: string;
  placeholder?: string;
  /** Fires on every edit (including Clear) with the new query. Debounce suggestion fetches in the caller. */
  onChange?: (value: string) => void;
  /** Called on submit before the native GET; call `event.preventDefault()` to route client-side. */
  onSubmit?: (event: FormEvent<HTMLFormElement>, query: string) => void;
  /** Suggestions for the current query, rendered as a listbox under the input. */
  suggestions?: SearchSuggestion[];
  /**
   * Called when a suggestion is chosen (click or Enter). Without it the
   * browser navigates to `suggestion.href`.
   */
  onSelect?: (suggestion: SearchSuggestion) => void;
  /** Accessible name of the submit button. Defaults to "Submit search". */
  submitLabel?: string;
  /** Forwarded to the text input (`ref` goes to the `<form>`). */
  inputRef?: Ref<HTMLInputElement>;
  /** Native `maxlength` on the input (present in the no-JS server HTML too). */
  maxLength?: number;
  /**
   * Content at the bottom of the suggestions popup, outside the option list
   * (e.g. a "Clear recent searches" Button). Focusable content is allowed:
   * Tab from the input reaches it with the popup kept open; Escape inside it
   * closes the popup and returns focus to the input. Shown only while the
   * popup is open (i.e. there are suggestions).
   */
  listFooter?: ReactNode;
  /**
   * Accessible name of the `role="search"` landmark, so several search forms
   * on one page are distinguishable (e.g. "Help", "Search orders"). Defaults
   * to "Site search" (the header's search). Independent of `label` (the
   * input's name). An explicit `aria-label` / `aria-labelledby` on the form
   * still wins. Every other search form on a page must pass its own name.
   */
  landmarkLabel?: string;
  /**
   * `default`: bordered field with the submit button beside it.
   * `pill`: rounded light-grey field (48px) with the round submit button
   * inset at its end (header search in the Phase 3 design). Same markup
   * order, ARIA and no-JS behaviour in both.
   */
  variant?: SearchFieldVariant;
}

export type SearchFieldVariant = "default" | "pill";

/** Field label used when `label` is omitted. */
export const SEARCH_FIELD_DEFAULT_LABEL = "Search";
/** Landmark name used when `landmarkLabel` is omitted. */
export const SEARCH_FIELD_DEFAULT_LANDMARK_LABEL = "Site search";

const subscribe = () => () => {};

const popupClasses =
  "absolute left-0 right-0 top-full z-dropdown mt-1 rounded-md border border-border-strong bg-surface-raised shadow-md";
// Unchanged class string for the default (no footer) listbox.
const listboxClasses =
  "absolute left-0 right-0 top-full z-dropdown mt-1 max-h-80 overflow-y-auto rounded-md border border-border-strong bg-surface-raised py-1 shadow-md";

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * Site search: a `<form role="search" method="get">` that works as a plain
 * GET form without JS. With JS it adds a clear button and an optional
 * suggestions listbox (ARIA 1.2 combobox: Arrow keys, Enter, Escape).
 */
export function SearchField({
  label = SEARCH_FIELD_DEFAULT_LABEL,
  showLabel = false,
  inputId,
  name = "q",
  action = "/search",
  defaultValue = "",
  placeholder,
  onChange,
  onSubmit,
  suggestions = [],
  onSelect,
  submitLabel = "Submit search",
  inputRef,
  maxLength,
  listFooter,
  landmarkLabel,
  variant = "default",
  className,
  ref,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...rest
}: SearchFieldProps) {
  const pill = variant === "pill";
  const generatedId = useId();
  const id = inputId ?? `${generatedId}-input`;
  // Landmark name, most specific first: explicit ARIA on the form, then
  // landmarkLabel, then the default. Blank strings are ignored. Never derived
  // from the field label, so the input and the form never share a name.
  const trimmedLandmark = landmarkLabel?.trim() ?? "";
  const landmarkName: { "aria-label"?: string; "aria-labelledby"?: string } =
    ariaLabelledBy !== undefined && ariaLabelledBy.trim() !== ""
      ? { "aria-labelledby": ariaLabelledBy }
      : ariaLabel !== undefined && ariaLabel.trim() !== ""
        ? { "aria-label": ariaLabel }
        : { "aria-label": trimmedLandmark !== "" ? trimmedLandmark : SEARCH_FIELD_DEFAULT_LANDMARK_LABEL };
  const listboxId = `${id}-listbox`;
  const statusId = `${id}-status`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const [value, setValue] = useState(defaultValue);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const localInputRef = useRef<HTMLInputElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const clearRef = useRef<HTMLButtonElement | null>(null);
  // null / undefined / false / "" count as "no footer" (the `cond && <X />` idiom).
  const hasFooter = listFooter != null && listFooter !== false && listFooter !== "";
  // With a footer, input + Clear button + footer form one composite: focus
  // moving between them keeps the popup open (Tab order is input, Clear,
  // footer), anything else closes it.
  const isInComposite = (node: EventTarget | null): boolean =>
    node instanceof Node &&
    (node === localInputRef.current ||
      node === clearRef.current ||
      footerRef.current?.contains(node) === true);

  const hasSuggestions = suggestions.length > 0;
  const expanded = hydrated && focused && !dismissed && hasSuggestions;
  const active = expanded && activeIndex >= 0 && activeIndex < suggestions.length ? activeIndex : -1;

  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      localInputRef.current = node;
      assignRef(inputRef, node);
    },
    [inputRef],
  );

  const update = (next: string) => {
    setValue(next);
    setActiveIndex(-1);
    setDismissed(false);
    onChange?.(next);
  };

  const choose = (suggestion: SearchSuggestion) => {
    setDismissed(true);
    setActiveIndex(-1);
    setValue(suggestion.value ?? suggestion.label);
    if (onSelect) onSelect(suggestion);
    else window.location.assign(suggestion.href);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown": {
        if (!hasSuggestions) return;
        event.preventDefault();
        setDismissed(false);
        setActiveIndex((i) => (expanded ? (i + 1) % suggestions.length : 0));
        break;
      }
      case "ArrowUp": {
        if (!hasSuggestions) return;
        event.preventDefault();
        setDismissed(false);
        setActiveIndex((i) =>
          expanded ? (i <= 0 ? suggestions.length - 1 : i - 1) : suggestions.length - 1,
        );
        break;
      }
      case "Enter": {
        const suggestion = active >= 0 ? suggestions[active] : undefined;
        if (suggestion) {
          event.preventDefault();
          choose(suggestion);
        }
        break;
      }
      case "Escape": {
        if (expanded) {
          event.preventDefault();
          setDismissed(true);
          setActiveIndex(-1);
        } else if (value !== "") {
          event.preventDefault();
          update("");
        }
        break;
      }
    }
  };

  const renderListbox = (listClassName: string) => (
    <ul
      id={listboxId}
      role="listbox"
      aria-label={`${label} suggestions`}
      hidden={!expanded}
      className={listClassName}
    >
      {suggestions.map((suggestion, index) => (
        <li
          key={suggestion.id}
          id={optionId(index)}
          role="option"
          aria-selected={index === active}
          // Keep focus in the input so the click doesn't blur/close first.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(suggestion)}
          onMouseMove={() => {
            if (activeIndex !== index) setActiveIndex(index);
          }}
          className={[
            "flex min-h-touch cursor-pointer items-center px-3 py-2 text-body text-text-primary",
            index === active ? "bg-accent-subtle underline" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {/* Decorative; text-current keeps a verified pair on the accent-subtle highlight. */}
          {suggestion.icon ? (
            <Icon name={suggestion.icon} size="sm" className="me-2 shrink-0 text-current" />
          ) : null}
          {suggestion.label}
        </li>
      ))}
    </ul>
  );

  return (
    <form
      {...rest}
      ref={ref}
      role="search"
      {...landmarkName}
      method="get"
      action={action}
      onSubmit={(event) => onSubmit?.(event, value)}
      className={["flex w-full flex-col gap-1", className].filter(Boolean).join(" ")}
    >
      <label htmlFor={id} className={showLabel ? "text-small text-text-primary" : "sr-only"}>
        {label}
      </label>
      <div className="flex w-full items-stretch gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            ref={setInputRef}
            id={id}
            name={name}
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            placeholder={placeholder}
            maxLength={maxLength}
            value={value}
            onChange={(event: ChangeEvent<HTMLInputElement>) => update(event.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={(event: FocusEvent<HTMLInputElement>) => {
              setActiveIndex(-1);
              // With a footer, Tab to the Clear button or into the footer keeps the popup open.
              if (hasFooter && isInComposite(event.relatedTarget)) return;
              setFocused(false);
            }}
            role={hydrated ? "combobox" : undefined}
            aria-autocomplete={hydrated ? "list" : undefined}
            aria-expanded={hydrated ? expanded : undefined}
            aria-controls={hydrated ? listboxId : undefined}
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            variant={pill ? "pill" : "default"}
            className={
              pill
                ? hydrated && value !== ""
                  ? "pe-24"
                  : "pe-14"
                : hydrated && value !== ""
                  ? "pe-12"
                  : undefined
            }
          />
          {hydrated && value !== "" ? (
            <button
              ref={clearRef}
              type="button"
              aria-label="Clear search"
              onBlur={
                hasFooter
                  ? (event: FocusEvent<HTMLButtonElement>) => {
                      if (!isInComposite(event.relatedTarget)) setFocused(false);
                    }
                  : undefined
              }
              onClick={() => {
                update("");
                localInputRef.current?.focus();
              }}
              className={
                pill
                  ? "absolute top-0.5 end-12 inline-flex size-touch items-center justify-center rounded-full text-text-secondary hover:text-text-primary"
                  : "absolute inset-y-0 end-0 inline-flex size-touch items-center justify-center rounded-md text-text-secondary hover:text-text-primary"
              }
            >
              <Icon name="close" size="sm" />
            </button>
          ) : null}
          {hydrated && !hasFooter ? renderListbox(listboxClasses) : null}
          {hydrated && hasFooter ? (
            // Footer variant: the popup wraps the listbox and the footer so
            // the footer's controls stay outside the option list.
            <div
              hidden={!expanded}
              data-testid="search-suggestions-popup"
              className={`${popupClasses} max-h-80 overflow-y-auto`}
            >
              {renderListbox("py-1")}
              <div
                ref={footerRef}
                className="border-t border-border-default px-3 py-2"
                // Mouse clicks keep focus in the input so the popup stays open.
                onMouseDown={(event) => event.preventDefault()}
                onBlur={(event: FocusEvent<HTMLDivElement>) => {
                  if (!isInComposite(event.relatedTarget)) setFocused(false);
                }}
                onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setDismissed(true);
                  localInputRef.current?.focus();
                }}
              >
                {listFooter}
              </div>
            </div>
          ) : null}
          {pill ? (
            // Inset round submit, last in DOM (input, Clear, popup footer, submit) like the default variant.
            <Button
              type="submit"
              size="sm"
              aria-label={submitLabel}
              className="absolute top-0.5 end-0.5 size-touch"
            >
              <Icon name="search" size="md" />
            </Button>
          ) : null}
        </div>
        {pill ? null : (
          <Button type="submit" aria-label={submitLabel} className="shrink-0">
            <Icon name="search" size="md" />
          </Button>
        )}
      </div>
      {hydrated ? (
        <span id={statusId} role="status" className="sr-only">
          {expanded
            ? `${suggestions.length} ${suggestions.length === 1 ? "suggestion" : "suggestions"} available. Use the up and down arrows to review.`
            : ""}
        </span>
      ) : null}
    </form>
  );
}
