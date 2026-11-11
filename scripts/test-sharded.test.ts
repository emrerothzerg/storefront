import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_JOBS,
  DEFAULT_MAX_RSS_MB,
  DEFAULT_SHARD_SIZE,
  chunk,
  discoverTestFiles,
  filterFiles,
  formatBytes,
  isTestFile,
  main,
  maxRssBytes,
  normaliseFilter,
  parseArgs,
  parseBunTestOutput,
  readRssBytes,
  shardFailed,
  summarise,
  type ShardCounts,
  type ShardResult,
} from "./test-sharded";

const ROOT = "/repo";

describe("parseArgs", () => {
  test("defaults", () => {
    expect(parseArgs([])).toEqual({
      ok: true,
      options: {
        shardSize: DEFAULT_SHARD_SIZE,
        jobs: DEFAULT_JOBS,
        maxRssMb: DEFAULT_MAX_RSS_MB,
        listOnly: false,
        bail: false,
        passthrough: [],
        filters: [],
      },
    });
  });

  test("runner flags, passthrough flags (incl. separate values) and path filters", () => {
    const parsed = parseArgs([
      "--shard-size=10",
      "--jobs=2",
      "--max-rss=0",
      "--timeout=9000",
      "-t",
      "cart total",
      "--bail",
      "src/app/cart",
      "--list",
      "--test-name-pattern",
      "x",
    ]);
    expect(parsed).toEqual({
      ok: true,
      options: {
        shardSize: 10,
        jobs: 2,
        maxRssMb: 0,
        listOnly: true,
        bail: true,
        passthrough: ["--timeout=9000", "-t", "cart total", "--bail", "--test-name-pattern", "x"],
        filters: ["src/app/cart"],
      },
    });
  });

  test("--bail=3 counts as bail and is forwarded", () => {
    const parsed = parseArgs(["--bail=3"]);
    expect(parsed.ok && parsed.options.bail).toBe(true);
    expect(parsed.ok && parsed.options.passthrough).toEqual(["--bail=3"]);
  });

  test.each([
    ["--shard-size=0", "at least 1"],
    ["--shard-size=-2", "positive integer"],
    ["--jobs=abc", "positive integer"],
    ["--jobs=1.5", "positive integer"],
    ["--shard-size=", "positive integer"],
    ["--max-rss=-1", "positive integer"],
  ])("rejects %s", (arg, message) => {
    const parsed = parseArgs([arg]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  test("rejects a runner flag without =value and a value flag at the end", () => {
    expect(parseArgs(["--jobs", "2"]).ok).toBe(false);
    expect(parseArgs(["--max-rss", "100"]).ok).toBe(false);
    expect(parseArgs(["-t"]).ok).toBe(false);
    expect(parseArgs(["--timeout"]).ok).toBe(false);
  });
});

describe("isTestFile (bun test naming rule)", () => {
  test.each([
    "a.test.ts",
    "a.test.tsx",
    "a_test.ts",
    "a.spec.js",
    "a_spec.jsx",
    "a.test.mjs",
    "a.spec.cts",
    "page.v2.test.tsx",
    "x.qa.test.ts",
  ])("matches %s", (name) => {
    expect(isTestFile(name)).toBe(true);
  });

  test.each(["a.ts", "a.tsx", "test.ts", "a.test.ts.snap", "race.qa.worker.ts", "a.testing.ts", "a.test.css", "atest.ts"])(
    "ignores %s",
    (name) => {
      expect(isTestFile(name)).toBe(false);
    },
  );
});

describe("discoverTestFiles", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "test-sharded-"));
    const files = [
      "src/b/b.test.tsx",
      "src/a/a.test.ts",
      "src/a/helper.ts",
      "tests/x_spec.ts",
      "tests/race.qa.worker.ts",
      "node_modules/pkg/c.test.ts",
      "src/node_modules/d.test.ts",
      ".next/server/e.test.js",
      ".git/f.test.ts",
    ];
    for (const file of files) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), "");
    }
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("finds test files, sorted, skipping node_modules/.next/.git at any depth", () => {
    expect(discoverTestFiles(dir)).toEqual(["src/a/a.test.ts", "src/b/b.test.tsx", "tests/x_spec.ts"]);
  });

  test("main --list with a filter prints only matching shards and exits 0", async () => {
    const out: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      out.push(args.join(" "));
    };
    try {
      expect(await main(["--list", "--shard-size=1", "src/"], dir)).toBe(0);
    } finally {
      console.log = original;
    }
    expect(out).toEqual(["shard 1/2\n  src/a/a.test.ts", "shard 2/2\n  src/b/b.test.tsx"]);
  });

  test("main exits 1 when no file matches and 2 on bad arguments", async () => {
    const original = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      expect(await main(["--list", "nothing-matches-this"], dir)).toBe(1);
      expect(await main(["--shard-size=0"], dir)).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors[0]).toContain("no test files match nothing-matches-this");
    expect(errors[1]).toContain("--shard-size must be at least 1");
  });
});

