// Shared by the StoreBadge and PaymentMark tests (T132 AC2). The forbidden
// store and payment trademarks are assembled at runtime from split pieces so
// this file never contains them itself.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PIECES: ReadonlyArray<readonly string[]> = [
  ["App", " ", "Store"],
  ["Goo", "gle", " ", "Play"],
  ["Vi", "sa"],
  ["Master", "card"],
  ["Pay", "Pal"],
  ["After", "pay"],
  ["Zi", "p"],
];

export const TRADEMARK_TERMS: readonly string[] = PIECES.map((p) => p.join(""));

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive, whole words; spaces inside a term match any whitespace. */
export const TRADEMARK_RE = new RegExp(
  `\\b(?:${TRADEMARK_TERMS.map((t) => escape(t).replace(/ /g, "\\s*")).join("|")})\\b`,
  "i",
);

export interface TrademarkHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Scans every file directly inside the given folders. */
export function scanFolders(dirs: readonly string[]): { files: number; hits: TrademarkHit[] } {
  const hits: TrademarkHit[] = [];
  let files = 0;
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!statSync(path).isFile()) continue;
      files += 1;
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((text, i) => {
          if (TRADEMARK_RE.test(text)) hits.push({ file: name, line: i + 1, text: text.trim() });
        });
    }
  }
  return { files, hits };
}
