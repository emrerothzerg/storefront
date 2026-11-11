# Storefront

Ecommerce storefront built with Next.js (App Router, React Server Components), TypeScript strict mode and Tailwind CSS v4, running on Bun.

## Requirements

- Bun >= 1.4.4 (`bun --version`). Bun is the runtime, package manager and test runner.

## Commands

```sh
bun install          # install dependencies (uses bun.lock)
bun run dev          # dev server on http://localhost:3000 (PORT=3100 bun run dev to change)
bun run build        # production build
bun run start        # serve the production build
bun run typecheck    # tsc --noEmit
bun run lint         # eslint (eslint-config-next)
bun test             # unit + component tests
```

### Why `--bun` matters

The `dev`, `build` and `start` scripts run `bun --bun next ...`. The `next` binary starts with a `#!/usr/bin/env node` shebang, so plain `bun run next dev` hands the process to Node. `--bun` makes Bun ignore the shebang and run Next on the Bun runtime. Always use the package scripts rather than calling `next` directly.

## Directory layout and ownership

Atomic design. One owner per directory; do not edit another owner's files without coordinating through the orchestrator.

| Path | Contents | Owner |
|---|---|---|
| `src/app/` | Next routes: layouts, pages, `globals.css` | programmer |
| `src/components/atoms/` | Smallest presentational building blocks | designer-technologist |
| `src/components/molecules/` | Small compositions of atoms | programmer |
| `src/components/organisms/` | Page sections built from molecules/atoms | programmer |
| `src/components/templates/` | Page layouts without route data | programmer |
| `src/server/db/` | `bun:sqlite` client, schema, seeds (T07) | programmer |
| `src/server/catalog/` | Product repository (T07) | programmer |
| `src/server/session/` | Guest session cookie (T08) | programmer |
| `src/server/cart/` | Cart repository + service (T09) | programmer |
| `src/server/payments/` | Payment provider interface + mock (T10) | programmer |
| `src/server/orders/` | Order repository + service (T11) | programmer |
| `src/lib/` | Domain types, result, money, validation (T06); see `src/lib/README.md` | programmer |
| `src/test/` | Test environment setup | programmer |
| `tests/server/`, `tests/e2e/`, `tests/a11y/` | QA integration, E2E and accessibility tests (T26/T27/T28) | qa-engineer |
| `data/` | Runtime SQLite file (gitignored) | programmer (T07) |

`src/server/**` is server-only and must never be imported from a `"use client"` module. `src/components/atoms/_Smoke/` is a disposable pipeline check and can be deleted.

Each directory has its own `README.md` describing what belongs there.

## Testing

- Runner: `bun test` (not Jest or Vitest). Tests live next to the code as `*.test.ts` / `*.test.tsx` and import from `bun:test`.
- DOM: happy-dom, registered globally by preload scripts configured in `bunfig.toml`:
  1. `src/test/happydom.ts` registers happy-dom globals via `@happy-dom/global-registrator`. It must run first, because `@testing-library/dom` captures `document.body` when it is first imported.
  2. `src/test/setup.ts` extends `expect` with `@testing-library/jest-dom` matchers (`toBeInTheDocument`, ...) and runs RTL `cleanup()` after each test.
  `src/test/jest-dom.d.ts` types those matchers on `bun:test`'s `expect`.
- What gets unit tests: pure logic (`src/lib`, `src/server/services` with fakes) and client components (`"use client"`), rendered with `@testing-library/react`.
- What does not: async React Server Components cannot be rendered by Testing Library. Keep their logic in testable services/utilities; the components themselves will be covered by integration/E2E tests later.