describe("filterFiles / normaliseFilter", () => {
  const [cart, cartV2, server, qa] = ["src/app/cart/page.test.tsx", "src/app/cart-v2/x.test.ts", "src/server/a.test.ts", "tests/app/cart.qa.test.ts"] as const;
  const files = [cart, cartV2, server, qa];

  test("no filters keeps everything", () => {
    expect(filterFiles(files, [], ROOT)).toEqual(files);
  });

  test("substring match like bun test, ./ and absolute paths normalised", () => {
    expect(filterFiles(files, ["src/app/cart/"], ROOT)).toEqual(["src/app/cart/page.test.tsx"]);
    expect(filterFiles(files, ["./src/server"], ROOT)).toEqual(["src/server/a.test.ts"]);
    expect(filterFiles(files, [`${ROOT}/tests`], ROOT)).toEqual(["tests/app/cart.qa.test.ts"]);
    expect(filterFiles(files, ["cart"], ROOT)).toEqual([cart, cartV2, qa]);
    expect(filterFiles(files, ["server", "tests/"], ROOT)).toEqual([server, qa]);
  });

  test("a filter of . or ./ means everything", () => {
    expect(filterFiles(files, ["."], ROOT)).toEqual(files);
    expect(filterFiles(files, ["./"], ROOT)).toEqual(files);
    expect(normaliseFilter(`${ROOT}/src/app`, ROOT)).toBe("src/app");
  });
});

describe("chunk", () => {
  test("splits into groups of size n, last one shorter", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
    expect(chunk([], 3)).toEqual([]);
  });

  test("rejects sizes below 1 or non-integers", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], 1.5)).toThrow(RangeError);
  });
});

const SAMPLE = [
  "bun test v1.4.4 (38afee6c8)",
  "",
  "src/a/a.test.ts:",
  "\u001b[0m\u001b[31m(fail)\u001b[0m suite > first [1009.23ms]",
  "",
  "src/b/b.test.tsx:",
  "(fail) other > second [2.00ms]",
  "[test-setup] LEAKED-REACT-ACTION src/b/b.test.tsx: a React async action ...",
  "",
  "src/c/c_spec.ts:",
  "",
  "# Unhandled error between tests",
  "-------------------------------",
  "SyntaxError: Export named 'headers' not found",
  "",
  " 40 pass",
  " 2 skip",
  " 1 todo",
  " 3 fail",
  " 99 expect() calls",
  "Ran 46 tests across 3 files. [1.20s]",
].join("\n");

describe("parseBunTestOutput", () => {
  test("counts, failing tests with their file, unhandled errors and leak markers", () => {
    const counts = parseBunTestOutput(SAMPLE);
    expect(counts).toEqual({
      pass: 40,
      fail: 3,
      skip: 2,
      todo: 1,
      tests: 46,
      files: 3,
      failed: [
        { file: "src/a/a.test.ts", name: "suite > first [1009.23ms]" },
        { file: "src/b/b.test.tsx", name: "other > second [2.00ms]" },
        { file: "src/c/c_spec.ts", name: "(unhandled error between tests)" },
      ],
      leaks: ["[test-setup] LEAKED-REACT-ACTION src/b/b.test.tsx: a React async action ..."],
    });
  });

  test("single test / single file wording", () => {
    const counts = parseBunTestOutput(" 1 pass\n 0 fail\nRan 1 test across 1 file. [5.00ms]");
    expect(counts.tests).toBe(1);
    expect(counts.files).toBe(1);
  });

  test("missing summary (crash) gives null totals and zero counts", () => {
    const counts = parseBunTestOutput("bun test v1.4.4\nsegmentation fault");
    expect(counts.tests).toBeNull();
    expect(counts.files).toBeNull();
    expect(counts.pass).toBe(0);
    expect(counts.fail).toBe(0);
  });

  test("a test whose name contains 'pass' does not confuse the counters", () => {
    const counts = parseBunTestOutput("(fail) 3 pass through [1ms]\n 5 pass\n 1 fail\nRan 6 tests across 1 file.");
    expect(counts.pass).toBe(5);
    expect(counts.fail).toBe(1);
  });
});

