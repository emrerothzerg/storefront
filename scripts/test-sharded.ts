// Sharded test runner: `bun run test` (see src/test/README.md).
//
// `bun test` runs every file in ONE process. Module mocks, the happy-dom
// globals, module-level databases and React's global action state then live
// for the whole run, so memory only grows and one file's leftovers can break
// later files. This script discovers the same test files `bun test` would,
// splits them into shards and runs each shard in a fresh `bun test <files>`
// child process, so everything is released at every shard boundary. The
// children inherit bunfig.toml (preloads) from the working directory.
//
// A watchdog kills any shard whose resident memory passes --max-rss (MB), so
// one runaway test cannot take the machine down; the shard is reported failed.
//
// Usage: bun run scripts/test-sharded.ts [--shard-size=N] [--jobs=N] [--max-rss=MB]
//          [--list] [bun test flags, e.g. --timeout=10000 --bail -t "name"] [path filters]
import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export const DEFAULT_SHARD_SIZE = 25;
export const DEFAULT_JOBS = 1;
/** Per-shard resident memory cap in MB (0 disables the watchdog). */
export const DEFAULT_MAX_RSS_MB = 4096;
const RSS_POLL_MS = 1000;

/** Same file-name rule as bun test: `.test`, `_test`, `.spec`, `_spec` before a JS/TS extension. */
const TEST_FILE_PATTERN = /[._](test|spec)\.(c|m)?[jt]sx?$/;
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".next", ".git"]);
/** bun test flags whose value may be given as the next argument instead of `--flag=value`. */
const FLAGS_WITH_SEPARATE_VALUE: ReadonlySet<string> = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--max-concurrency",
  "--path-ignore-patterns",
]);
const LEAK_MARKER = "[test-setup] LEAKED-REACT-ACTION";

export interface RunnerOptions {
  readonly shardSize: number;
  readonly jobs: number;
  /** Kill a shard whose RSS exceeds this many MB; 0 = no limit. */
  readonly maxRssMb: number;
  readonly listOnly: boolean;
  readonly bail: boolean;
  /** Flags forwarded verbatim to every `bun test` child. */
  readonly passthrough: readonly string[];
  /** Path filters (substring match on the relative path, like `bun test <filter>`). */
  readonly filters: readonly string[];
}

export type ParseResult = { readonly ok: true; readonly options: RunnerOptions } | { readonly ok: false; readonly error: string };

function parseInteger(raw: string, name: string, min: number): number | string {
  if (!/^\d+$/.test(raw)) return `${name} must be a positive integer, got "${raw}"`;
  const value = Number(raw);
  return value >= min ? value : `${name} must be at least ${min}, got "${raw}"`;
}

export function parseArgs(argv: readonly string[]): ParseResult {
  let shardSize = DEFAULT_SHARD_SIZE;
  let jobs = DEFAULT_JOBS;
  let maxRssMb = DEFAULT_MAX_RSS_MB;
  let listOnly = false;
  let bail = false;
  const passthrough: string[] = [];
  const filters: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--shard-size=") || arg.startsWith("--jobs=") || arg.startsWith("--max-rss=")) {
      const [name, raw] = arg.split("=", 2) as [string, string];
      const value = parseInteger(raw, name, name === "--max-rss" ? 0 : 1);
      if (typeof value === "string") return { ok: false, error: value };
      if (name === "--shard-size") shardSize = value;
      else if (name === "--jobs") jobs = value;
      else maxRssMb = value;
    } else if (arg === "--shard-size" || arg === "--jobs" || arg === "--max-rss") {
      return { ok: false, error: `${arg} needs a value: ${arg}=N` };
    } else if (arg === "--list") {
      listOnly = true;
    } else if (arg.startsWith("-")) {
      if (arg === "--bail" || arg.startsWith("--bail=")) bail = true;
      passthrough.push(arg);
      if (FLAGS_WITH_SEPARATE_VALUE.has(arg)) {
        const value = argv[i + 1];
        if (value === undefined) return { ok: false, error: `${arg} needs a value` };
        passthrough.push(value);
        i++;
      }
    } else {
      filters.push(arg);
    }
  }
  return { ok: true, options: { shardSize, jobs, maxRssMb, listOnly, bail, passthrough, filters } };
}

