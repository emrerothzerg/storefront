/// <reference lib="dom" />
// Preloaded by bun test after happydom.ts (see bunfig.toml). Adds the
// @testing-library/jest-dom matchers to bun:test's expect, unmounts rendered
// trees after every test, and reports test files that leave a React async
// action pending (see react-action-leak.ts and README.md).
import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { asyncActionsSettle, leakMessage } from "./react-action-leak";

expect.extend(matchers);

// Safety net (orchestrator glue, 2026-11-07): tests must never open the dev
// database in ./data. Any test file that forgets to set DATABASE_PATH gets an
// in-memory database instead. Tests that deliberately exercise the default
// path unset the variable inside their own test body, after this hook runs.
const MEMORY_DB = ":memory:";
if (process.env.DATABASE_PATH === undefined || process.env.DATABASE_PATH.trim() === "") {
  process.env.DATABASE_PATH = MEMORY_DB;
}

// Hooks registered in a preload run for every test of every file, except
// beforeAll/afterAll, which run once per bun process. A change of Bun.main
// (the running test file) in beforeEach therefore marks a file boundary.
const LEAK_SETTLE_TIMEOUT_MS = 250;
let currentFile: string | undefined;
// After one leak every later probe in this process would also stay pending,
// so only the first culprit is reported.
let leakReported = false;

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function checkFileLeftNoPendingAction(file: string): Promise<void> {
  if (leakReported) return;
  const previousActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT;
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    if (!(await asyncActionsSettle(LEAK_SETTLE_TIMEOUT_MS))) {
      leakReported = true;
      console.error(leakMessage(file));
    }
  } finally {
    actEnv.IS_REACT_ACT_ENVIRONMENT = previousActEnv;
  }
}

beforeEach(async () => {
  if (process.env.DATABASE_PATH === undefined || process.env.DATABASE_PATH.trim() === "") {
    process.env.DATABASE_PATH = MEMORY_DB;
  }
  const file = Bun.main;
  if (file !== currentFile) {
    if (currentFile !== undefined) await checkFileLeftNoPendingAction(currentFile);
    currentFile = file;
  }
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  if (currentFile !== undefined) await checkFileLeftNoPendingAction(currentFile);
});
