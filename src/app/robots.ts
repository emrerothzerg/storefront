import type { MetadataRoute } from "next";

import { ROBOTS_DISALLOW, absoluteUrl } from "@/lib/seo/site";

/**
 * /robots.txt. No DB access; reads only NEXT_PUBLIC_SITE_URL. Disallows the
 * private routes of the policy table (`src/lib/seo/routes.ts`); `/signin` and
 * `/signup` stay crawlable so their noindex is seen. `/_next/`, CSS/JS and
 * images are never blocked (renderers need them).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: [...ROBOTS_DISALLOW] },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
