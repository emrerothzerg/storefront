import { useId, type ReactNode, type Ref, type SVGProps } from "react";

/**
 * Every icon name in the set. Other components depend on these exact names;
 * add new ones at the end, never rename or remove.
 */
export const ICON_NAMES = [
  "search",
  "cart",
  "heart",
  "heart-filled",
  "star",
  "star-filled",
  "star-half",
  "chevron-down",
  "chevron-up",
  "chevron-left",
  "chevron-right",
  "close",
  "menu",
  "user",
  "check",
  "check-circle",
  "minus",
  "plus",
  "share",
  "zoom-in",
  "trash",
  "info",
  "warning",
  "error-circle",
  "external-link",
  "filter",
  "sort",
  "list",
  "package",
  "location",
  "truck",
  "lock",
  "copy",
  "print",
  "arrow-up",
  "arrow-right",
  "question-circle",
  "thumbs-up",
  "columns",
  "refresh",
  "clock",
  "tag",
  "gift",
  "home",
  "grid",
  "eye",
  "eye-off",
  "mail",
  "phone",
  "circle",
  "circle-dot",
] as const;

export type IconName = (typeof ICON_NAMES)[number];
export type IconSize = "sm" | "md" | "lg";

export interface IconProps
  extends Omit<SVGProps<SVGSVGElement>, "children" | "role" | "name" | "ref"> {
  name: IconName;
  /** 16px (`sm`), 20px (`md`, default) or 24px (`lg`). */
  size?: IconSize;
  /**
   * Accessible name. When given the icon is exposed as `role="img"` with a
   * `<title>`; when omitted the icon is decorative (`aria-hidden`). Give a
   * title only when the icon carries meaning that no adjacent text conveys.
   */
  title?: string;
  className?: string;
  ref?: Ref<SVGSVGElement>;
}

const sizeClasses: Record<IconSize, string> = {
  sm: "size-4",
  md: "size-5",
  lg: "size-6",
};

/** Shared star outline (symmetric about x = 12). */
const STAR_POINTS =
  "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26";
/** Exact left half of STAR_POINTS: used by `star-half`, no gradient or clipPath id needed. */
const STAR_LEFT_HALF_POINTS = "12 2 8.91 8.26 2 9.27 7 14.14 5.82 21.02 12 17.77";
const HEART_PATH =
  "M12 20s-8-4.9-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.1 12 20 12 20Z";

// All shapes draw on a 24x24 grid. The <svg> sets stroke="currentColor",
// fill="none", width 2 and round caps/joins; filled shapes opt in with
// fill="currentColor". Colour always comes from the surrounding text colour.
const ICONS: Record<IconName, ReactNode> = {
  search: <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM21 21l-4.35-4.35" />,
  cart: (
    <>
      <circle cx="9" cy="20" r="1" />
      <circle cx="18" cy="20" r="1" />
      <path d="M2 3h3l2.4 11.2a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.5L21.5 7H6" />
    </>
  ),
  heart: <path d={HEART_PATH} />,
  "heart-filled": <path d={HEART_PATH} fill="currentColor" />,
  star: <polygon points={STAR_POINTS} />,
  "star-filled": <polygon points={STAR_POINTS} fill="currentColor" />,
  "star-half": (
    <>
      <polygon points={STAR_LEFT_HALF_POINTS} fill="currentColor" />
      <polygon points={STAR_POINTS} />
    </>
  ),
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-up": <path d="m18 15-6-6-6 6" />,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  share: (
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
    </>
  ),
  "zoom-in": (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35M11 8v6M8 11h6" />
    </>
  ),
  trash: (
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
  warning: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  "error-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15 9-6 6M9 9l6 6" />
    </>
  ),
  "external-link": (
    <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  ),
  filter: <path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3Z" />,
  sort: <path d="m3 16 4 4 4-4M7 20V4M21 8l-4-4-4 4M17 4v16" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  package: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
      <path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5" />
    </>
  ),
  location: (
    <>
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  truck: (
    <>
      <path d="M5 18H2V5h12v13H9M14 9h4l4 4v5h-3" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  print: (
    <>
      <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </>
  ),
  "arrow-up": <path d="M12 19V5M5 12l7-7 7 7" />,
  "arrow-right": <path d="M5 12h14M12 5l7 7-7 7" />,
  "question-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
    </>
  ),
  "thumbs-up": (
    <path d="M7 10v11H3V10h4ZM7 10l4-8a3 3 0 0 1 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.1 21H7" />
  ),
  columns: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M12 3v18" />
    </>
  ),
  refresh: (
    <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  tag: (
    <>
      <path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.8 8.8a2 2 0 0 0 2.8 0l7.2-7.2a2 2 0 0 0 0-2.8Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </>
  ),
  gift: (
    <>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M12 8S10.5 3 7.5 3a2.5 2.5 0 0 0 0 5M12 8s1.5-5 4.5-5a2.5 2.5 0 0 1 0 5" />
    </>
  ),
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  "eye-off": (
    <path d="M9.9 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.2 3.2M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.9 9.9 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20" />
  ),
  mail: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 6-10 7L2 6" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="9" />,
  "circle-dot": (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" fill="currentColor" />
    </>
  ),
  phone: (
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" />
  ),
};

/**
 * Inline SVG icon (no external library, no hex: colour is `currentColor`).
 * Server-component safe. Decorative by default (`aria-hidden`); pass `title`
 * to expose it as an image with an accessible name.
 */
export function Icon({ name, size = "md", title, className, ref, ...rest }: IconProps) {
  const titleId = useId();
  const hasTitle = title !== undefined && title.trim() !== "";
  const classes = ["inline-block shrink-0", sizeClasses[size], className].filter(Boolean).join(" ");
  const a11y = hasTitle
    ? { role: "img" as const, "aria-labelledby": titleId }
    : { "aria-hidden": true as const };

  return (
    <svg
      {...rest}
      {...a11y}
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      data-icon={name}
      className={classes}
    >
      {hasTitle ? <title id={titleId}>{title}</title> : null}
      {ICONS[name]}
    </svg>
  );
}
