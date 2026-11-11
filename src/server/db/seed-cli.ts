/**
 * Seeds the app database (DATABASE_PATH or ./data/storefront.sqlite) with the
 * full demo data set: taxonomy, every `SEED_CATALOG` product, reviews, Q&A,
 * coupons and shipping methods. Idempotent: re-running upserts, never duplicates.
 *
 *   bun run seed                                  # seed the database
 *   bun run src/server/db/seed-cli.ts --images    # also (re)write public/images/products/**.svg
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeDatabase, getDatabase, resolveDatabasePath } from "./client";
import { seedDatabase, seedImageFiles } from "./seed";

const PUBLIC_DIR = join(import.meta.dir, "..", "..", "..", "public");
const GALLERY_DIR = join(PUBLIC_DIR, "images", "products", "gallery");

function writeImages(): void {
  const files = seedImageFiles();
  const expected = new Set(files.map((f) => join(PUBLIC_DIR, f.path)));
  for (const file of files) {
    const target = join(PUBLIC_DIR, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.svg);
  }
  // Remove stale gallery SVGs (only inside the generated gallery folder).
  let removed = 0;
  for (const name of readdirSync(GALLERY_DIR)) {
    const full = join(GALLERY_DIR, name);
    if (name.endsWith(".svg") && !expected.has(full)) {
      rmSync(full);
      removed++;
    }
  }
  console.log(`Wrote ${files.length} placeholder images under ${join(PUBLIC_DIR, "images", "products")} (removed ${removed} stale)`);
}

const TABLES = [
  "brands", "categories", "products", "reviews", "review_votes", "questions", "answers",
  "question_votes", "answer_votes", "coupons", "shipping_methods",
] as const;

function main(): void {
  if (process.argv.includes("--images")) writeImages();
  const db = getDatabase();
  try {
    const counts = seedDatabase(db);
    console.log(`Seeded ${resolveDatabasePath()}:`);
    for (const [entity, n] of Object.entries(counts)) console.log(`  ${entity.padEnd(16)} ${n}`);
    console.log("Table totals:");
    for (const table of TABLES) {
      // Table names come from the constant list above, never from input.
      const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
      console.log(`  ${table.padEnd(16)} ${row?.n ?? 0}`);
    }
  } finally {
    closeDatabase();
  }
}

main();
