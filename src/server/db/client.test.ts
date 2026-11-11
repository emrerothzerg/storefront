import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabase,
  createDatabase,
  DEFAULT_DATABASE_PATH,
  getDatabase,
  resolveDatabasePath,
  withTransaction,
} from "./client";
import { runMigrations } from "./schema";

describe("resolveDatabasePath", () => {
  test("defaults to ./data/storefront.sqlite", () => {
    expect(DEFAULT_DATABASE_PATH).toBe("./data/storefront.sqlite");
    expect(resolveDatabasePath({})).toBe("./data/storefront.sqlite");
    expect(resolveDatabasePath({ DATABASE_PATH: "" })).toBe("./data/storefront.sqlite");
  });

  test("DATABASE_PATH overrides the default", () => {
    expect(resolveDatabasePath({ DATABASE_PATH: "/tmp/x.sqlite" })).toBe("/tmp/x.sqlite");
  });

  test("trims the env value; whitespace-only falls back to the default", () => {
    expect(resolveDatabasePath({ DATABASE_PATH: "  /tmp/x.sqlite\n" })).toBe("/tmp/x.sqlite");
    expect(resolveDatabasePath({ DATABASE_PATH: " \t " })).toBe("./data/storefront.sqlite");
  });
});

describe("createDatabase", () => {
  test("enables foreign keys and a busy timeout on :memory:", () => {
    const db = createDatabase(":memory:");
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBeGreaterThan(0);
    db.close();
  });
});

describe("getDatabase", () => {
  const original = process.env.DATABASE_PATH;
  afterEach(() => {
    closeDatabase();
    if (original === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = original;
  });

  test("honours DATABASE_PATH, migrates on first open and caches the handle", () => {
    process.env.DATABASE_PATH = ":memory:";
    const db = getDatabase();
    expect(getDatabase()).toBe(db);
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'products'")
      .all();
    expect(tables).toHaveLength(1);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
  });
});

describe("withTransaction", () => {
  function setup() {
    const db = createDatabase(":memory:");
    runMigrations(db);
    return db;
  }
  const insert = "INSERT INTO carts (session_id) VALUES (?)";
  const count = (db: ReturnType<typeof setup>) =>
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM carts").get()?.n;

  test("commits and returns the callback value", () => {
    const db = setup();
    const value = withTransaction(db, (tx) => {
      tx.query(insert).run("s1");
      return 42;
    });
    expect(value).toBe(42);
    expect(count(db)).toBe(1);
  });

  test("rolls back every write when the callback throws, and rethrows", () => {
    const db = setup();
    expect(() =>
      withTransaction(db, (tx) => {
        tx.query(insert).run("s1");
        tx.query(insert).run("s2");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(count(db)).toBe(0);
  });

  test("rolls back when a constraint fails mid-transaction", () => {
    const db = setup();
    expect(() =>
      withTransaction(db, (tx) => {
        tx.query(insert).run("s1");
        tx.query(insert).run("s1"); // duplicate PK
      }),
    ).toThrow();
    expect(count(db)).toBe(0);
  });

  test("nested transactions roll back only the inner savepoint", () => {
    const db = setup();
    withTransaction(db, (tx) => {
      tx.query(insert).run("outer");
      try {
        withTransaction(tx, (inner) => {
          inner.query(insert).run("inner");
          throw new Error("inner fails");
        });
      } catch {
        // expected
      }
    });
    expect(db.query<{ session_id: string }, []>("SELECT session_id FROM carts").all()).toEqual([
      { session_id: "outer" },
    ]);
  });

  test("rejects an async callback with TypeError and rolls back its synchronous writes", async () => {
    const db = setup();
    expect(() =>
      withTransaction(db, async (tx) => {
        tx.query(insert).run("before-await");
        await Promise.resolve();
        throw new Error("after await");
      }),
    ).toThrow(new TypeError("withTransaction callback must be synchronous"));
    // Let the orphaned promise settle: it must not surface as an unhandled rejection.
    await Bun.sleep(0);
    expect(count(db)).toBe(0);
  });

  test("rejects a callback that returns a thenable", () => {
    const db = setup();
    expect(() =>
      withTransaction(db, (tx) => {
        tx.query(insert).run("s1");
        return Promise.resolve(1);
      }),
    ).toThrow(TypeError);
    expect(count(db)).toBe(0);
  });
});

describe("withTransaction on a file database (BEGIN IMMEDIATE)", () => {
  const clientPath = join(import.meta.dir, "client.ts");

  test("a second process waits for the write lock and does not lose an update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "storefront-tx-"));
    const file = join(dir, "tx.sqlite");
    const holder = createDatabase(file);
    try {
      holder.run("CREATE TABLE counter (n INTEGER NOT NULL)");
      holder.run("INSERT INTO counter (n) VALUES (0)");

      // Holder takes the write lock and reads n, like a read-then-write service.
      holder.run("BEGIN IMMEDIATE");
      const seen = holder.query<{ n: number }, []>("SELECT n FROM counter").get()?.n ?? -1;

      // Child: read-then-write increment inside withTransaction on its own connection.
      const childCode = `
        import { createDatabase, withTransaction } from ${JSON.stringify(clientPath)};
        const db = createDatabase(${JSON.stringify(file)});
        console.log("ready");
        const started = Date.now();
        withTransaction(db, (tx) => {
          const n = tx.query("SELECT n FROM counter").get().n;
          tx.query("UPDATE counter SET n = ?").run(n + 1);
        });
        console.log(JSON.stringify({ waitedMs: Date.now() - started }));
        db.close();
      `;
      const child = Bun.spawn(["bun", "-e", childCode], { stdout: "pipe", stderr: "pipe" });

      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let out = "";
      while (!out.includes("ready")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        out += decoder.decode(chunk.value);
      }
      expect(out).toContain("ready");

      // Hold the lock well past the child's BEGIN, then write and commit.
      await Bun.sleep(300);
      holder.query("UPDATE counter SET n = ?").run(seen + 1);
      holder.run("COMMIT");

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        out += decoder.decode(chunk.value);
      }
      const exitCode = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });

      const match = /\{"waitedMs":(\d+)\}/.exec(out);
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBeGreaterThanOrEqual(200);
      // Both increments applied: the child's read happened after the holder's commit.
      expect(holder.query<{ n: number }, []>("SELECT n FROM counter").get()?.n).toBe(2);
    } finally {
      holder.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
