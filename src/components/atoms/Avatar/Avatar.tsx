"use client";

import { useState } from "react";
import type { HTMLAttributes, Ref } from "react";
import { Image } from "../Image";

export type AvatarSize = "sm" | "md" | "lg";

export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children" | "role"> {
  /** Person's name: accessible name, initials and background colour all derive from it. */
  name: string;
  /** Photo URL. Missing, blank or failing images fall back to initials. */
  src?: string | null;
  /** 32 / 40 / 56px. Defaults to "md". */
  size?: AvatarSize;
  /**
   * Hide from assistive tech when the name is already shown next to the
   * avatar (avoids "Jane Doe, Jane Doe"). Defaults to false.
   */
  decorative?: boolean;
  ref?: Ref<HTMLSpanElement>;
}

const sizeClasses: Record<AvatarSize, string> = {
  sm: "size-8 text-caption",
  md: "size-10 text-small",
  lg: "size-14 text-h4",
};
const sizePx: Record<AvatarSize, number> = { sm: 32, md: 40, lg: 56 };

/** Tints with a verified text-primary pair (globals.css header). */
export const AVATAR_TONES = [
  "bg-accent-subtle",
  "bg-info-subtle",
  "bg-success-subtle",
  "bg-warning-subtle",
] as const;

/** First user-perceived character (grapheme); code-point fallback without Intl.Segmenter. */
function firstGrapheme(word: string): string {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const first = new Intl.Segmenter("en", { granularity: "grapheme" }).segment(word)[Symbol.iterator]().next();
    return first.done ? "" : first.value.segment;
  }
  return Array.from(word)[0] ?? "";
}

/** Up to two initials: first graphemes of the first and last words ("?" when empty). */
export function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const firstWord = words[0] ?? "";
  const lastWord = words.length > 1 ? (words[words.length - 1] ?? "") : "";
  const first = firstGrapheme(firstWord);
  const last = firstGrapheme(lastWord);
  return (first + last).toLocaleUpperCase("en-US");
}

/** Deterministic tone class for a name (djb2 hash, case-insensitive). */
export function avatarTone(name: string): (typeof AVATAR_TONES)[number] {
  let hash = 5381;
  for (const ch of name.trim().toLowerCase()) {
    hash = ((hash << 5) + hash + (ch.codePointAt(0) ?? 0)) | 0;
  }
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length] ?? AVATAR_TONES[0];
}

/**
 * Round avatar: photo when `src` loads, otherwise initials on a tint picked
 * from the name. The root is `role="img"` named by `name` (or hidden when
 * `decorative`); the inner image and initials are hidden from assistive tech.
 */
export function Avatar({
  name,
  src,
  size = "md",
  decorative = false,
  className,
  ref,
  ...rest
}: AvatarProps) {
  const trimmedSrc = typeof src === "string" ? src.trim() : "";
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = trimmedSrc !== "" && failedSrc !== trimmedSrc;
  const label = name.trim();

  const a11y = decorative
    ? { "aria-hidden": true as const }
    : { role: "img" as const, "aria-label": label || "User" };

  const classes = [
    "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold text-text-primary",
    sizeClasses[size],
    showImage ? "bg-surface-sunken" : avatarTone(label),
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span {...rest} {...a11y} ref={ref} className={classes}>
      {showImage ? (
        <Image
          src={trimmedSrc}
          alt=""
          width={sizePx[size]}
          height={sizePx[size]}
          className="size-full object-cover"
          onError={() => setFailedSrc(trimmedSrc)}
        />
      ) : (
        <span aria-hidden="true">{getInitials(label)}</span>
      )}
    </span>
  );
}
