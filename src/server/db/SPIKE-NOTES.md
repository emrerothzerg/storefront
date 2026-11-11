# Spike: `bun:sqlite` inside Next.js on Bun (T07 step 0)

Date: 2026-11-06. Next.js 16.4.5 (Turbopack, `cacheComponents: true`), Bun 1.4.4, SQLite 3.51.0 (bundled with Bun).

## Verdict: WORKS, no config needed

```ts
import { Database } from "bun:sqlite";
```

A plain static import works in an async Server Component, in a `"use server"` action, and in `bun test`, under both `bun --bun next dev` and `bun --bun next build` + `bun --bun next start`. `next.config.ts` was **not** changed: no `serverExternalPackages`, no `import()` with ignore comments. Types come from `@types/bun` (already a devDependency) and `bun run typecheck` passes.

## What was tested

Throwaway route (now deleted):
- `src/app/_spike/db.ts` opened a module-level `new Database(":memory:")`, created a table, and exported `insertHit()` and `countHits()`.
- `page.tsx` used an async `<Count>` inside `<Suspense>`. It called `await connection()` to force per-request rendering, inserted a row and rendered `SPIKE_COUNT=<n> SQLITE_VERSION=<v> RUNTIME=bun-<version>`.
- `actions.ts` (`"use server"`) had `addHit()`, which inserted a row and returned the count. A tiny client form called it.
- A test file opened `:memory:`, inserted a row and asserted the count.

## Evidence

**`bun --bun next dev` on port 3100**
```
GET /_spike #1: HTTP 200  <p>SPIKE_COUNT=1 SQLITE_VERSION=3.51.0 RUNTIME=bun-1.4.4</p>
GET /_spike #2: HTTP 200  <p>SPIKE_COUNT=2 ...</p>
GET /_spike #3: HTTP 200  <p>SPIKE_COUNT=3 ...</p>
POST action #1 (Next-Action: 002b74...): HTTP 200  RSC body: 0:{"a":"$@1",...} 1:4
POST action #2: HTTP 200  RSC body: ... 1:5
server log: [spike] server action inserted row, count=4
            POST /_spike 200 in 8ms  └─ ƒ addHit() in 1ms src/app/_spike/actions.ts
```

**`bun --bun next build`, then `PORT=3102 bun --bun next start`**
```
Route (app)
┌ ○ /
├ ○ /_not-found
└ ◐ /_spike      (Partial Prerender)
GET /_spike #1..#3: HTTP 200  SPIKE_COUNT=1, 2, 3  RUNTIME=bun-1.4.4
POST action #1 (Next-Action: 00955a...): HTTP 200  RSC body: ... 1:4
POST action #2: HTTP 200  ... 1:5
server log: [spike] server action inserted row, count=4 / count=5
```

**`bun test src/server/db/spike.test.ts`**
```
 1 pass
 0 fail
 1 expect() calls
```

## Findings for T07

1. **Module-level state is shared across a process.** The page and the action saw the same `:memory:` DB: the GETs counted 1-3 and the action continued at 4-5. In dev, HMR can re-evaluate the module. For the real file DB, use a lazily created singleton cached on `globalThis` so dev reloads don't open duplicate handles.
2. **cacheComponents is on.** Without `await connection()` (or other dynamic APIs) and a `<Suspense>` boundary, a synchronous `bun:sqlite` read inside a server component can get prerendered at build time, which freezes the data. Pages that read the DB must opt into dynamic rendering or use explicit `"use cache"`.
3. **Bun is required at runtime.** `bun:sqlite` exists only under Bun, so always use the package scripts (`bun --bun next ...`). Plain `next start` under Node would fail to resolve the module.
4. **Fallback, not needed:** Bun 1.4.4 also exposes `node:sqlite` (`DatabaseSync`, `StatementSync`, `Session`, `backup`, `constants`). It would be the escape hatch if the app ever had to run on Node.
5. **Routing gotcha:** folders starting with `_` under `src/app/` are private and not routed. `src/app/_spike/page.tsx` alone returned 404. The spike needed a one-line `src/app/%5Fspike/page.tsx` re-export to serve `/_spike`.
