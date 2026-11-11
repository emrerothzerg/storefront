"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { Button } from "../Button";
import { Icon, type IconName } from "../Icon";

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface ToastAction {
  /** Visible button text, e.g. "View cart". The same action must also be reachable elsewhere on the page. */
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string;
  /** Defaults to "info". info/success are announced politely; warning/danger interrupt (`role="alert"`). */
  tone?: ToastTone;
  /** Optional single action; clicking it also dismisses the toast. */
  action?: ToastAction;
  /**
   * Auto-dismiss delay in ms; `null` or `Infinity` keeps it until dismissed.
   * Defaults to 6000 for info/success and `null` for warning/danger (also used
   * for NaN or values <= 0); capped at 2^31 - 1. The timer pauses
   * while the toast is hovered or focused and restarts in full afterwards.
   */
  durationMs?: number | null;
}

export interface ToastRecord {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  action?: ToastAction;
  durationMs: number | null;
}

export interface ToastApi {
  /** Queue a toast; returns its id. */
  toast: (options: ToastOptions) => string;
  /** Remove a toast by id (no-op if already gone). */
  dismiss: (id: string) => void;
}

interface ToastContextValue extends ToastApi {
  toasts: ToastRecord[];
  maxVisible: number;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const DEFAULT_TOAST_DURATION_MS = 6000;
/** setTimeout's ceiling (2^31 - 1 ms); larger delays would fire immediately. */
export const MAX_TOAST_DURATION_MS = 2_147_483_647;
export const DEFAULT_MAX_VISIBLE_TOASTS = 3;

/**
 * Untrusted duration -> timer delay. `null`/Infinity -> never auto-dismiss;
 * NaN, -Infinity or <= 0 -> the tone default; otherwise capped at 2^31 - 1.
 */
export function normalizeToastDuration(
  durationMs: number | null | undefined,
  tone: ToastTone,
): number | null {
  const toneDefault = tone === "warning" || tone === "danger" ? null : DEFAULT_TOAST_DURATION_MS;
  if (durationMs === null || durationMs === Number.POSITIVE_INFINITY) return null;
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return toneDefault;
  return Math.min(durationMs, MAX_TOAST_DURATION_MS);
}

/** `const { toast } = useToast(); toast({ title: "Added to cart", tone: "success" })`. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast() must be used inside <ToastProvider>.");
  return { toast: ctx.toast, dismiss: ctx.dismiss };
}

export interface ToastProviderProps {
  children: ReactNode;
  /** Visible at once; extra toasts wait in a queue. Defaults to 3 (also for NaN/Infinity); values < 1 clamp to 1. */
  maxVisible?: number;
  /** Render the default `<ToastViewport />` after children. Set false to place it yourself. Defaults to true. */
  viewport?: boolean;
}

/**
 * Client-side toast state. Toasts are an enhancement: server actions must
 * still render an inline status message so no-JS users get the result.
 */
export function ToastProvider({ children, maxVisible = 3, viewport = true }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    counter.current += 1;
    const id = `toast-${counter.current}`;
    const tone = options.tone ?? "info";
    const durationMs = normalizeToastDuration(options.durationMs, tone);
    const record: ToastRecord = {
      id,
      title: options.title,
      description: options.description,
      tone,
      action: options.action,
      durationMs,
    };
    setToasts((current) => [...current, record]);
    return id;
  }, []);

  const value = useMemo(
    () => ({
      toasts,
      toast,
      dismiss,
      // Non-finite -> default; finite values are floored and clamped to >= 1.
      maxVisible: Number.isFinite(maxVisible)
        ? Math.max(1, Math.floor(maxVisible))
        : DEFAULT_MAX_VISIBLE_TOASTS,
    }),
    [toasts, toast, dismiss, maxVisible],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {viewport ? <ToastViewport /> : null}
    </ToastContext.Provider>
  );
}

