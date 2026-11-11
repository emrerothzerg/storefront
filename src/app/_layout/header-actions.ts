"use server";

import { runHeaderSignOut } from "./header-sign-out-core";

/**
 * Header "Sign out" Server Action (T80): `<form action={headerSignOut}>`.
 * Thin wrapper over `signOut` from `src/app/actions/auth.ts` (see
 * `header-sign-out-core.ts`). This file may only export async functions.
 */
export async function headerSignOut(formData: FormData): Promise<void> {
  await runHeaderSignOut(formData);
}
