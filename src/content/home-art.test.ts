import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_HOME_ART,
  BEAUTY_PROMO_ART,
  DELIVERY_PROMO_ART,
  DEPARTMENT_TILE_ART,
  DISCOVERY_TILE_ART,
  FALLBACK_TILE_ART,
  HERO_PANEL_ART,
  HERO_SLIDE_ART,
  HOME_ART_DIR,
  LIFESTYLE_ART,
  LIFESTYLE_ART_KEYS,
  LIFESTYLE_THREE_COLUMN_KEYS,
  ACCOUNT_PROMO_ART,
  BEST_SELLERS_PROMO_ART,
  DEALS_PROMO_ART,
  getCategoryTileArt,
  getDepartmentTileArt,
  getDiscoveryTileArt,
} from "./home-art";
import { DEPARTMENT_NAV } from "./navigation";

const ROOT = join(import.meta.dir, "..", "..");
const PUBLIC_DIR = join(ROOT, "public");
const ART_DIR = join(PUBLIC_DIR, HOME_ART_DIR);
const MAX_BYTES = 40 * 1024;

const filePath = (urlPath: string): string => join(PUBLIC_DIR, urlPath);
const read = (urlPath: string): string => readFileSync(filePath(urlPath), "utf8");

/** Raw colour values declared as custom properties in globals.css (`--name: <hash>hex;`). */
function paletteValues(): Set<string> {
  const css = readFileSync(join(ROOT, "src", "app", "globals.css"), "utf8");
  const values = new Set<string>();
  for (const match of css.matchAll(/--[a-z0-9-]+:\s*(#[0-9a-f]{3,8})\s*;/gi)) {
    const value = match[1];
    if (value) values.add(value.toLowerCase());
  }
  return values;
}

/** Every colour used by fill/stroke/stop-color/flood-color/color attributes. */
function colourValues(source: string): string[] {
  return [...source.matchAll(/\b(?:fill|stroke|stop-color|flood-color|lighting-color|color)="([^"]*)"/g)].map(
    (match) => (match[1] ?? "").toLowerCase(),
  );
}

describe("home art manifest", () => {
  test("has the required set", () => {
    expect(HERO_SLIDE_ART.length).toBeGreaterThanOrEqual(3);
    expect(HERO_PANEL_ART.path).toBeTruthy();
    expect(DELIVERY_PROMO_ART.path).toBeTruthy();
    expect(BEAUTY_PROMO_ART.path).toBeTruthy();
    expect(LIFESTYLE_ART_KEYS.length).toBeGreaterThanOrEqual(4);
    expect(LIFESTYLE_THREE_COLUMN_KEYS).toHaveLength(3);
    for (const key of LIFESTYLE_THREE_COLUMN_KEYS) expect(LIFESTYLE_ART_KEYS).toContain(key);
    const categoryTiles = Object.keys(DEPARTMENT_TILE_ART).length + DISCOVERY_TILE_ART.length;
    expect(categoryTiles).toBeGreaterThanOrEqual(12);
    expect(FALLBACK_TILE_ART.path).toBeTruthy();
  });

  test("paths are unique, live under the home art dir and have alt text and a positive size", () => {
    const paths = ALL_HOME_ART.map((image) => image.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const image of ALL_HOME_ART) {
      expect(image.path).toMatch(/^\/images\/home\/[a-z0-9-]+\.svg$/);
      expect(image.alt.trim().length).toBeGreaterThan(0);
      expect(image.alt).toBe(image.alt.trim());
      expect(image.alt).not.toMatch(/[<>]/);
      expect(Number.isInteger(image.width) && image.width > 0).toBe(true);
      expect(Number.isInteger(image.height) && image.height > 0).toBe(true);
    }
  });

  test("every department slug has a tile, and lookups fall back safely", () => {
    for (const { slug } of DEPARTMENT_NAV) {
      expect(Object.hasOwn(DEPARTMENT_TILE_ART, slug), slug).toBe(true);
      expect(getDepartmentTileArt(slug)).toBe(DEPARTMENT_TILE_ART[slug] ?? FALLBACK_TILE_ART);
      expect(getDepartmentTileArt(slug)).not.toBe(FALLBACK_TILE_ART);
    }
    for (const slug of ["", "unknown-department", "__proto__", "constructor", "toString", "Books"]) {
      expect(getDepartmentTileArt(slug)).toBe(FALLBACK_TILE_ART);
    }
  });

  test("discovery tiles cycle by position and fall back on invalid positions", () => {
    expect(getDiscoveryTileArt(0)).toBe(DISCOVERY_TILE_ART[0] ?? FALLBACK_TILE_ART);
    expect(getDiscoveryTileArt(DISCOVERY_TILE_ART.length)).toBe(DISCOVERY_TILE_ART[0] ?? FALLBACK_TILE_ART);
    expect(getDiscoveryTileArt(5)).toBe(DISCOVERY_TILE_ART[5 % DISCOVERY_TILE_ART.length] ?? FALLBACK_TILE_ART);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(getDiscoveryTileArt(bad)).toBe(FALLBACK_TILE_ART);
    }
  });

  test("category tile art: department art for departments, a stable discovery tile for leaves, fallback for blanks", () => {
    for (const { slug } of DEPARTMENT_NAV) expect(getCategoryTileArt(slug)).toBe(getDepartmentTileArt(slug));
    for (const slug of ["cookware-dining", "coffee-tea", "decor-textiles", "__proto__", "constructor"]) {
      const first = getCategoryTileArt(slug);
      expect(DISCOVERY_TILE_ART).toContain(first);
      expect(getCategoryTileArt(slug)).toBe(first);
      expect(getCategoryTileArt(` ${slug} `)).toBe(first);
    }
    const spread = new Set(["cookware-dining", "coffee-tea", "decor-textiles", "audio", "laptops", "fiction", "outerwear", "camping"].map(getCategoryTileArt));
    expect(spread.size).toBeGreaterThan(1);
    for (const bad of ["", "   ", null, undefined, 7] as unknown as string[]) expect(getCategoryTileArt(bad)).toBe(FALLBACK_TILE_ART);
  });

  test("hero art is 4:3 so it crops well both as the right half (md+) and as a 16:9 mobile block (T178)", () => {
    for (const slide of HERO_SLIDE_ART) expect(slide.width / slide.height).toBeCloseTo(4 / 3, 5);
  });

  test("listing promo art: one 8:5 image per tile, same size as the delivery art", () => {
    for (const image of [DEALS_PROMO_ART, BEST_SELLERS_PROMO_ART, ACCOUNT_PROMO_ART]) {
      expect(`${image.width}x${image.height}`).toBe(`${DELIVERY_PROMO_ART.width}x${DELIVERY_PROMO_ART.height}`);
      expect(ALL_HOME_ART).toContain(image);
    }
  });

  test("hero slides share one size; lifestyle cards share one size", () => {
    const heroSizes = new Set(HERO_SLIDE_ART.map((slide) => `${slide.width}x${slide.height}`));
    expect(heroSizes.size).toBe(1);
    const sizes = new Set(LIFESTYLE_ART_KEYS.map((key) => `${LIFESTYLE_ART[key].width}x${LIFESTYLE_ART[key].height}`));
    expect(sizes.size).toBe(1);
  });
});

