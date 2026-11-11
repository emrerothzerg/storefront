// Types the @testing-library/jest-dom matchers on bun:test's expect().
// jest-dom ships a bun.d.ts but does not export it, so the augmentation
// is declared here.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "bun:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation needs an interface to merge into bun's Matchers
  interface Matchers<T = unknown>
    extends TestingLibraryMatchers<
      ReturnType<typeof expect.stringContaining>,
      T
    > {}
}
