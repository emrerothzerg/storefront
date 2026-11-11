"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import type { ComponentPropsWithRef, MouseEvent, ReactNode, Ref } from "react";
import { IconButton } from "../IconButton";

export type DrawerSide = "left" | "right" | "bottom";
export type DrawerSize = "sm" | "md" | "lg";

export interface DrawerProps
  extends Omit<
    ComponentPropsWithRef<"dialog">,
    "open" | "title" | "role" | "onClose" | "onCancel" | "children"
  > {
  /** Whether the drawer is shown. The component calls `showModal()` / `close()`. */
  open: boolean;
  /**
   * Called when the drawer asks to close: Escape, the Close button, a backdrop
   * click (`closeOnBackdrop`) or a `<form method="dialog">` submit. Set
   * `open` to false in response.
   */
  onClose: () => void;
  /**
   * Visible heading; names the drawer via `aria-labelledby`. Must be
   * non-empty text: an empty title leaves the dialog unnamed and logs a
   * development warning.
   */
  title: ReactNode;
  /** Edge the panel slides in from. Defaults to "left". */
  side?: DrawerSide;
  /**
   * left/right: panel width 288 / 320 / 384px (never wider than the viewport).
   * bottom: max height 50% / 75% / 100% of the viewport. Defaults to "md".
   */
  size?: DrawerSize;
  /** Close when the backdrop is clicked. Defaults to true. */
  closeOnBackdrop?: boolean;
  /** Accessible name of the built-in close button. Defaults to "Close". */
  closeLabel?: string;
  /** Scrollable body content. */
  children?: ReactNode;
  /** Pinned action row below the body (e.g. "Show 24 results"). */
  footer?: ReactNode;
}

/*
 * Positioning overrides the UA `dialog:modal` box (centred, max-width/height
 * with a gutter). Slide: the closed position is off-screen; `open:` moves it
 * in and `starting:open:` (@starting-style) gives the entry a start frame.
 * `transition-discrete` keeps display/overlay alive for the exit where the
 * browser supports it. Reduced motion: `motion-reduce:transition-none` plus
 * the global base-layer rule. The edge facing the page gets a
 * `border-border-strong` line (plus shadow-lg) so the panel edge stays crisp
 * against the scrim (light mode only; see globals.css).
 */
const sideClasses: Record<DrawerSide, string> = {
  left: "inset-y-0 left-0 right-auto h-dvh max-h-dvh max-w-full -translate-x-full open:translate-x-0 starting:open:-translate-x-full border-e",
  right:
    "inset-y-0 right-0 left-auto h-dvh max-h-dvh max-w-full translate-x-full open:translate-x-0 starting:open:translate-x-full border-s",
  bottom:
    "inset-x-0 bottom-0 top-auto h-auto w-full max-w-full translate-y-full open:translate-y-0 starting:open:translate-y-full rounded-t-xl border-t",
};

const sizeClasses: Record<DrawerSide, Record<DrawerSize, string>> = {
  left: { sm: "w-72", md: "w-80", lg: "w-96" },
  right: { sm: "w-72", md: "w-80", lg: "w-96" },
  bottom: { sm: "max-h-1/2", md: "max-h-3/4", lg: "max-h-dvh" },
};

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * Slide-over panel (mobile navigation, filters) on the native `<dialog>`
 * element via `showModal()`: the browser provides the top layer, the inert
 * background (focus stays inside) and hides it from the accessibility tree
 * while closed. This component adds `aria-labelledby`, a Close button,
 * Escape and backdrop-click close as `onClose` requests, body scroll lock
 * while open, and focus return to the opener.
 *
 * ```tsx
 * const [open, setOpen] = useState(false);
 * <Button onClick={() => setOpen(true)}>Filters</Button>
 * <Drawer open={open} onClose={() => setOpen(false)} title="Filters" side="right"
 *   footer={<Button fullWidth onClick={() => setOpen(false)}>Show results</Button>}>
 *   ...filter controls...
 * </Drawer>
 * ```
 */
