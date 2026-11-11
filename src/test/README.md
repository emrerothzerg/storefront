# test
Test environment for `bun test`, preloaded via `bunfig.toml` (in this order): `happydom.ts` registers the DOM, `setup.ts` adds jest-dom matchers, RTL cleanup and the leaked-action check, `next-module-pins.ts` pins the export lists of the commonly mocked `next/*` modules. `jest-dom.d.ts` types the matchers. Owner: programmer.

The only test files here test the preloads themselves (`react-action-leak.test.tsx`, `next-module-pins.test.ts`; `fixtures/*.fixture.ts` are run by the latter in a child process and are not discovered by `bun test`) and the shared helpers (`dom-assertions.test.ts`).

## Running tests

| Command | What it does |
|---|---|
| `bun run test` | **Default for humans and for the full suite.** `scripts/test-sharded.ts`: finds the same files as `bun test`, runs them in shards of 25 files, each in a fresh `bun test` child process (one at a time), then prints one summary (pass/fail/skip/todo, failing tests with their file, max RSS per shard, overall peak). Exit code is non-zero if any shard fails. |
| `bun run test src/app/cart` | Same, only for files whose path contains `src/app/cart`. |
| `bun test src/app/cart` | Plain single-process run. Scoped runs like this are unchanged and are what agents use. |
| `bun run test:raw` | The old full single-process `bun test`. Avoid: one process for the whole suite grows for the whole run. |

Runner flags (everything else is passed to every `bun test` child, e.g. `--timeout=10000`, `--bail`, `-t "name"`):

- `--shard-size=N` files per shard (default 25). Smaller = lower peak memory, a little more start-up time per shard.
- `--jobs=N` shards in parallel (default 1). Each job is a separate bun process, so peak memory is about N times one shard. Keep 1 on a laptop or while other agents run tests.
- `--max-rss=MB` watchdog (default 4096): a shard whose resident memory passes this is killed with SIGKILL and reported as failed, so one runaway test cannot exhaust the machine. `--max-rss=0` turns it off.
- `--list` prints the shards and exits.

Files run in sorted path order. `bun test` uses its own directory-scan order, so a test that only passes because of what an earlier file left behind (or only fails because of it) can behave differently between the two. When the totals differ, run the file alone with `bun test ./path/to/file`: that result is the truth.

## Rule: never pass a DOM node to `expect` inside `waitFor`; use `dom-assertions`

When an assertion like `expect(document.activeElement).toBe(button)` or `expect(screen.queryByRole("alert")).toBeNull()` fails, Bun formats the received and expected values for the error message, and a happy-dom node pulls its whole document graph into that string. Inside `waitFor` (or any polling callback) every failing poll does it again, so a few polls under CPU load allocate gigabytes and the process is killed (root cause found in T129a, cleaned up in TEST-HYGIENE, 2026-11-07).

Import from `@/test/dom-assertions` (works from `src/**` and `tests/**`); every helper compares identity or nullness as a boolean and only puts short strings into `expect`:

| Helper | Same meaning as |
|---|---|
| `expectFocused(node, doc?)` | `expect(document.activeElement).toBe(node)` |
| `expectNotFocused(node, doc?)` | `expect(document.activeElement).not.toBe(node)` |
| `expectSameNode(actual, expected)` | `expect(actual).toBe(expected)` for nodes |
| `expectNull(node)` / `expectNotNull(node)` | `expect(node).toBeNull()` / `.not.toBeNull()` |
| `expectInDocument(node)` / `expectNotInDocument(node)` | jest-dom `toBeInTheDocument()` / `.not.toBeInTheDocument()` |
| `tagOf(node)` | short description (tag, id, data-testid, first 120 chars of outerHTML), `null` for null/undefined |

Comparing strings or booleans yourself is fine too (`expect(document.activeElement === el).toBe(true)`, `expect(el.textContent).toBe("…")`). Prefer the helpers in direct assertions as well; they cost nothing.

## Preload behaviour (and why)

- **RTL cleanup** after every test (`afterEach(cleanup)`).
- **`DATABASE_PATH` safety net**: unset or blank becomes `:memory:` so tests never open `./data`.
- **Leaked React async actions** (`react-action-leak.ts`, wired in `setup.ts`, added 2026-11-07, TEST-MEM). React 19 entangles every transition that starts while any async action (form action, `useActionState` dispatch, `startTransition(async …)`) is pending, and that state is global in react-dom. `bun test` shares one react-dom across all files in a process, so one never-settled action (for example a controlled promise that a test never resolves) makes every later form test in the process hang until the Testing Library timeout (about 1,000 ms). That was the cause of the ~100 failures at ≈1,010 ms in the 2026-11-07 full run; it was not machine load. At each file boundary (a change of `Bun.main` in `beforeEach`; preload `beforeAll`/`afterAll` run once per process, not per file) and once at the end of the process, the preload starts an empty async transition in a detached root. If it does not settle within 250 ms, it prints `[test-setup] LEAKED-REACT-ACTION <file>: …` naming the file that just finished. Only the first leak per process is reported, because every later check would also hang. Cost when healthy: a few ms per file. The fix always belongs in the reported file: resolve or reject every controlled action before its test ends.
- **`next/*` export pins** (`next-module-pins.ts`, added 2026-11-07, TEST-MEM). `mock.module` applies to the whole process, and a later `mock.module` for the same specifier cannot add export names the first mock did not have. Many files mock `next/headers` with only `cookies`, so a later file whose code imports `headers` failed to load with `SyntaxError: Export named 'headers' not found`, depending on file order. The preload registers `next/headers`, `next/cache`, `next/navigation` and `next/server` with their own real exports before any test file runs. Files that do not mock them still get the real functions.

## Considered and not done

- **Raising Testing Library `asyncUtilTimeout`.** The ≈1,010 ms failures were waits that could never succeed (see the leaked-action check above). A longer timeout would not have fixed one of them; it would only have made each poisoned test take 5 s.
- **Closing the `getDatabase()` singleton after each file.** Preload `afterAll` runs once per process, not per file, and doing it at the next file's first `beforeEach` would close a handle that the new file may already have taken at import time (same path, so the same cached instance). The singleton does not pile up anyway: there is at most one, and `getDatabase()` closes the old one when the path changes. `:memory:` databases that nothing references any more are freed by GC (measured: 300 seeded databases dropped without `close()` fell back to about 39 MB after GC, against 458 MB while still referenced). The real cost is databases held in module-level variables of test files, and sharding releases those at every shard boundary.
- **Resetting happy-dom between files.** Measured at every file boundary in `tests/`: `document.body` and `document.head` had no children, `localStorage` was empty and `document.cookie` was empty. Nothing was piling up.
- **`bun test --isolate`** (fresh global per file). It fixes cross-file leaks too, but `bun test --isolate src/components/molecules` (59 files) peaked at 2.4 GB, against 0.46 GB for the whole `src/components` slice (144 files) without it, and two tests behaved differently under it.