export interface ToastViewportProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
  /** Accessible name of the notifications area. Defaults to "Notifications". */
  label?: string;
}

/**
 * Fixed stack, `z-toast` (above the `z-sticky` header and sticky buy box):
 * bottom-centre on mobile; top-right from md, offset 64px (`md:top-16`) so
 * it sits just under the sticky top bar and never covers the cart count or
 * a sticky "Add to cart" button that was just pressed.
 * Two live regions are always rendered (empty) so additions are announced:
 * polite for info/success, `role="alert"` for warning/danger.
 */
export function ToastViewport({ label = "Notifications", className, ref, ...rest }: ToastViewportProps) {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("<ToastViewport> must be rendered inside <ToastProvider>.");
  const visible = ctx.toasts.slice(0, ctx.maxVisible);
  const polite = visible.filter((t) => t.tone === "info" || t.tone === "success");
  const urgent = visible.filter((t) => t.tone === "warning" || t.tone === "danger");
  const listClasses = "flex w-full flex-col items-center gap-2 md:items-end";

  return (
    <div
      {...rest}
      ref={ref}
      aria-label={label}
      role="region"
      className={[
        "pointer-events-none fixed bottom-0 left-0 right-0 z-toast flex flex-col gap-2 p-4 md:top-16 md:bottom-auto md:left-auto",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div role="alert" className={listClasses}>
        {urgent.map((t) => (
          <ToastItem key={t.id} record={t} onDismiss={ctx.dismiss} />
        ))}
      </div>
      <div role="status" aria-live="polite" aria-atomic="false" className={listClasses}>
        {polite.map((t) => (
          <ToastItem key={t.id} record={t} onDismiss={ctx.dismiss} />
        ))}
      </div>
    </div>
  );
}

const toneStyles: Record<ToastTone, { box: string; icon: string; iconName: IconName; srLabel: string }> = {
  info: { box: "bg-info-subtle border-info", icon: "text-info", iconName: "info", srLabel: "Info" },
  success: {
    box: "bg-success-subtle border-success",
    icon: "text-success",
    iconName: "check-circle",
    srLabel: "Success",
  },
  warning: {
    box: "bg-warning-subtle border-warning",
    icon: "text-warning",
    iconName: "warning",
    srLabel: "Warning",
  },
  danger: {
    box: "bg-danger-subtle border-danger",
    icon: "text-danger",
    iconName: "error-circle",
    srLabel: "Error",
  },
};

interface ToastItemProps {
  record: ToastRecord;
  onDismiss: (id: string) => void;
}

function ToastItem({ record, onDismiss }: ToastItemProps) {
  const { id, title, description, tone, action, durationMs } = record;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const styles = toneStyles[tone];

  useEffect(() => {
    if (durationMs === null || paused) return;
    const timer = setTimeout(() => onDismiss(id), durationMs);
    return () => clearTimeout(timer);
  }, [durationMs, paused, id, onDismiss]);

  return (
    <div
      data-toast-id={id}
      data-tone={tone}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onDismiss(id);
      }}
      className={[
        "pointer-events-auto flex w-full items-start gap-3 rounded-lg border p-3 text-text-primary shadow-lg md:w-96",
        styles.box,
      ].join(" ")}
    >
      <Icon name={styles.iconName} size="md" className={["mt-0.5", styles.icon].join(" ")} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body font-semibold">
          <span className="sr-only">{styles.srLabel}: </span>
          {title}
        </p>
        {description ? <p className="text-small">{description}</p> : null}
        {action ? (
          <div className="mt-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                action.onClick();
                onDismiss(id);
              }}
            >
              {action.label}
            </Button>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={`Dismiss notification: ${title}`}
        onClick={() => onDismiss(id)}
        className="-me-1 -mt-1 inline-flex size-touch shrink-0 items-center justify-center rounded-md hover:bg-surface-raised"
      >
        <Icon name="close" size="sm" />
      </button>
    </div>
  );
}
