"use client";

import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ComponentPropsWithRef, FocusEvent, KeyboardEvent, ReactElement, ReactNode } from "react";

export type TooltipSide = "top" | "bottom" | "left" | "right";

/** Props the trigger must accept; merged onto it (or passed to the render prop). */
export interface TooltipTriggerProps {
  "aria-describedby"?: string;
}

export interface TooltipProps
  extends Omit<ComponentPropsWithRef<"span">, "children" | "content"> {
  /** Supplementary text. Never the only way to convey information. */
  content: ReactNode;
  /** Preferred side of the trigger. Defaults to "top". */
  side?: TooltipSide;
  /** Hover delay before showing, in ms. Focus shows immediately. Defaults to 300. */
  delayMs?: number;
  /**
   * The trigger: a single focusable element (`<button>`, `<a href>`, an atom
   * that renders one) that accepts `aria-describedby`, or a render prop that
   * spreads the given props onto one.
   */
  children:
    | ReactElement<TooltipTriggerProps>
    | ((triggerProps: Required<TooltipTriggerProps>) => ReactNode);
  /** Classes for the tooltip bubble (`className` goes on the wrapper). */
  tooltipClassName?: string;
}

const sideClasses: Record<TooltipSide, string> = {
  top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-2 -translate-x-1/2",
  left: "right-full top-1/2 me-2 -translate-y-1/2",
  right: "left-full top-1/2 ms-2 -translate-y-1/2",
};

const HIDE_DELAY_MS = 100;

/**
 * Hover + focus tooltip (`role="tooltip"`, referenced by the trigger's
 * `aria-describedby`). The bubble stays in the DOM (hidden) so the
 * description is always available to assistive tech. Escape dismisses; the
 * bubble is hoverable (moving the pointer onto it keeps it open).
 */
export function Tooltip({
  content,
  side = "top",
  delayMs = 300,
  children,
  className,
  tooltipClassName,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  onKeyDown,
  ref,
  ...rest
}: TooltipProps) {
  const tooltipId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const open = (hovered || focused) && !dismissed;

  // Escape must work while only hovered (focus may be elsewhere).
  useEffect(() => {
    if (!open) return;
    const onDocKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", onDocKeyDown);
    return () => document.removeEventListener("keydown", onDocKeyDown);
  }, [open]);

  const describedBy = (existing: string | undefined) =>
    [existing, tooltipId].filter(Boolean).join(" ");

  let trigger: ReactNode;
  if (typeof children === "function") {
    trigger = children({ "aria-describedby": tooltipId });
  } else if (isValidElement<TooltipTriggerProps>(children)) {
    trigger = cloneElement(children, {
      "aria-describedby": describedBy(children.props["aria-describedby"]),
    });
  } else {
    trigger = children;
  }

  return (
    <span
      {...rest}
      ref={ref}
      className={["relative inline-flex", className].filter(Boolean).join(" ")}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = null;
        if (hovered) return;
        if (showTimer.current) clearTimeout(showTimer.current);
        showTimer.current = setTimeout(() => {
          setDismissed(false);
          setHovered(true);
        }, delayMs);
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(event);
        if (showTimer.current) clearTimeout(showTimer.current);
        showTimer.current = null;
        hideTimer.current = setTimeout(() => setHovered(false), HIDE_DELAY_MS);
      }}
      onFocus={(event: FocusEvent<HTMLSpanElement>) => {
        onFocus?.(event);
        setDismissed(false);
        setFocused(true);
      }}
      onBlur={(event: FocusEvent<HTMLSpanElement>) => {
        onBlur?.(event);
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
        onKeyDown?.(event);
        if (event.key === "Escape" && open) {
          // Don't let a surrounding Dialog close on the same keypress.
          event.stopPropagation();
          setDismissed(true);
        }
      }}
    >
      {trigger}
      <span
        id={tooltipId}
        role="tooltip"
        hidden={!open}
        className={[
          "pointer-events-auto absolute z-dropdown w-max max-w-64 rounded-md bg-surface-inverse px-2 py-1 text-small text-text-inverse shadow-md",
          sideClasses[side],
          tooltipClassName,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {content}
      </span>
    </span>
  );
}