export function isTestFile(name: string): boolean {
  return TEST_FILE_PATTERN.test(name);
}

/** Recursively lists test files under `root` as sorted, `/`-separated paths relative to `root`. */
export function discoverTestFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && isTestFile(entry.name)) {
        found.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** Normalises a CLI path filter to the relative `/` form used by discoverTestFiles. */
export function normaliseFilter(filter: string, root: string): string {
  const rel = isAbsolute(filter) ? relative(root, filter) : filter;
  return rel.split(sep).join("/").replace(/^(\.\/)+/, "");
}

/** Keeps files whose relative path contains any filter (all files when there are no filters). */
export function filterFiles(files: readonly string[], filters: readonly string[], root: string): string[] {
  if (filters.length === 0) return [...files];
  const needles = filters.map((f) => normaliseFilter(f, root)).filter((f) => f !== "" && f !== ".");
  if (needles.length === 0) return [...files];
  return files.filter((file) => needles.some((needle) => file.includes(needle)));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface FailedTest {
  readonly file: string;
  readonly name: string;
}

export interface ShardCounts {
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
  readonly todo: number;
  /** From "Ran N tests across M files"; null when the summary line is missing (crash). */
  readonly tests: number | null;
  readonly files: number | null;
  readonly failed: readonly FailedTest[];
  readonly leaks: readonly string[];
}

const ANSI = /\u001b\[[0-9;]*m/g;
const FILE_HEADER = /^(\S.*[._](?:test|spec)\.(?:c|m)?[jt]sx?):$/;
const UNHANDLED_ERROR = /^# Unhandled error between tests/;

function countOf(text: string, label: string): number {
  const match = new RegExp(`^\\s*(\\d+) ${label}$`, "m").exec(text);
  return match ? Number(match[1]) : 0;
}

/** Parses the console output of one `bun test` run. */
export function parseBunTestOutput(raw: string): ShardCounts {
  const text = raw.replace(ANSI, "");
  const failed: FailedTest[] = [];
  const leaks: string[] = [];
  let file = "(unknown file)";
  for (const line of text.split("\n")) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      file = header[1] as string;
    } else if (line.startsWith("(fail) ")) {
      failed.push({ file, name: line.slice("(fail) ".length).trim() });
    } else if (UNHANDLED_ERROR.test(line)) {
      failed.push({ file, name: "(unhandled error between tests)" });
    } else if (line.includes(LEAK_MARKER)) {
      leaks.push(line.slice(line.indexOf(LEAK_MARKER)).trim());
    }
  }
  const ran = /^Ran (\d+) tests? across (\d+) files?\./m.exec(text);
  return {
    pass: countOf(text, "pass"),
    fail: countOf(text, "fail"),
    skip: countOf(text, "skip"),
    todo: countOf(text, "todo"),
    tests: ran ? Number(ran[1]) : null,
    files: ran ? Number(ran[2]) : null,
    failed,
    leaks,
  };
}

/** getrusage ru_maxrss is bytes on macOS and kilobytes on Linux; Bun passes it through. */
export function maxRssBytes(maxRSS: number, platform: string = process.platform): number {
  return platform === "darwin" ? maxRSS : maxRSS * 1024;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export interface ShardResult {
  readonly index: number;
  readonly files: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly maxRss: number | null;
  /** RSS in bytes at which the watchdog killed the shard; null when it was not killed. */
  readonly killedAtRss: number | null;
  readonly seconds: number;
  readonly counts: ShardCounts;
}

/**
 * A shard is green only when bun exited 0, reported no failures and printed
 * its summary (a missing summary means the child crashed or was killed).
 * Fewer files than given is only reported: bun does not count files with no
 * (matching) tests, and a file that fails to load is already a failure.
 */
export function shardFailed(result: ShardResult): boolean {
  return result.exitCode !== 0 || result.counts.fail > 0 || result.counts.files === null;
}

export function summarise(results: readonly ShardResult[], discovered: number, wallSeconds: number): string {
  const sum = (pick: (c: ShardCounts) => number) => results.reduce((n, r) => n + pick(r.counts), 0);
  const lines: string[] = [];
  lines.push("", "=".repeat(72), "Sharded test summary", "=".repeat(72));
  for (const r of results) {
    const status = shardFailed(r) ? "FAIL" : "ok";
    const rss = r.maxRss === null ? "n/a" : formatBytes(r.maxRss);
    const ranFiles = r.counts.files === null ? "no summary" : `${r.counts.files}/${r.files.length} files`;
    const signal = r.signal === null ? "" : ` signal=${r.signal}`;
    const killed = r.killedAtRss === null ? "" : `  KILLED by --max-rss at ${formatBytes(r.killedAtRss)}`;
    lines.push(
      `shard ${String(r.index + 1).padStart(3)}  ${status.padEnd(4)}  ${ranFiles.padEnd(14)}  ` +
        `pass ${r.counts.pass}  fail ${r.counts.fail}  maxRSS ${rss}  ${r.seconds.toFixed(1)}s  exit=${r.exitCode}${signal}${killed}`,
    );
  }
  const failed = results.flatMap((r) => r.counts.failed);
  if (failed.length > 0) {
    lines.push("", `Failing tests (${failed.length}):`);
    for (const f of failed) lines.push(`  ${f.file} > ${f.name}`);
  }
  const killedShards = results.filter((r) => r.killedAtRss !== null);
  if (killedShards.length > 0) {
    lines.push("", "Shards killed for exceeding --max-rss (rerun their files one by one to find the culprit):");
    for (const r of killedShards) lines.push(`  shard ${r.index + 1}: ${r.files.join(" ")}`);
  }
  const incomplete = results.filter((r) => r.counts.files === null || r.counts.files < r.files.length);
  if (incomplete.length > 0) {
    lines.push("", "Shards where bun reported fewer files than it was given (file without matching tests, load error, or crash):");
    for (const r of incomplete) lines.push(`  shard ${r.index + 1}: ${r.files.join(" ")}`);
  }
  const leaks = results.flatMap((r) => r.counts.leaks);
  if (leaks.length > 0) {
    lines.push("", "Leaked React async actions (later form tests in the same shard may time out):");
    for (const l of leaks) lines.push(`  ${l}`);
  }
  const peak = results.reduce<number | null>((m, r) => (r.maxRss === null ? m : Math.max(m ?? 0, r.maxRss)), null);
  const ranTests = results.reduce((n, r) => n + (r.counts.tests ?? 0), 0);
  const ranFiles = results.reduce((n, r) => n + (r.counts.files ?? 0), 0);
  lines.push(
    "",
    ` ${sum((c) => c.pass)} pass`,
    ` ${sum((c) => c.fail)} fail`,
    ...(sum((c) => c.skip) > 0 ? [` ${sum((c) => c.skip)} skip`] : []),
    ...(sum((c) => c.todo) > 0 ? [` ${sum((c) => c.todo)} todo`] : []),
    `Ran ${ranTests} tests across ${ranFiles} files (${discovered} discovered) in ${results.length} shards. [${wallSeconds.toFixed(1)}s]`,
    `Peak shard max RSS: ${peak === null ? "n/a" : formatBytes(peak)}`,
  );
  return lines.join("\n");
}

const running = new Set<Bun.Subprocess>();

/** Current resident set size of `pid` in bytes via `ps` (null when unavailable). */
export function readRssBytes(pid: number): number | null {
  const ps = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const kb = Number.parseInt(ps.stdout.toString().trim(), 10);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

async function pump(stream: ReadableStream<Uint8Array>, sink: (chunk: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sink(decoder.decode(value, { stream: true }));
  }
  const rest = decoder.decode();
  if (rest !== "") sink(rest);
}

async function runShard(index: number, total: number, files: readonly string[], options: RunnerOptions): Promise<ShardResult> {
  const live = options.jobs === 1;
  const banner = `\n--- shard ${index + 1}/${total} (${files.length} files: ${files[0]} .. ${files[files.length - 1]})\n`;
  let captured = "";
  if (live) process.stdout.write(banner);
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, "test", ...options.passthrough, ...files.map((f) => `./${f}`)], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  running.add(proc);
  let killedAtRss: number | null = null;
  const capBytes = options.maxRssMb * 1024 * 1024;
  const watchdog =
    capBytes > 0
      ? setInterval(() => {
          const rss = readRssBytes(proc.pid);
          if (rss !== null && rss > capBytes && killedAtRss === null) {
            killedAtRss = rss;
            process.stderr.write(
              `\ntest-sharded: shard ${index + 1} RSS ${formatBytes(rss)} > --max-rss=${options.maxRssMb} MB, killing it\n`,
            );
            proc.kill("SIGKILL");
          }
        }, RSS_POLL_MS)
      : null;
  const sink = (target: NodeJS.WriteStream) => (text: string) => {
    captured += text;
    if (live) target.write(text);
  };
  await Promise.all([pump(proc.stdout, sink(process.stdout)), pump(proc.stderr, sink(process.stderr)), proc.exited]);
  running.delete(proc);
  if (watchdog !== null) clearInterval(watchdog);
  if (!live) process.stdout.write(banner + captured);
  const usage = proc.resourceUsage();
  return {
    index,
    files,
    exitCode: proc.exitCode,
    signal: proc.signalCode === null ? null : String(proc.signalCode),
    maxRss: usage === undefined ? null : maxRssBytes(usage.maxRSS),
    killedAtRss,
    seconds: (performance.now() - started) / 1000,
    counts: parseBunTestOutput(captured),
  };
}

export async function main(argv: readonly string[], root: string = process.cwd()): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`test-sharded: ${parsed.error}`);
    return 2;
  }
  const { options } = parsed;
  const discovered = discoverTestFiles(root);
  const files = filterFiles(discovered, options.filters, root);
  if (files.length === 0) {
    console.error(`test-sharded: no test files match ${options.filters.join(" ") || "(no filter)"}`);
    return 1;
  }
  const shards = chunk(files, options.shardSize);
  if (options.listOnly) {
    shards.forEach((s, i) => console.log(`shard ${i + 1}/${shards.length}\n  ${s.join("\n  ")}`));
    return 0;
  }
  console.log(
    `test-sharded: ${files.length} files in ${shards.length} shards of up to ${options.shardSize}, ${options.jobs} at a time, ` +
      `max RSS per shard ${options.maxRssMb === 0 ? "unlimited" : `${options.maxRssMb} MB`}`,
  );
  const started = performance.now();
  const results: ShardResult[] = [];
  let next = 0;
  let stop = false;
  const worker = async (): Promise<void> => {
    while (!stop && next < shards.length) {
      const index = next++;
      const result = await runShard(index, shards.length, shards[index] as string[], options);
      results.push(result);
      if (options.bail && shardFailed(result)) stop = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.jobs, shards.length) }, worker));
  results.sort((a, b) => a.index - b.index);
  console.log(summarise(results, files.length, (performance.now() - started) / 1000));
  if (results.length < shards.length) console.log(`Stopped after ${results.length}/${shards.length} shards (--bail).`);
  return results.some(shardFailed) || results.length < shards.length ? 1 : 0;
}

if (import.meta.main) {
  const killAll = (signal: NodeJS.Signals) => {
    for (const proc of running) proc.kill(signal);
    process.exit(130);
  };
  process.on("SIGINT", () => killAll("SIGINT"));
  process.on("SIGTERM", () => killAll("SIGTERM"));
  process.exit(await main(Bun.argv.slice(2)));
}
