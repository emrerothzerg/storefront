"use client";

import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/atoms/Button";
import { Disclosure } from "@/components/atoms/Disclosure";
import { Drawer } from "@/components/atoms/Drawer";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { cleanDisplayName, truncateDisplayName } from "@/lib/display-name";
import { ACCOUNT_NAV, AUTH_NAV, PRIMARY_NAV } from "@/content/navigation";
import { buildMenuModel } from "./menu-model";
import type { DepartmentInput, MenuLink } from "./menu-model";

export interface DepartmentMenuProps {
  /** Departments with their child categories (two levels; deeper levels are ignored). */
  departments: readonly DepartmentInput[];
  /** Defaults to `PRIMARY_NAV`. */
  primaryNav?: readonly MenuLink[];
  /** Links for signed-in visitors. Defaults to `ACCOUNT_NAV`. */
  accountNav?: readonly MenuLink[];
  /** Links for signed-out visitors. Defaults to `AUTH_NAV`. */
  authNav?: readonly MenuLink[];
  /**
   * Signed-in display name; `null`/empty = signed out. Rendered as text,
   * cleaned like the header link (`cleanDisplayName`) and visibly truncated to
   * 20 code points (`truncateDisplayName`); the full name stays in the
   * heading's accessible name.
   */
  signedInName?: string | null;
  /** Visible trigger text. Defaults to "All". */
  label?: string;
  className?: string;
}

/** Catalog link used as the trigger before hydration (and without JS). */
export const DEPARTMENT_MENU_FALLBACK_HREF = "/products";
/**
 * Accessible name of the departments `<nav>` inside the drawer. Unique per
 * page: CategoryNav (the desktop row) is "Primary".
 */
export const DEPARTMENT_MENU_NAV_LABEL = "Departments";

const noopSubscribe = () => () => {};

function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * "All" menu (T64). Without JS (and in server HTML) the trigger is a plain
 * link to the catalog (`/products`), so the static markup always reaches
 * every department. After hydration it becomes a button that opens a left
 * `Drawer` ("Shop by department") with departments as `Disclosure`s (child
 * category links inside, two levels), the primary nav and the account or
 * sign-in links. Escape, the Close button, a backdrop click and activating
 * any link close it; the Drawer locks scroll and returns focus to the trigger.
 * Phase 3 (T143): the mobile all-departments menu (CategoryNav is the desktop
 * row); pill trigger, departments inside `<nav aria-label="Departments">`.
 */
export function DepartmentMenu({
  departments,
  primaryNav = PRIMARY_NAV,
  accountNav = ACCOUNT_NAV,
  authNav = AUTH_NAV,
  signedInName = null,
  label = "All",
  className,
}: DepartmentMenuProps) {
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const headingId = useId();

  // Same cleaning and 20-code-point visible cap as the header account link (bd);
  // the full name stays in the heading's accessible name.
  const name = cleanDisplayName(signedInName);
  const signedIn = name !== "";
  const visibleName = signedIn ? truncateDisplayName(name) : "";

  const model = useMemo(
    () => buildMenuModel({ departments, primaryNav, accountNav: signedIn ? accountNav : authNav }),
    [departments, primaryNav, accountNav, authNav, signedIn],
  );

  const rejectedKey = model.rejected.join("\n");
  useEffect(() => {
    if (rejectedKey !== "" && process.env.NODE_ENV !== "production") {
      console.warn(`DepartmentMenu: omitted links with disallowed hrefs:\n${rejectedKey}`);
    }
  }, [rejectedKey]);

  const close = () => setOpen(false);
  const visibleLabel = label.trim() === "" ? "All" : label;

  if (!hydrated) {
    return (
      <Link
        href={DEPARTMENT_MENU_FALLBACK_HREF}
        variant="nav"
        className={["gap-2 rounded-full px-3 font-semibold hover:bg-surface-sunken", className].filter(Boolean).join(" ")}
      >
        <Icon name="menu" size="md" />
        <span>{visibleLabel}</span>
        <VisuallyHidden> products</VisuallyHidden>
      </Link>
    );
  }

  const sectionHeading = "text-small font-semibold text-text-secondary";

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={className}
      >
        <Icon name="menu" size="md" />
        <VisuallyHidden>Open menu, </VisuallyHidden>
        <span>{visibleLabel}</span>
      </Button>
      <Drawer open={open} onClose={close} side="left" title="Shop by department">
        <div className="flex min-w-0 flex-col gap-6">
          {model.departments.length > 0 ? (
            <nav aria-label={DEPARTMENT_MENU_NAV_LABEL}>
              <ul role="list" className="flex flex-col">
                {model.departments.map((dept) => (
                  <li key={dept.id}>
                    <Disclosure summary={dept.name} summaryClassName="rounded-md px-2 hover:bg-surface-sunken">
                      <ul role="list" className="flex flex-col ps-2">
                        {dept.allHref !== null ? (
                          <li>
                            <Link href={dept.allHref} variant="nav" onClick={close} className="break-words">
                              {`All ${dept.name}`}
                            </Link>
                          </li>
                        ) : null}
                        {dept.children.map((child) => (
                          <li key={child.href}>
                            <Link href={child.href} variant="nav" onClick={close} className="break-words">
                              {child.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  </li>
                ))}
              </ul>
            </nav>
          ) : (
            <Link href={DEPARTMENT_MENU_FALLBACK_HREF} variant="nav" onClick={close}>
              All products
            </Link>
          )}
          {model.primary.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-border-default pt-4">
              <h3 id={`${headingId}-primary`} className={sectionHeading}>
                Quick links
              </h3>
              <ul role="list" aria-labelledby={`${headingId}-primary`} className="flex flex-col">
                {model.primary.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} variant="nav" onClick={close} className="break-words">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-col gap-1 border-t border-border-default pt-4">
            <h3 id={`${headingId}-account`} className={`${sectionHeading} break-words`}>
              {!signedIn ? (
                "Your account"
              ) : visibleName === name ? (
                `Hello, ${name}`
              ) : (
                <>
                  <span aria-hidden="true">{`Hello, ${visibleName}`}</span>
                  <VisuallyHidden>{`Hello, ${name}`}</VisuallyHidden>
                </>
              )}
            </h3>
            {model.account.length > 0 ? (
              <ul role="list" aria-labelledby={`${headingId}-account`} className="flex flex-col">
                {model.account.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} variant="nav" onClick={close} className="break-words">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </Drawer>
    </>
  );
}
