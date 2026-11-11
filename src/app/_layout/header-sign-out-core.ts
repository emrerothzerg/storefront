import type { AuthActionFn } from "@/components/molecules/_contracts/auth-actions";
import { initialAuthActionState } from "@/components/molecules/_contracts/auth-actions";

/**
 * Logic behind the header's "Sign out" form (T80). Delegates to `signOut`
 * from `src/app/actions/auth.ts`, which revokes the session, clears
 * `sf_auth`, rotates `sf_session`, revalidates and throws Next's redirect to
 * `/`. The redirect (and any other error) propagates unchanged.
 *
 * `auth.ts` is loaded lazily, at submit time: importing the root layout must
 * not evaluate it (it imports `headers` from `next/headers` at module scope,
 * which some suites mock without that export).
 */
export type LoadSignOut = () => Promise<{ readonly signOut: AuthActionFn }>;

export const loadAuthSignOut: LoadSignOut = () => import("@/app/actions/auth");

export async function runHeaderSignOut(formData: FormData, load: LoadSignOut = loadAuthSignOut): Promise<void> {
  const { signOut } = await load();
  // signOut redirects on every path; a returned state (never expected) is ignored.
  await signOut(initialAuthActionState, formData);
}
