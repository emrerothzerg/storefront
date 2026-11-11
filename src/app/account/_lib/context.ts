import { unstable_rethrow } from "next/navigation";

import { readOwnerAndUser, type CurrentUser, type OwnerAndUser } from "@/server/session/current-user";
import { isSessionId } from "@/server/session/session-id";

/**
 * Who is looking at an account page, resolved once per render.
 *
 * - `ownerKey`: the owner key (signed-in user's `owner_key`, else the guest
 *   `sf_session` id, else null). SERVER-ONLY (R-1): never pass it to a
 *   component, URL, JSON or log.
 * - `user`: `{ id, email, displayName }` or null.
 *
 * Both come from `readOwnerAndUser()`: one auth-token lookup per render
 * (consistency at). Read-only: never mints or rotates a cookie (SR10,
 * criterion 1/6). With no cookie nothing touches the database.
 */
export interface AccountContext {
  readonly ownerKey: string | null;
  readonly user: CurrentUser | null;
}

export interface AccountContextDeps {
  readonly readOwnerAndUser: () => Promise<OwnerAndUser>;
}

const defaultDeps: AccountContextDeps = {
  readOwnerAndUser: () => readOwnerAndUser(),
};

const SIGNED_OUT: AccountContext = { ownerKey: null, user: null };

export async function loadAccountContext(deps: AccountContextDeps = defaultDeps): Promise<AccountContext> {
  let read: OwnerAndUser;
  try {
    read = await deps.readOwnerAndUser();
  } catch (error) {
    unstable_rethrow(error);
    return SIGNED_OUT;
  }
  const ownerKey = typeof read.ownerKey === "string" && isSessionId(read.ownerKey) ? read.ownerKey : null;
  return { ownerKey, user: read.user ?? null };
}