const counts = (over: Partial<ShardCounts> = {}): ShardCounts => ({
  pass: 10,
  fail: 0,
  skip: 0,
  todo: 0,
  tests: 10,
  files: 2,
  failed: [],
  leaks: [],
  ...over,
});

const result = (over: Partial<ShardResult> = {}): ShardResult => ({
  index: 0,
  files: ["a.test.ts", "b.test.ts"],
  exitCode: 0,
  signal: null,
  maxRss: 300 * 1024 * 1024,
  killedAtRss: null,
  seconds: 1.5,
  counts: counts(),
  ...over,
});

describe("shardFailed", () => {
  test("green shard", () => {
    expect(shardFailed(result())).toBe(false);
  });

  test("non-zero exit, failures, or a missing summary (crash/kill) fail the shard", () => {
    expect(shardFailed(result({ exitCode: 1 }))).toBe(true);
    expect(shardFailed(result({ exitCode: null, signal: "SIGKILL" }))).toBe(true);
    expect(shardFailed(result({ counts: counts({ fail: 1 }) }))).toBe(true);
    expect(shardFailed(result({ counts: counts({ tests: null, files: null }) }))).toBe(true);
  });

  test("fewer files than given (no matching tests under -t) alone is not a failure", () => {
    expect(shardFailed(result({ counts: counts({ files: 1 }) }))).toBe(false);
  });
});

describe("summarise", () => {
  test("aggregates totals, lists failures, incomplete shards, leaks and the peak RSS", () => {
    const text = summarise(
      [
        result({ index: 0, maxRss: 200 * 1024 * 1024 }),
        result({
          index: 1,
          exitCode: null,
          signal: "SIGKILL",
          maxRss: 2 * 1024 ** 3,
          killedAtRss: 2 * 1024 ** 3,
          counts: counts({
            pass: 5,
            fail: 1,
            skip: 2,
            tests: 8,
            files: 1,
            failed: [{ file: "b.test.ts", name: "x > y" }],
            leaks: ["[test-setup] LEAKED-REACT-ACTION b.test.ts: ..."],
          }),
        }),
      ],
      4,
      12.34,
    );
    expect(text).toContain("shard   1  ok ");
    expect(text).toContain("shard   2  FAIL");
    expect(text).toContain("signal=SIGKILL  KILLED by --max-rss at 2.00 GB");
    expect(text).toContain("Shards killed for exceeding --max-rss (rerun their files one by one to find the culprit):\n  shard 2:");
    expect(text).toContain("Failing tests (1):\n  b.test.ts > x > y");
    expect(text).toContain("shard 2: a.test.ts b.test.ts");
    expect(text).toContain("LEAKED-REACT-ACTION b.test.ts");
    expect(text).toContain(" 15 pass\n 1 fail\n 2 skip\nRan 18 tests across 3 files (4 discovered) in 2 shards. [12.3s]");
    expect(text).toContain("Peak shard max RSS: 2.00 GB");
    expect(text).not.toContain(" todo");
  });

  test("no RSS data prints n/a", () => {
    expect(summarise([result({ maxRss: null })], 2, 1)).toContain("Peak shard max RSS: n/a");
  });
});

describe("readRssBytes", () => {
  test("reads this process's RSS in bytes", () => {
    const rss = readRssBytes(process.pid);
    expect(rss).not.toBeNull();
    expect(rss as number).toBeGreaterThan(1024 * 1024);
  });

  test("null for a pid that does not exist", () => {
    expect(readRssBytes(2 ** 22 + 12345)).toBeNull();
  });
});

describe("units", () => {
  test("maxRssBytes: bytes on macOS, kilobytes elsewhere", () => {
    expect(maxRssBytes(1000, "darwin")).toBe(1000);
    expect(maxRssBytes(1000, "linux")).toBe(1024000);
  });

  test("formatBytes", () => {
    expect(formatBytes(300 * 1024 * 1024)).toBe("300 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.50 GB");
  });
});
