"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Disclosure } from "@/components/atoms/Disclosure";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { cleanDisplayName, truncateDisplayName } from "./header-model";
import type { HeaderLink } from "./header-model";

/** `<form action>` signature (result ignored). */
export type HeaderSignOutAction = (formData: FormData) => void;

export type HeaderAccount =
  | { readonly status: "guest" }
  | {
      readonly status: "signed-in";
      /** Rendered as text only; truncated to 20 characters visibly, full in the accessible name. */
      readonly displayName: string;
      /** Posted by the "Sign out" button. The layout passes `headerSignOut` (wraps `signOut` from `src/app/actions/auth.ts`). */
      readonly signOutAction: HeaderSignOutAction;
    };

export interface AccountMenuProps {
  account: HeaderAccount;
  /** Signed-in links (already allowlist-filtered by SiteHeader). */
  accountNav: readonly HeaderLink[];
  /** Guest links (already allowlist-filtered by SiteHeader). */
  authNav: readonly HeaderLink[];
}

export const ACCOUNT_LINK_HREF = "/account";
export const SIGN_IN_HREF = "/signin";
export const ACCOUNT_MENU_LABEL = "Account menu";

/**
 * "Hello, <name>" / "Hello, Sign in" block (T80 criteria 3 and 7).
 *
 * Two controls side by side:
 * 1. A plain link (`/account` signed in, `/signin` for guests): the no-JS
 *    path and the main target.
 * 2. A `Disclosure` (native `<details>`) "Account menu" whose panel lists
 *    the account or auth links (and the Sign out form). It opens with
 *    Enter/Space natively, also without JS; with JS it closes on Escape
 *    (focus returns to the summary), on a pointer press outside it and when a
 *    panel link is activated (layouts do not re-render on client navigation).
 *
 * The panel is positioned against the nearest positioned ancestor (the
 * header row in SiteHeader): full width under the row on small screens,
 * right-aligned from `sm`.
 */
export function AccountMenu({ account, accountNav, authNav }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      detailsRef.current?.querySelector("summary")?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && detailsRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const signedIn = account.status === "signed-in";
  const fullName = signedIn ? cleanDisplayName(account.displayName) : "";
  const hasName = fullName !== "";
  const greetingName = hasName ? fullName : signedIn ? "there" : "Sign in";
  const visibleName = hasName ? truncateDisplayName(fullName) : greetingName;
  const href = signedIn ? ACCOUNT_LINK_HREF : SIGN_IN_HREF;
  const links = signedIn ? accountNav : authNav;
  const close = () => setOpen(false);

  return (
    <div className="flex min-w-0 items-center">
      <Link href={href} variant="nav" className="min-w-0 flex-col items-start gap-0 rounded-lg py-1 ps-3 pe-1 hover:bg-surface-sunken">
        <span className="sr-only">{`Hello, ${greetingName}, Account & Lists`}</span>
        <span aria-hidden="true" className="flex min-w-0 items-center gap-1 text-small text-text-secondary break-words">
          <Icon name="user" size="sm" />
          <span className="min-w-0 break-words">{`Hello, ${visibleName}`}</span>
        </span>
        <span aria-hidden="true" className="text-small font-semibold">
          Account &amp; Lists
        </span>
      </Link>
      <Disclosure
        ref={detailsRef}
        open={open}
        onOpenChange={setOpen}
        className="h-touch border-b-0"
        // flex-row-reverse puts the chevron at the start of the 44px target, right
        // next to "Account & Lists" (U16); the summary's name is unchanged.
        summaryClassName="min-w-touch flex-row-reverse"
        summary={<VisuallyHidden>{ACCOUNT_MENU_LABEL}</VisuallyHidden>}
        data-testid="account-menu"
      >
        <div className="absolute inset-x-4 top-full z-dropdown mt-1 flex min-w-0 flex-col gap-2 rounded-md border border-border-strong bg-surface-raised p-4 shadow-md sm:inset-x-auto sm:end-4 sm:w-72">
          <p className="text-small font-semibold text-text-secondary break-words">
            {signedIn ? "Your Account" : "New here or returning?"}
          </p>
          {links.length > 0 ? (
            <ul role="list" aria-label={signedIn ? "Your account" : "Sign in or create an account"} className="flex flex-col">
              {links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} variant="nav" onClick={close} className="break-words">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          {account.status === "signed-in" ? (
            <form action={account.signOutAction} className="border-t border-border-default pt-2">
              <Button type="submit" variant="secondary" size="sm" fullWidth>
                Sign out
              </Button>
            </form>
          ) : null}
        </div>
      </Disclosure>
    </div>
  );
}
