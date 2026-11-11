/**
 * Placeholder SVGs for seed products (pure functions; seed-cli writes them).
 *
 * - Primary image: `renderPlaceholderSvg` (unchanged MVP design).
 * - Gallery views: `renderVariantSvg` draws a different composition per view
 *   so the PDP gallery has visibly distinct thumbnails.
 */

export interface PlaceholderInput {
  readonly name: string;
  /** Background colour (hex). */
  readonly color: string;
}

export type GalleryView = "side" | "detail" | "back";

export const GALLERY_VIEWS: readonly GalleryView[] = ["side", "detail", "back"];

export const GALLERY_VIEW_LABELS: Readonly<Record<GalleryView, string>> = {
  side: "Side view",
  detail: "Detail",
  back: "Back view",
};

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

/** 600x600 placeholder: solid colour plus the product name in white. */
export function renderPlaceholderSvg(product: PlaceholderInput): string {
  const name = escapeXml(product.name);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600" role="img" aria-labelledby="title">
  <title id="title">${name}</title>
  <rect width="600" height="600" fill="${product.color}"/>
  <rect x="40" y="40" width="520" height="520" rx="24" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="4"/>
  <text x="300" y="300" fill="#ffffff" font-family="${FONT}" font-size="36" font-weight="600" text-anchor="middle" dominant-baseline="middle">${name}</text>
</svg>
`;
}

function composition(view: GalleryView): string {
  switch (view) {
    case "side":
      return `<ellipse cx="300" cy="270" rx="170" ry="120" fill="#ffffff" fill-opacity="0.18"/>
  <rect x="150" y="390" width="300" height="12" rx="6" fill="#000000" fill-opacity="0.2"/>`;
    case "detail":
      return `<circle cx="300" cy="260" r="150" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="10"/>
  <circle cx="300" cy="260" r="90" fill="#ffffff" fill-opacity="0.15"/>
  <line x1="406" y1="366" x2="500" y2="460" stroke="#ffffff" stroke-opacity="0.5" stroke-width="14" stroke-linecap="round"/>`;
    case "back":
      return `<rect x="170" y="130" width="260" height="260" rx="20" fill="#000000" fill-opacity="0.18"/>
  <rect x="200" y="160" width="200" height="200" rx="12" fill="#ffffff" fill-opacity="0.12"/>`;
  }
}

/** 600x600 gallery view: a view-specific composition, the product name and the view label. */
export function renderVariantSvg(product: PlaceholderInput, view: GalleryView): string {
  const name = escapeXml(product.name);
  const label = escapeXml(GALLERY_VIEW_LABELS[view]);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600" role="img" aria-labelledby="title">
  <title id="title">${name}, ${label}</title>
  <rect width="600" height="600" fill="${product.color}"/>
  ${composition(view)}
  <text x="300" y="490" fill="#ffffff" font-family="${FONT}" font-size="30" font-weight="600" text-anchor="middle">${name}</text>
  <text x="300" y="535" fill="#ffffff" fill-opacity="0.8" font-family="${FONT}" font-size="22" text-anchor="middle">${label}</text>
</svg>
`;
}
