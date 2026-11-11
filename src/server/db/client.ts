import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "./schema";

/**
 * SQLite connection management (server-only).
 *
 * - `createDatabase(path)` opens a fresh connection with the app's pragmas.
 *   Tests use `createDatabase(":memory:")` and never the on-disk default.
 * - `getDatabase()` is the app-wide lazy singleton, cached on `globalThis`
 *   so Next dev HMR does not open duplicate handles (SPIKE-NOTES finding 1).
 */

export const DEFAULT_DATABASE_PATH = "./data/storefront.sqlite";

/** Milliseconds SQLite waits on a locked database before failing with SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

function isMemoryPath(path: string): boolean {
  return path === ":memory:" || path === "";
}

/** Resolves the database path: `DATABASE_PATH` when set and non-empty, else the default. */
export function resolveDatabasePath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const fromEnv = env.DATABASE_PATH?.trim();
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_DATABASE_PATH;
}

/** Opens a connection with foreign keys on, WAL (file DBs only) and a busy timeout. Does not migrate. */
export function createDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA foreign_keys = ON");
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (!isMemoryPath(path)) {
    db.run("PRAGMA journal_mode = WAL");
  }
  return db;
}

interface DatabaseCache {
  readonly path: string;
  readonly db: Database;
}

const globalForDb = globalThis as typeof globalThis & {
  __storefrontDb?: DatabaseCache;
};

/**
 * Returns the shared app database, opening it (and creating its directory)
 * and running migrations on first use. Path: `DATABASE_PATH ?? ./data/storefront.sqlite`.
 */
export function getDatabase(): Database {
  const path = resolveDatabasePath();
  const cached = globalForDb.__storefrontDb;
  if (cached !== undefined && cached.path === path) {
    return cached.db;
  }
  if (cached !== undefined) {
    cached.db.close();
  }
  if (!isMemoryPath(path)) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = createDatabase(path);
  runMigrations(db);
  globalForDb.__storefrontDb = { path, db };
  return db;
}

/** Closes and forgets the shared database (CLI scripts, test cleanup). Safe to call when none is open. */
export function closeDatabase(): void {
  const cached = globalForDb.__storefrontDb;
  if (cached === undefined) return;
  cached.db.close();
  globalForDb.__storefrontDb = undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Runs `fn` atomically. Commits when it returns, rolls back when it throws
 * (the error is rethrown). Nested calls become savepoints, so services can
 * compose (e.g. T11: decrement stock + insert order in one transaction).
 *
 * The outermost call starts with `BEGIN IMMEDIATE`, taking the write lock up
 * front: another connection or process cannot interleave between a read and
 * a write inside `fn`, and a competing writer waits (up to `busy_timeout`)
 * at BEGIN instead of failing with SQLITE_BUSY mid-transaction.
 *
 * `fn` must be synchronous: bun:sqlite transactions cannot span an `await`.
 * If `fn` returns a thenable, the transaction is rolled back and a
 * `TypeError` is thrown. (Writes an async `fn` makes after its first `await`
 * run outside any transaction and cannot be undone; don't pass one.)
 */
export function withTransaction<T>(db: Database, fn: (db: Database) => T): T {
  return db
    .transaction((inner: Database) => {
      const result = fn(inner);
      if (isThenable(result)) {
        // Swallow the orphaned promise's outcome so it cannot surface as an
        // unhandled rejection; the TypeError below is the reported error.
        Promise.resolve(result).catch(() => undefined);
        throw new TypeError("withTransaction callback must be synchronous");
      }
      return result;
    })
    .immediate(db);
}
