"use client";

import NextImage from "next/image";
import { useState, type SyntheticEvent } from "react";

interface ImageBaseProps {
  /**
   * Image URL (trimmed). Empty, whitespace-only, null or undefined renders
   * the placeholder.
   */
  src: string | null | undefined;
  /**
   * Required. Describe the image, or pass `""` when it is purely decorative
   * (it is then hidden from assistive tech).
   */
  alt: string;
  /**
   * Above-the-fold / LCP image: loads eagerly with `fetchpriority="high"`
   * instead of the default `loading="lazy"`.
   */
  priority?: boolean;
  /** Passed to next/image; set it whenever the rendered width is responsive. */
  sizes?: string;
  className?: string;
  /** Applies the `rounded-md` radius to the image and placeholder. */
  rounded?: boolean;
  onError?: (event: SyntheticEvent<HTMLImageElement, Event>) => void;
  onLoad?: (event: SyntheticEvent<HTMLImageElement, Event>) => void;
}

interface ImageFixedProps extends ImageBaseProps {
  fill?: false;
  /** Intrinsic width in px (sets the aspect ratio; CSS controls the rendered size). */
  width: number;
  /** Intrinsic height in px. */
  height: number;
}

interface ImageFillProps extends ImageBaseProps {
  /** Fill the nearest positioned ancestor (it must be `relative`/`absolute`). */
  fill: true;
  width?: never;
  height?: never;
}

export type ImageProps = ImageFixedProps | ImageFillProps;

function join(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function PlaceholderIcon({ className }: { className?: string }) {
  return (
    <g className={className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m21 16-5-5-8 8" />
    </g>
  );
}

const iconStroke = {
  fill: "none",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/**
 * Wraps next/image. Lazy-loads by default, requires `alt`, and swaps to a
 * neutral placeholder when `src` is missing or the image fails to load.
 */
export function Image(props: ImageProps) {
  const { src: rawSrc, alt, priority = false, sizes, className, rounded = false, onError, onLoad } =
    props;
  // Whitespace-only or non-string src would make next/image throw; treat as empty.
  const src = typeof rawSrc === "string" ? rawSrc.trim() : "";
  // Remember which src failed so a new src gets a fresh attempt without an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const radius = rounded ? "rounded-md" : undefined;
  const a11y = alt === "" ? { "aria-hidden": true as const } : { "aria-label": alt };

  if (src === "" || failedSrc === src) {
    if (props.fill) {
      return (
        <div
          role="img"
          {...a11y}
          data-placeholder=""
          className={join(
            "absolute inset-0 flex items-center justify-center bg-surface-sunken text-text-secondary",
            radius,
            className,
          )}
        >
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 24 24"
            className="size-6 stroke-current"
            {...iconStroke}
          >
            <PlaceholderIcon />
          </svg>
        </div>
      );
    }

    const { width, height } = props;
    // The SVG carries the intrinsic width/height (and so the aspect ratio),
    // which sizes the wrapper exactly like the <img> it replaces.
    return (
      <div
        role="img"
        {...a11y}
        data-placeholder=""
        className={join(
          "inline-block max-w-full overflow-hidden bg-surface-sunken align-middle text-text-secondary",
          radius,
          className,
        )}
      >
        <svg
          aria-hidden="true"
          focusable="false"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block h-auto max-w-full stroke-current"
          {...iconStroke}
        >
          <g transform={`translate(${width / 2 - 12} ${height / 2 - 12})`}>
            <PlaceholderIcon />
          </g>
        </svg>
      </div>
    );
  }

  const handleError = (event: SyntheticEvent<HTMLImageElement, Event>) => {
    setFailedSrc(src);
    onError?.(event);
  };

  const sizing = props.fill
    ? { fill: true as const }
    : { width: props.width, height: props.height };

  return (
    <NextImage
      src={src}
      alt={alt}
      {...sizing}
      sizes={sizes}
      // Next 16 deprecates `priority`; eager + high fetch priority is the
      // documented replacement for above-the-fold images.
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      className={join(radius, className) || undefined}
      onError={handleError}
      onLoad={onLoad}
    />
  );
}
