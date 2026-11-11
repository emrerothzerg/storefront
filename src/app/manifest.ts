import type { MetadataRoute } from "next";

import {
  BACKGROUND_COLOR,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_SHORT_NAME,
  THEME_COLOR,
} from "@/lib/seo/site";

/** /manifest.webmanifest. Light only: theme colour = primary, background = white (see site.ts). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_SHORT_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }],
  };
}