describe("home art files", () => {
  const palette = paletteValues();

  test("globals.css exposes a palette to check against", () => {
    expect(palette.size).toBeGreaterThan(10);
  });

  test("every manifest file exists, is an SVG under 40 KB", () => {
    for (const image of ALL_HOME_ART) {
      expect(existsSync(filePath(image.path)), image.path).toBe(true);
      expect(statSync(filePath(image.path)).size, image.path).toBeLessThan(MAX_BYTES);
      expect(read(image.path).trimStart().startsWith("<svg"), image.path).toBe(true);
    }
  });

  test("every file in the directory is in the manifest (no orphans)", () => {
    const listed = new Set(ALL_HOME_ART.map((image) => image.path));
    for (const file of readdirSync(ART_DIR)) expect(listed.has(`${HOME_ART_DIR}/${file}`), file).toBe(true);
  });

  test("viewBox and width/height match the manifest", () => {
    for (const image of ALL_HOME_ART) {
      const source = read(image.path);
      const root = /<svg\b[^>]*>/.exec(source)?.[0] ?? "";
      expect(root, image.path).toContain(`viewBox="0 0 ${image.width} ${image.height}"`);
      expect(root, image.path).toContain(`width="${image.width}"`);
      expect(root, image.path).toContain(`height="${image.height}"`);
    }
  });

  test("no scripts, event handlers, external references, embedded media or styles", () => {
    for (const image of ALL_HOME_ART) {
      const source = read(image.path);
      expect(source, image.path).not.toMatch(/<script/i);
      expect(source, image.path).not.toMatch(/\son[a-z]+\s*=/i);
      expect(source, image.path).not.toMatch(/javascript:/i);
      expect(source, image.path).not.toMatch(/<(image|foreignObject|use|style|iframe|a)\b/i);
      expect(source, image.path).not.toMatch(/\sstyle\s*=/i);
      expect(source, image.path).not.toMatch(/url\(\s*['"]?(?!#)/i);
      // Any href (plain or xlink) may only point inside the same document.
      for (const match of source.matchAll(/href\s*=\s*"([^"]*)"/gi)) {
        expect(match[1] ?? "", image.path).toMatch(/^#/);
      }
      // The only URL allowed is the SVG namespace declaration.
      const urls = [...source.matchAll(/https?:\/\/[^"'\s)]+/gi)].map((match) => match[0]);
      for (const url of urls) expect(url, image.path).toBe("http://www.w3.org/2000/svg");
    }
  });

  test("no text inside the art (copy lives in HTML)", () => {
    for (const image of ALL_HOME_ART) {
      expect(read(image.path), image.path).not.toMatch(/<(text|tspan|textPath|title|desc)\b/i);
    }
  });

  test("colours are only the palette's raw values from globals.css", () => {
    for (const image of ALL_HOME_ART) {
      const source = read(image.path);
      expect(source, image.path).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|color-mix)\(/i);
      for (const value of colourValues(source)) {
        if (value === "none" || value.startsWith("url(#")) continue;
        expect(palette.has(value), `${image.path}: ${value}`).toBe(true);
      }
      // Hex values anywhere else in the file (e.g. inside attributes we did not list) must also be palette values.
      for (const match of source.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
        expect(palette.has(match[0].toLowerCase()), `${image.path}: ${match[0]}`).toBe(true);
      }
    }
  });
});
