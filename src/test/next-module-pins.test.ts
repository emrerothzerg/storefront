import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the two fixtures in a child `bun test` so the cookies-only mock in
// pin-a cannot leak into this process.
const ROOT = join(import.meta.dir, "..", "..");
const FIXTURES = ["./src/test/fixtures/pin-a.fixture.ts", "./src/test/fixtures/pin-b.fixture.ts"];
const tmp = mkdtempSync(join(tmpdir(), "next-pins-"));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function runChild(extraArgs: readonly string[]): { exitCode: number | null; output: string } {
  const proc = Bun.spawnSync([process.execPath, ...extraArgs, "test", ...FIXTURES], {
    cwd: ROOT,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

describe("next-module-pins preload", () => {
  test("with the repo bunfig: a cookies-only next/headers mock does not break a later `headers` import", () => {
    const { exitCode, output } = runChild([]);
    expect(output).not.toContain("Export named 'headers' not found");
    expect(output).toMatch(/^\s*2 pass$/m);
    expect(exitCode).toBe(0);
  }, 30_000);

  test("control: without the pin preload the same pair fails to link (the fixture reproduces the bug)", () => {
    const config = join(tmp, "bunfig.toml");
    writeFileSync(config, `[test]\npreload = [${JSON.stringify(join(ROOT, "src/test/happydom.ts"))}]\n`);
    const { exitCode, output } = runChild([`--config=${config}`]);
    expect(output).toContain("Export named 'headers' not found");
    expect(exitCode).not.toBe(0);
  }, 30_000);
});
