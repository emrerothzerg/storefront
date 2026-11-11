import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cache Components / PPR are deliberately OFF: every page is dynamic SSR per
  // request so initial responses carry real HTTP semantics (404 from notFound(),
  // 3xx from redirect(), 500 from thrown errors) and content is visible without JS.
  // `partialPrefetching` requires cacheComponents, so it is removed too.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
