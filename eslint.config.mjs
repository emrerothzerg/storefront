import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Test fixtures use raw <a href="/route"> on purpose (atoms are framework-agnostic);
  // the rule started firing once real app routes with the same paths existed.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "tests/**"],
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
]);

export default eslintConfig;
