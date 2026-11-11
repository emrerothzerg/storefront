"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import type { ComponentPropsWithRef, MouseEvent, ReactNode, Ref } from "react";
import { Icon } from "../Icon";

export type DialogSize = "sm" | "md" | "lg";

export interface DialogProps
  extends Omit<ComponentPropsWithRef<"dialog">, "open" | "title" | "role" | "onClose" | "onCancel"> {
  /** Whether the modal is shown. The component calls `showModal()` / `close()`. */
  open: boolean;
  /**
   * Called when the dialog asks to close: Escape, the Close button, a backdrop
   * click (`closeOnBackdrop`), or a `<form method="dialog">` submit. Set
   * `open` to false in response.
   */
  onClose: () => void;
  /**
   * Visible heading; names the dialog via `aria-labelledby`. Must be
   * non-empty: an empty or whitespace-only string leaves the dialog without
   * an accessible name (logs a warning outside production).
   */
  title: ReactNode;
  /** Optional supporting text; referenced by `aria-describedby`. */
  description?: ReactNode;
  /** Max width: sm 384px, md 512px, lg 768px (always within the viewport). Defaults to "md". */
  size?: DialogSize;
  /** Close when the backdrop is clicked. Defaults to true (false for `alert`). */
  closeOnBackdrop?: boolean;
  /** `role="alertdialog"` for urgent confirmations (e.g. "Remove all items?"). */
  alert?: boolean;
  /** Accessible name of the built-in close button. Defaults to "Close". */
  closeLabel?: string;
  children?: ReactNode;
}

const sizeClasses: Record<DialogSize, string> = {
  sm: "w-96",
  md: "w-128",
  lg: "w-192",
};

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * Modal dialog on the native `<dialog>` element (`showModal()`): the browser
 * provides the top layer, inert background (focus containment) and Escape.
 * This component adds: `aria-labelledby`/`aria-describedby`, a Close button,
 * backdrop-click close, body scroll lock while open, and focus return to the
 * element that was focused when it opened.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  size = "md",
  alert = false,
  closeOnBackdrop = !alert,
  closeLabel = "Close",
  className,
  children,
  onClick,
  ref,
  ...rest
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const restoreOverflowRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  const openRef = useRef(open);
  const titleId = useId();
  const descriptionId = useId();
  const emptyTitle = typeof title === "string" && title.trim() === "";

  useEffect(() => {
    if (emptyTitle && process.env.NODE_ENV !== "production") {
      console.warn(
        "[Dialog] `title` must be non-empty visible text; it is the dialog's accessible name.",
      );
    }
  }, [emptyTitle]);

  useEffect(() => {
    onCloseRef.current = onClose;
    openRef.current = open;
  });

  const setRefs = useCallback(
    (node: HTMLDialogElement | null) => {
      dialogRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  /** Idempotent: restores the saved body overflow once, then forgets it. */
  const unlockScroll = useCallback(() => {
    if (restoreOverflowRef.current !== null) {
      document.body.style.overflow = restoreOverflowRef.current;
      restoreOverflowRef.current = null;
    }
  }, []);

  /** Idempotent: focuses the saved opener once, then forgets it. */
  const returnFocus = useCallback(() => {
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && opener.isConnected) opener.focus();
  }, []);

  // Derived from `open`, and safe under StrictMode's mount -> cleanup -> mount:
  // the lock is (re)applied on every run while open, the previous overflow
  // and the opener are saved only if not already saved, and the cleanup only
  // undoes the lock (focus returns on the native close event, or on a real
  // unmount, detected after the fact because StrictMode re-runs synchronously).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!open) {
      if (dialog.open) dialog.close();
      return;
    }
    if (openerRef.current === null) {
      const active = document.activeElement;
      openerRef.current =
        active instanceof HTMLElement && !dialog.contains(active) ? active : null;
    }
    if (restoreOverflowRef.current === null) {
      restoreOverflowRef.current = document.body.style.overflow;
    }
    document.body.style.overflow = "hidden";
    if (!dialog.open) dialog.showModal();

    return () => {
      unlockScroll();
      queueMicrotask(() => {
        // Still mounted and open = StrictMode re-run or open->false (handled
        // by the close event); detached = real unmount while open.
        if (!dialog.isConnected) returnFocus();
      });
    };
  }, [open, unlockScroll, returnFocus]);

  // Native close (Escape, .close(), form method=dialog) -> restore + notify.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => {
      unlockScroll();
      returnFocus();
      if (openRef.current) onCloseRef.current();
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [unlockScroll, returnFocus]);

  const handleClick = (event: MouseEvent<HTMLDialogElement>) => {
    onClick?.(event);
    // Clicks on ::backdrop target the <dialog> itself; content sits in an
    // inner wrapper that covers the whole box, so this is backdrop-only.
    if (closeOnBackdrop && event.target === event.currentTarget) onClose();
  };

  return (
    // Backdrop click is a pointer shortcut; Escape and the Close button are the keyboard paths.
    <dialog
      {...rest}
      ref={setRefs}
      role={alert ? "alertdialog" : undefined}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClick={handleClick}
      className={[
        "z-modal m-auto overscroll-contain rounded-xl border border-border-strong bg-surface-raised p-0 text-text-primary shadow-lg backdrop:bg-scrim",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className={["flex max-w-full flex-col gap-4 p-4 sm:p-6", sizeClasses[size]].join(" ")}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className="text-h3 text-text-primary">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-small text-text-secondary">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="-me-2 -mt-2 inline-flex size-touch shrink-0 items-center justify-center rounded-md text-text-primary hover:bg-surface-sunken"
          >
            <Icon name="close" size="md" />
          </button>
        </div>
        {children != null ? <div className="text-body">{children}</div> : null}
      </div>
    </dialog>
  );
}

export type DialogFooterProps = ComponentPropsWithRef<"div">;

/** Action row: stacked (primary on top) on mobile, right-aligned row from sm. */
export function DialogFooter({ className, ref, ...rest }: DialogFooterProps) {
  return (
    <div
      {...rest}
      ref={ref}
      className={["mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
