"use client";

import { useId } from "react";
import type { ComponentPropsWithRef, ReactNode, SyntheticEvent } from "react";
import { Icon } from "../Icon";

export type DisclosureVariant = "plain" | "bordered";

export interface DisclosureProps
  extends Omit<ComponentPropsWithRef<"details">, "open" | "onToggle" | "children"> {
  /** Always-visible trigger content, rendered inside `<summary>`. Keep it to phrasing content (no headings or links). */
  summary: ReactNode;
  /** Revealed content. */
  children: ReactNode;
  /** Uncontrolled initial state (rendered as the `open` attribute, so it also works without JS). */
  defaultOpen?: boolean;
  /** Controlled state. Pair with `onOpenChange`. */
  open?: boolean;
  /** Called from the native `toggle` event whenever the user (or a sibling in an exclusive group) changes the state. */
  onOpenChange?: (open: boolean) => void;
  /** Defaults to "plain". */
  variant?: DisclosureVariant;
  /**
   * Native exclusive group: `<details>` elements sharing a `name` close each
   * other. Usually set by Accordion.
   */
  name?: string;
  /** Classes for the `<summary>` row. */
  summaryClassName?: string;
}

const variantClasses: Record<DisclosureVariant, { root: string; summary: string; content: string }> = {
  plain: {
    root: "border-b border-border-default",
    summary: "py-2",
    content: "pb-4",
  },
  bordered: {
    root: "rounded-lg border border-border-default bg-surface-raised",
    summary: "rounded-lg px-4 py-2",
    content: "px-4 pb-4",
  },
};

/**
 * Show/hide section built on native `<details>`/`<summary>`: keyboard
 * (Enter/Space on the summary), screen-reader state and find-in-page all come
 * from the browser and work without JavaScript. The chevron rotates via the
 * `open` attribute (no JS needed either).
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  variant = "plain",
  name,
  className,
  summaryClassName,
  ref,
  ...rest
}: DisclosureProps) {
  const isControlled = open !== undefined;
  const styles = variantClasses[variant];

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const next = event.currentTarget.open;
    // Native toggle also fires after React sets `open`; only report real changes.
    if (isControlled && next === open) return;
    onOpenChange?.(next);
  };

  return (
    <details
      {...rest}
      ref={ref}
      name={name}
      open={isControlled ? open : defaultOpen}
      onToggle={handleToggle}
      className={["group/disclosure", styles.root, className].filter(Boolean).join(" ")}
    >
      <summary
        className={[
          "flex min-h-touch cursor-pointer list-none items-center justify-between gap-3 text-body font-semibold text-text-primary hover:text-accent",
          styles.summary,
          summaryClassName,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <Icon
          name="chevron-down"
          size="md"
          className="transition-transform group-open/disclosure:rotate-180"
          data-testid="disclosure-chevron"
        />
      </summary>
      <div className={["text-body text-text-primary", styles.content].join(" ")}>{children}</div>
    </details>
  );
}

export interface AccordionItem {
  /** Stable key. */
  id: string;
  summary: ReactNode;
  content: ReactNode;
  defaultOpen?: boolean;
}

export interface AccordionProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
  items: AccordionItem[];
  /**
   * Only one item open at a time, using the native `name` attribute on
   * `<details>` (no JS; browsers without support degrade to independent items).
   * With `exclusive`, give at most one item `defaultOpen`.
   */
  exclusive?: boolean;
  /** Group name for `exclusive`. Defaults to a generated id. */
  name?: string;
  /** Defaults to "plain". */
  variant?: DisclosureVariant;
  /** Fires with the item id and its new state. */
  onItemToggle?: (id: string, open: boolean) => void;
}

/** A stack of uncontrolled Disclosures (FAQ, filters, "About this item"). */
export function Accordion({
  items,
  exclusive = false,
  name,
  variant = "plain",
  onItemToggle,
  className,
  ref,
  ...rest
}: AccordionProps) {
  const generatedName = useId();
  const groupName = exclusive ? (name ?? generatedName) : undefined;
  return (
    <div
      {...rest}
      ref={ref}
      className={["flex flex-col", variant === "bordered" ? "gap-2" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      {items.map((item) => (
        <Disclosure
          key={item.id}
          summary={item.summary}
          defaultOpen={item.defaultOpen}
          variant={variant}
          name={groupName}
          onOpenChange={onItemToggle ? (isOpen) => onItemToggle(item.id, isOpen) : undefined}
        >
          {item.content}
        </Disclosure>
      ))}
    </div>
  );
}
