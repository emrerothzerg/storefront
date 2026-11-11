// Preloaded by bun test after setup.ts (see bunfig.toml).
//
// mock.module is process-wide in bun test and, once a module specifier has
// been mocked, later mock.module calls for it cannot add export names the
// first mock did not have. Many test files mock next/headers with only
// `cookies`; any later file in the same bun process whose code imports
// `headers` then fails to load with "SyntaxError: Export named 'headers' not
// found in module .../next/headers.js" (which file wins depends on file
// order, so it shows up or not depending on how files are grouped).
//
// Registering each commonly mocked Next module here, with the real module's
// own exports, pins the full export list before any test file runs. Files that
// do not mock these modules still get the real functions; files that do mock
// them behave as before, minus the order-dependent load failure.
import { mock } from "bun:test";

const nextHeaders = { ...(await import("next/headers")) };
const nextCache = { ...(await import("next/cache")) };
const nextNavigation = { ...(await import("next/navigation")) };
const nextServer = { ...(await import("next/server")) };

mock.module("next/headers", () => nextHeaders);
mock.module("next/cache", () => nextCache);
mock.module("next/navigation", () => nextNavigation);
mock.module("next/server", () => nextServer);
