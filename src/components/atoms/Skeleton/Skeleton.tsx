import type { ComponentPropsWithRef } from "react";

export type SkeletonVariant = "text" | "rect" | "circle";
/** Width of `text` lines and `rect` blocks, as a fraction of the container. */
export type SkeletonWidth = "full" | "3/4" | "2/3" | "1/2" | "1/3" | "1/4";
/** Height of a `rect` block. `square` keeps a 1:1 aspect ratio (image placeholders). */
export type SkeletonHeight = "xs" | "sm" | "md" | "lg" | "xl" | "square";
/** Diameter of a `circle` (avatars). */
export type SkeletonSize = "sm" | "md" | "lg";
/** Upper bound for `lines` so hostile input (Infinity, 1e9) can't blow up rendering. */
export const SKELETON_MAX_LINES = 20;

/** Line height of `text` lines, matching the type scale. */
export type SkeletonTextSize = "caption" | "small" | "body" | "heading";

export interface SkeletonProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
  /** Shape. Defaults to "text". */
  variant?: SkeletonVariant;
  /** `text` only: number of lines, clamped to [1, 20] (NaN -> 1). With more than one line the last is 2/3 wide. Defaults to 1. */
  lines?: number;
  /** `text` only: matches the line box of the text it stands in for. Defaults to "body". */
  textSize?: SkeletonTextSize;
  /** `text` and `rect`: width. Defaults to "full". */
  width?: SkeletonWidth;
  /** `rect` only: height. Defaults to "md". */
  height?: SkeletonHeight;
  /** `circle` only: diameter. Defaults to "md". */
  size?: SkeletonSize;
}

const widthClasses: Record<SkeletonWidth, string> = {
  full: "w-full",
  "3/4": "w-3/4",
  "2/3": "w-2/3",
  "1/2": "w-1/2",
  "1/3": "w-1/3",
  "1/4": "w-1/4",
};

const heightClasses: Record<SkeletonHeight, string> = {
  xs: "h-4",
  sm: "h-8",
  md: "h-16",
  lg: "h-32",
  xl: "h-48",
  square: "aspect-square",
};

const sizeClasses: Record<SkeletonSize, string> = {
  sm: "size-8",
  md: "size-12",
  lg: "size-16",
};

// The bar is shorter than the line box (the gap mimics leading).
const textLineClasses: Record<SkeletonTextSize, string> = {
  caption: "h-3 my-0.5",
  small: "h-3.5 my-0.5",
  body: "h-4 my-1",
  heading: "h-6 my-1",
};

// Decorative fill: the skeleton token is visible on page/raised/sunken
// (light mode only). Pulse only when motion is allowed (the globals.css base layer also
// neutralises animation under prefers-reduced-motion).
const fill = "bg-skeleton motion-safe:animate-pulse";

/**
 * Loading placeholder. Purely decorative (`aria-hidden`): announce loading on
 * the container instead (e.g. `aria-busy="true"` plus a Spinner or visually
 * hidden "Loading" text). Server-component safe.
 */
export function Skeleton({
  variant = "text",
  lines = 1,
  textSize = "body",
  width = "full",
  height = "md",
  size = "md",
  className,
  ref,
  ...rest
}: SkeletonProps) {
  if (variant === "text") {
    const count = Number.isNaN(lines)
      ? 1
      : Math.min(SKELETON_MAX_LINES, Math.max(1, Math.floor(lines)));
    const classes = ["flex flex-col", widthClasses[width], className].filter(Boolean).join(" ");
    return (
      <div {...rest} ref={ref} aria-hidden="true" data-variant="text" className={classes}>
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            data-skeleton-line=""
            className={[
              "block rounded-sm",
              fill,
              textLineClasses[textSize],
              count > 1 && i === count - 1 ? "w-2/3" : "w-full",
            ].join(" ")}
          />
        ))}
      </div>
    );
  }

  const shape =
    variant === "circle"
      ? ["rounded-full shrink-0", sizeClasses[size]]
      : ["rounded-md", widthClasses[width], heightClasses[height]];
  const classes = ["block", fill, ...shape, className].filter(Boolean).join(" ");
  return <div {...rest} ref={ref} aria-hidden="true" data-variant={variant} className={classes} />;
}
