"use client";

import { useState, useSyncExternalStore } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Dialog } from "@/components/atoms/Dialog";
import { IconButton } from "@/components/atoms/IconButton";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import type { ProductImage } from "@/lib/types";

/** Intrinsic size of the main image (1:1 box; CSS sets the rendered size). */
const MAIN_SIZE = 800;
/** Intrinsic size of the lightbox image. */
const LIGHTBOX_SIZE = 1200;
/** Intrinsic size of a thumbnail (rendered inside a 64px white tile). */
const THUMB_SIZE = 64;

/** Default `sizes` for the main image: full width on mobile, half the PDP from md. */
export const IMAGE_GALLERY_SIZES = "(min-width: 768px) 50vw, 100vw";
const LIGHTBOX_SIZES = "(min-width: 768px) 768px, 100vw";

export interface ImageGalleryProps {
  /**
   * Product images in display order. Empty renders a single placeholder tile
   * named after the product; one image renders no thumbnail strip.
   */
  images: readonly ProductImage[];
  /** Used for fallback alt text and the lightbox title. */
  productName: string;
  /**
   * Initially shown image (e.g. parsed from `?img=N` so the no-JS fallback
   * works). Clamped: NaN / negative / non-finite -> 0, >= length -> last.
   */
  initialIndex?: number;
  /**
   * When given, thumbnails render as `<a href>` links in the server / no-JS
   * markup (e.g. `(i) => \`?img=${i}#gallery\``); after hydration they become
   * buttons that switch the image in place.
   */
  hrefForIndex?: (index: number) => string;
  /**
   * Serialisable alternative to `hrefForIndex` for Server Component callers
   * (a function prop cannot cross the RSC boundary). A same-origin path such
   * as `/products/oak-desk`; thumbnail N links to
   * `<basePath>?img=N#<id>` (index 0 omits the param). Any query or fragment
   * on `basePath` is dropped; a value that is not a same-origin path ("",
   * `//host`, `https:`, `javascript:`) is ignored (no links).
   * `hrefForIndex` wins when both are given.
   */
  basePath?: string;
  /** `sizes` for the main image. Defaults to `IMAGE_GALLERY_SIZES`. */
  sizes?: string;
  /** Id of the wrapper (fragment target for `hrefForIndex`). Defaults to "gallery". */
  id?: string;
  className?: string;
}

/** Query parameter `basePath` links use; the PDP parser reads the same name (`?img=N`). */
export const IMAGE_GALLERY_PARAM = "img";

/**
 * `<path>?img=N#<id>` for `basePath` (index 0, negative or non-integer
 * indexes omit the param). Returns null when `basePath` is not a same-origin
 * path, so the caller renders buttons only.
 */