export function Drawer({
  open,
  onClose,
  title,
  side = "left",
  size = "md",
  closeOnBackdrop = true,
  closeLabel = "Close",
  className,
  children,
  footer,
  onClick,
  ref,
  ...rest
}: DrawerProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const restoreOverflowRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  const openRef = useRef(open);
  const titleId = useId();

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

  // Dev-only guard: the title is the dialog's accessible name.
  const titleMissing =
    title == null || title === false || (typeof title === "string" && title.trim() === "");
  useEffect(() => {
    if (titleMissing && process.env.NODE_ENV !== "production") {
      console.warn("Drawer: `title` must be non-empty text; it is the dialog's accessible name.");
    }
  }, [titleMissing]);

  // Idempotent scroll lock: saves the previous value once, restores it once.
  const lockScroll = useCallback(() => {
    if (restoreOverflowRef.current === null) {
      restoreOverflowRef.current = document.body.style.overflow;
    }
    document.body.style.overflow = "hidden";
  }, []);

  const unlockScroll = useCallback(() => {
    if (restoreOverflowRef.current !== null) {
      document.body.style.overflow = restoreOverflowRef.current;
      restoreOverflowRef.current = null;
    }
  }, []);

  const returnFocus = useCallback(() => {
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && opener.isConnected) opener.focus();
  }, []);

  // Sync the `open` prop with the native modal state. The lock is derived
  // from `open` (not `dialog.open`), so a StrictMode cleanup + re-run, which
  // finds the dialog already open, re-applies it. The opener is captured
  // only when the modal is actually shown and survives that re-run.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!open) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
      dialog.showModal();
    }
    lockScroll();
    return () => {
      unlockScroll();
      // Real unmount: the dialog is already detached, so return focus here.
      // Closing via props returns focus from the `close` event instead, and
      // a StrictMode simulated unmount (dialog still attached) keeps the opener.
      if (!dialog.isConnected) returnFocus();
    };
  }, [open, lockScroll, unlockScroll, returnFocus]);

  // Escape fires `cancel`: keep the drawer controlled (the parent decides),
  // so prevent the native close and ask via onClose. Any native close
  // (prop change, form method=dialog, .close()) restores and notifies.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    const handleClose = () => {
      unlockScroll();
      returnFocus();
      if (openRef.current) onCloseRef.current();
    };
    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("close", handleClose);
    };
  }, [unlockScroll, returnFocus]);

  const handleClick = (event: MouseEvent<HTMLDialogElement>) => {
    onClick?.(event);
    // The inner panel fills the whole dialog box, so a click whose target is
    // the <dialog> itself landed on ::backdrop.
    if (closeOnBackdrop && event.target === event.currentTarget) onClose();
  };

  return (
    // Backdrop click is a pointer shortcut; Escape and the Close button are the keyboard paths.
    <dialog
      {...rest}
      ref={setRefs}
      aria-modal="true"
      aria-labelledby={titleId}
      data-side={side}
      onClick={handleClick}
      className={[
        "fixed z-modal m-0 flex-col overflow-hidden overscroll-contain border-border-strong bg-surface-raised p-0 text-text-primary shadow-lg open:flex",
        "transition-all transition-discrete duration-300 ease-out motion-reduce:transition-none",
        "backdrop:bg-scrim",
        sideClasses[side],
        sizeClasses[side][size],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-default py-2 ps-4 pe-2">
          <h2 id={titleId} className="min-w-0 break-words text-h3 text-text-primary">
            {title}
          </h2>
          <IconButton icon="close" label={closeLabel} onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 text-body">
          {children}
        </div>
        {footer != null ? (
          <div className="shrink-0 border-t border-border-default p-4">{footer}</div>
        ) : null}
      </div>
    </dialog>
  );
}
