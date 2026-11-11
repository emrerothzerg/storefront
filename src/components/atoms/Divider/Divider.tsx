import type { HTMLAttributes, Ref } from "react";

export type DividerOrientation = "horizontal" | "vertical";

export interface DividerProps
  extends Omit<HTMLAttributes<HTMLElement>, "children" | "role" | "aria-orientation"> {
  /** Defaults to "horizontal". A vertical divider stretches to its flex row's height. */
  orientation?: DividerOrientation;
  /**
   * Short centred text ("or"), horizontal only. Exposed as the separator's
   * accessible name; ignored when `orientation="vertical"`.
   */
  label?: string;
  ref?: Ref<HTMLElement>;
}

/**
 * Thematic break. Plain horizontal -> `<hr>`; labelled or vertical ->
 * `role="separator"` with `aria-orientation`. Decorative colour
 * (`border-default`), so never use it as the only boundary of a control.
 */
export function Divider({
  orientation = "horizontal",
  label,
  className,
  ref,
  ...rest
}: DividerProps) {
  const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" ");

  if (orientation === "vertical") {
    return (
      <div
        {...rest}
        ref={ref as Ref<HTMLDivElement>}
        role="separator"
        aria-orientation="vertical"
        className={join("w-px shrink-0 self-stretch bg-border-default", className)}
      />
    );
  }

  const text = label?.trim();
  if (text) {
    return (
      <div
        {...rest}
        ref={ref as Ref<HTMLDivElement>}
        role="separator"
        aria-orientation="horizontal"
        aria-label={text}
        className={join("flex w-full items-center gap-3", className)}
      >
        <span className="h-px flex-1 bg-border-default" />
        <span className="text-small text-text-secondary">{text}</span>
        <span className="h-px flex-1 bg-border-default" />
      </div>
    );
  }

  return (
    <hr
      {...rest}
      ref={ref as Ref<HTMLHRElement>}
      className={join("w-full border-0 border-t border-border-default", className)}
    />
  );
}