export function galleryHrefForIndex(basePath: unknown, index: number, id: string = "gallery"): string | null {
  if (typeof basePath !== "string") return null;
  const path = (basePath.trim().split(/[?#]/, 1)[0] ?? "").trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\") || /[\s\\]/.test(path)) return null;
  const fragment = id.trim() === "" ? "" : `#${id.trim()}`;
  return Number.isSafeInteger(index) && index > 0 ? `${path}?${IMAGE_GALLERY_PARAM}=${index}${fragment}` : `${path}${fragment}`;
}

/** NaN / negative / non-finite -> 0, >= length -> last; 0 when there are no images. */
export function clampImageIndex(index: number | undefined, length: number): number {
  if (length <= 0) return 0;
  if (typeof index !== "number" || !Number.isFinite(index) || index < 0) return 0;
  const whole = Math.floor(index);
  return whole >= length ? length - 1 : whole;
}

/**
 * Only same-origin paths ("/x", not "//host" or "/\\host") and http(s) URLs
 * pass; anything else (javascript:, data:, empty, whitespace) becomes "" so
 * the Image atom renders its placeholder.
 */
export function safeImageUrl(url: unknown): string {
  if (typeof url !== "string") return "";
  const trimmed = url.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith("/")) {
    return trimmed.startsWith("//") || trimmed.startsWith("/\\") ? "" : trimmed;
  }
  return /^https?:\/\/[^\s/\\]/i.test(trimmed) ? trimmed : "";
}

/** `image.alt` when it has visible text, else "<productName>, image N of M". */
export function galleryImageAlt(
  image: ProductImage | undefined,
  productName: string,
  index: number,
  total: number,
): string {
  const alt = typeof image?.alt === "string" ? image.alt.trim() : "";
  if (alt !== "") return alt;
  const name = productName.trim() === "" ? "Product" : productName.trim();
  return `${name}, image ${index + 1} of ${total}`;
}

/** Accessible name of thumbnail `index` (0-based): "Image N of M". */
export function thumbnailLabel(index: number, total: number): string {
  return `Image ${index + 1} of ${total}`;
}

/** Name of the placeholder tile when there are no images: the product name ("Product" when blank). */
export function galleryPlaceholderAlt(productName: string): string {
  const name = typeof productName === "string" ? productName.trim() : "";
  return name === "" ? "Product" : name;
}

const noopSubscribe = () => () => {};

/** false during SSR and hydration, true afterwards. */
function useIsHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

// White 64px tiles (>= 44px target); the selected one gets the accent border.
const thumbBase =
  "relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border-2 bg-surface-raised p-0";
const thumbActive = "border-accent shadow-sm";
const thumbIdle = "border-border-default hover:border-border-strong";

/** Keys that move focus along the strip (horizontal below md, vertical from md). */
const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

/**
 * Product image gallery (v3): a large main image on a white 1:1 tile (fixed
 * aspect box, no layout shift), a thumbnail strip that is horizontal below
 * 768px and a vertical column left of the main image from `md` (roving
 * tabindex; Arrow keys, Home, End move focus, Enter/Space activate) and a
 * full-screen lightbox on the Dialog atom. Without JS the thumbnails are
 * plain links (`hrefForIndex`, or `basePath` from a Server Component) and the
 * zoom button is absent. DOM order stays main image first, strip second.
 */
export function ImageGallery({
  images,
  productName,
  initialIndex,
  hrefForIndex,
  basePath,
  sizes = IMAGE_GALLERY_SIZES,
  id = "gallery",
  className,
}: ImageGalleryProps) {
  const total = images.length;
  const hydrated = useIsHydrated();
  const [activeIndex, setActiveIndex] = useState(() => clampImageIndex(initialIndex, total));
  const [focusIndex, setFocusIndex] = useState(() => clampImageIndex(initialIndex, total));
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Images can shrink between renders; never index past the end.
  const active = clampImageIndex(activeIndex, total);
  const focused = clampImageIndex(focusIndex, total);
  const current = images[active];
  const mainAlt =
    total === 0
      ? galleryPlaceholderAlt(productName)
      : galleryImageAlt(current, productName, active, total);
  // Below md: column (main, then strip). From md: row-reversed so the strip
  // sits left of the main image while the DOM keeps the main image first.
  const wrapperClasses = [
    "flex w-full min-w-0 flex-col gap-3 md:flex-row-reverse md:items-start md:justify-end md:gap-4",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const linkFor: ((index: number) => string) | null = hrefForIndex
    ? hrefForIndex
    : basePath !== undefined && galleryHrefForIndex(basePath, 0, id) !== null
      ? (index: number) => galleryHrefForIndex(basePath, index, id) ?? ""
      : null;

  const select = (index: number) => {
    setActiveIndex(index);
    setFocusIndex(index);
  };

  const step = (delta: number) => {
    if (total < 2) return;
    select((active + delta + total) % total);
  };

  const handleStripKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!hydrated || total < 2) return;
    let next: number | null = null;
    if (NEXT_KEYS.has(event.key)) next = (focused + 1) % total;
    else if (PREV_KEYS.has(event.key)) next = (focused - 1 + total) % total;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = total - 1;
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    const target = event.currentTarget.querySelector<HTMLElement>(
      `[data-thumb-index="${next}"]`,
    );
    target?.focus();
  };

  const handleLightboxKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    }
  };

  const titleText = productName.trim() === "" ? "Product images" : productName.trim();

  return (
    <div id={id} className={wrapperClasses}>
      <Card
        padding="none"
        elevation="none"
        data-gallery-main=""
        className="aspect-square w-full max-w-2xl overflow-hidden p-2 md:flex-1 md:p-4"
      >
        <Image
          src={safeImageUrl(current?.url)}
          alt={mainAlt}
          width={MAIN_SIZE}
          height={MAIN_SIZE}
          sizes={sizes}
          priority
          className="block size-full object-contain"
        />
        {hydrated && total > 0 ? (
          <IconButton
            icon="zoom-in"
            label="Open image in full screen"
            variant="outline"
            onClick={() => setLightboxOpen(true)}
            className="absolute end-2 top-2 z-raised"
          />
        ) : null}
      </Card>

      {total > 1 ? (
        // From md the column is as tall as the main tile (the list is taken
        // out of flow) and scrolls vertically inside itself.
        <div
          data-gallery-strip=""
          className="relative w-full max-w-2xl min-w-0 md:w-20 md:shrink-0 md:self-stretch"
        >
          <ul
            role="list"
            aria-label="Product image thumbnails"
            onKeyDown={handleStripKeyDown}
            className="flex w-full list-none gap-2 overflow-x-auto p-1 md:absolute md:inset-0 md:flex-col md:overflow-x-hidden md:overflow-y-auto"
          >
            {images.map((image, index) => {
              const isActive = index === active;
              const classes = [thumbBase, isActive ? thumbActive : thumbIdle].join(" ");
              const content = (
                <>
                  <Image
                    src={safeImageUrl(image.url)}
                    alt=""
                    width={THUMB_SIZE}
                    height={THUMB_SIZE}
                    className="block size-full object-contain p-1"
                  />
                  <VisuallyHidden>{thumbnailLabel(index, total)}</VisuallyHidden>
                </>
              );
              const key = `${index}:${image.url}`;

              if (!hydrated && linkFor) {
                // No-JS path: a real navigation to ?img=N handled by the page.
                return (
                  <li key={key} className="shrink-0">
                    <Link
                      href={linkFor(index)}
                      variant="subtle"
                      isCurrent={isActive}
                      scroll={false}
                      className={classes}
                    >
                      {content}
                    </Link>
                  </li>
                );
              }

              return (
                <li key={key} className="shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    padding="none"
                    data-thumb-index={index}
                    aria-current={isActive ? "true" : undefined}
                    tabIndex={hydrated ? (index === focused ? 0 : -1) : undefined}
                    onFocus={() => setFocusIndex(index)}
                    onClick={(event: MouseEvent<HTMLButtonElement>) => {
                      event.preventDefault();
                      select(index);
                    }}
                    className={classes}
                  >
                    {content}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {hydrated && total > 0 ? (
        <Dialog
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          title={titleText}
          size="lg"
          closeLabel="Close full screen image"
          onKeyDown={handleLightboxKeyDown}
        >
          <div className="flex flex-col items-center gap-3">
            {lightboxOpen ? (
              <div className="aspect-square w-full overflow-hidden rounded-lg bg-surface-raised">
                <Image
                  src={safeImageUrl(current?.url)}
                  alt={mainAlt}
                  width={LIGHTBOX_SIZE}
                  height={LIGHTBOX_SIZE}
                  sizes={LIGHTBOX_SIZES}
                  className="block size-full object-contain"
                />
              </div>
            ) : null}
            {total > 1 ? (
              <div className="flex items-center gap-4">
                <IconButton
                  icon="chevron-left"
                  label="Previous image"
                  variant="outline"
                  onClick={() => step(-1)}
                />
                <p aria-live="polite" className="text-small text-text-secondary">
                  Image {active + 1} of {total}
                </p>
                <IconButton
                  icon="chevron-right"
                  label="Next image"
                  variant="outline"
                  onClick={() => step(1)}
                />
              </div>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
