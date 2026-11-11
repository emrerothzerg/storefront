"use client";

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComponentPropsWithRef, KeyboardEvent, MouseEvent, ReactNode } from "react";

export type TabsOrientation = "horizontal" | "vertical";
export type TabsActivationMode = "automatic" | "manual";

interface TabEntry {
  value: string;
  element: HTMLElement;
  disabled: boolean;
}

/**
 * Registry of mounted Tabs (DOM order, disabled state), so Tabs can find the
 * first enabled tab when `value` matches none; otherwise no tab would get
 * `tabIndex=0` and the tablist would be unreachable by keyboard.
 */
interface TabRegistry {
  register: (entry: TabEntry) => () => void;
  subscribe: (listener: () => void) => () => void;
  /** First enabled tab's value if `value` is not an enabled tab, else null. */
  fallbackFor: (value: string) => string | null;
}

function createTabRegistry(): TabRegistry {
  const entries = new Set<TabEntry>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    register(entry) {
      entries.add(entry);
      notify();
      return () => {
        entries.delete(entry);
        notify();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fallbackFor(value) {
      const enabled = Array.from(entries)
        .filter((entry) => !entry.disabled)
        .sort((a, b) =>
          a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        );
      if (enabled.length === 0 || enabled.some((entry) => entry.value === value)) return null;
      return enabled[0]?.value ?? null;
    },
  };
}

interface TabsContextValue {
  baseId: string;
  /** Selected value (after the uncontrolled fallback). */
  value: string;
  /** The tab that gets `tabIndex=0`: the selected one, or the first enabled tab. */
  focusValue: string;
  registry: TabRegistry;
  select: (value: string) => void;
  orientation: TabsOrientation;
  activationMode: TabsActivationMode;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error(`<${component}> must be rendered inside <Tabs>.`);
  return ctx;
}

/**
 * Turns an arbitrary tab value into a safe, collision-free id fragment: every
 * character outside [A-Za-z0-9-] (including "_" itself) becomes `_<hex>_`,
 * so "_" only ever appears as an escape delimiter and the mapping is injective.
 */
export function idFragment(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}_`);
}

export function tabId(baseId: string, value: string): string {
  return `${baseId}-tab-${idFragment(value)}`;
}

export function panelId(baseId: string, value: string): string {
  return `${baseId}-panel-${idFragment(value)}`;
}

interface TabsCommonProps extends Omit<ComponentPropsWithRef<"div">, "defaultValue" | "onChange"> {
  /** Arrow-key axis and layout. Defaults to "horizontal". */
  orientation?: TabsOrientation;
  /**
   * "automatic" (default): arrow keys move focus AND select.
   * "manual": arrow keys move focus only; Enter/Space selects. Use when
   * showing a panel is expensive.
   */
  activationMode?: TabsActivationMode;
  /** Called with the newly selected tab value (both modes). */
  onValueChange?: (value: string) => void;
  children: ReactNode;
}

interface TabsControlledProps extends TabsCommonProps {
  /** Selected tab value (controlled). */
  value: string;
  defaultValue?: never;
}

interface TabsUncontrolledProps extends TabsCommonProps {
  value?: never;
  /** Initially selected tab value (uncontrolled). */
  defaultValue: string;
}

export type TabsProps = TabsControlledProps | TabsUncontrolledProps;

/**
 * WAI-ARIA tabs. Client-only behaviour: without JavaScript only the initially
 * selected panel is visible, so never put content that must be reachable
 * without JS (or by search engines) solely inside a non-default panel; render
 * it outside Tabs or give each section an anchor.
 */
export function Tabs({
  value: valueProp,
  defaultValue,
  onValueChange,
  orientation = "horizontal",
  activationMode = "automatic",
  className,
  ref,
  children,
  ...rest
}: TabsProps) {
  const baseId = useId();
  const [registry] = useState(createTabRegistry);
  const [internal, setInternal] = useState<string>(defaultValue ?? "");
  const isControlled = valueProp !== undefined;
  const requested = isControlled ? valueProp : internal;
  const fallback = useSyncExternalStore(
    registry.subscribe,
    () => registry.fallbackFor(requested),
    () => null,
  );
  // Uncontrolled: a stale or disabled default selects the first enabled tab.
  // Controlled: selection stays with the parent; only focusability falls back.
  const value = !isControlled && fallback !== null ? fallback : requested;
  const focusValue = fallback ?? value;

  const select = useCallback(
    (next: string) => {
      if (!isControlled) setInternal(next);
      if (next !== value) onValueChange?.(next);
    },
    [isControlled, onValueChange, value],
  );

  return (
    <TabsContext.Provider
      value={{ baseId, value, focusValue, registry, select, orientation, activationMode }}
    >
      <div
        {...rest}
        ref={ref}
        data-orientation={orientation}
        className={[
          orientation === "vertical" ? "flex flex-col gap-4 sm:flex-row" : "flex flex-col gap-4",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export interface TabListProps extends Omit<ComponentPropsWithRef<"div">, "role"> {
  /** Accessible name for the tab list, unless `aria-labelledby` is given. */
  "aria-label"?: string;
  children: ReactNode;
}

export function TabList({ className, onKeyDown, ref, children, ...rest }: TabListProps) {
  const { orientation, activationMode, select } = useTabsContext("TabList");

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const prevKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
    const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
    if (![prevKey, nextKey, "Home", "End"].includes(event.key)) return;

    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
    );
    if (tabs.length === 0) return;
    const current = tabs.findIndex((tab) => tab === document.activeElement);
    let nextIndex: number;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else if (event.key === nextKey) nextIndex = current < 0 ? 0 : (current + 1) % tabs.length;
    else nextIndex = current < 0 ? tabs.length - 1 : (current - 1 + tabs.length) % tabs.length;

    const target = tabs[nextIndex];
    if (!target) return;
    event.preventDefault();
    target.focus();
    const targetValue = target.dataset.value;
    if (activationMode === "automatic" && targetValue !== undefined) select(targetValue);
  };

  return (
    <div
      {...rest}
      ref={ref}
      role="tablist"
      aria-orientation={orientation}
      onKeyDown={handleKeyDown}
      className={[
        orientation === "vertical"
          ? "flex flex-col gap-1 border-s border-border-default"
          : "flex flex-wrap gap-1 border-b border-border-default",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

export interface TabProps
  extends Omit<ComponentPropsWithRef<"button">, "role" | "value" | "type" | "id"> {
  /** Must match the `value` of one TabPanel. */
  value: string;
  children: ReactNode;
}

const tabBase =
  "inline-flex min-h-touch min-w-touch items-center justify-center gap-2 px-4 py-2 text-body transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export function Tab({ value, className, onClick, disabled, ref, children, ...rest }: TabProps) {
  const { baseId, value: selectedValue, focusValue, registry, select, orientation } =
    useTabsContext("Tab");
  const selected = value === selectedValue;
  const elementRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    return registry.register({ value, element, disabled: Boolean(disabled) });
  }, [registry, value, disabled]);

  const setRefs = useCallback(
    (node: HTMLButtonElement | null) => {
      elementRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) select(value);
  };

  // Selection is shown by a 2px accent bar AND bold weight, never colour alone.
  const indicator =
    orientation === "vertical"
      ? "-ms-px justify-start border-s-2 text-start"
      : "-mb-px border-b-2";
  const state = selected
    ? "border-accent font-semibold text-accent"
    : "border-transparent text-text-secondary hover:border-border-strong hover:text-text-primary";

  return (
    <button
      {...rest}
      ref={setRefs}
      type="button"
      role="tab"
      id={tabId(baseId, value)}
      data-value={value}
      aria-selected={selected}
      aria-controls={panelId(baseId, value)}
      tabIndex={value === focusValue && !disabled ? 0 : -1}
      disabled={disabled}
      onClick={handleClick}
      className={[tabBase, indicator, state, className].filter(Boolean).join(" ")}
    >
      {children}
    </button>
  );
}

export interface TabPanelProps extends Omit<ComponentPropsWithRef<"div">, "role" | "id" | "hidden"> {
  /** Matches the `value` of its Tab. */
  value: string;
  children: ReactNode;
}

export function TabPanel({ value, className, ref, children, ...rest }: TabPanelProps) {
  const { baseId, value: selectedValue } = useTabsContext("TabPanel");
  const selected = value === selectedValue;
  return (
    <div
      {...rest}
      ref={ref}
      role="tabpanel"
      id={panelId(baseId, value)}
      aria-labelledby={tabId(baseId, value)}
      tabIndex={0}
      hidden={!selected}
      className={["min-w-0 flex-1", className].filter(Boolean).join(" ")}
    >
      {children}
    </div>
  );
}
