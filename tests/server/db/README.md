# tests/server/db

QA adversarial tests for T07 (SQLite client, schema, product repository, seed). Owner: qa-engineer. Run with `bun test tests/server/db`.

| File | Covers |
|---|---|
| `helpers.ts` | `memoryDb()` (`createDatabase(":memory:")` + `runMigrations`) and raw insert helpers |
| `schema.qa.test.ts` | Idempotent migrations, STRICT typing, CHECK/UNIQUE/FK/CASCADE constraints, order_items snapshot, `resolveDatabasePath`, `getDatabase` with `:memory:`, `withTransaction` rollback and nested savepoints |
| `product-repository.qa.test.ts` | Not-found / empty behaviour, hostile slugs and ids, `getManyByIds` edge cases, domain-shape checks, `decrementStock` error codes and invalid quantities, in-process and two-connection races |
| `seed.qa.test.ts` | Seed stock coverage (0 and 1), image files exist and look like SVG, seed idempotency, and a check that the implementer tests leave `data/` unchanged |

Rules: every DB is `:memory:` except one race test that uses a throwaway file in the OS temp dir (deleted afterwards). Nothing here opens `./data/storefront.sqlite`. Tests that reproduce defects use `test.failing(...)`; there are none at present.
