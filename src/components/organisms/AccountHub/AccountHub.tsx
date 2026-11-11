import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Heading, Text } from "@/components/atoms/Typography";
import type { HeadingLevel } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { isAllowedInternalHref } from "@/content/routes";
import { cleanDisplayName, truncateDisplayName } from "@/lib/display-name";
import type { AuthActionFn } from "@/components/molecules/_contracts/auth-actions";
import {
  STOCK_ALERT_FIELD,
  type StockAlertActionFn,
} from "@/components/molecules/_contracts/stock-alert-actions";
import {
  buildAccountHubCards,
  devWarn,
  isPostableAlertId,
  productHref,
  type AccountHubBackInStockItem,
  type AccountHubCard,
  type AccountHubCounts,
} from "./account-hub-model";

/**
 * The only user shape AccountHub accepts. Owner keys, session ids and secrets
 * are forbidden at the type level (R-1): a value carrying any of them does not
 * type-check, even when it is not an object literal. `CurrentUser` from
 * `readCurrentUser()` is accepted as-is; its `id` is never rendered.
 */
export interface AccountHubUser {
  readonly displayName: string;
  readonly email: string;
  readonly ownerKey?: never;
  readonly owner_key?: never;
  readonly sessionId?: never;
  readonly session_id?: never;
  readonly passwordHash?: never;
  readonly token?: never;
  readonly tokenHash?: never;
}

export interface AccountHubActions {
  /** `signOut` from `src/app/actions/auth.ts` (header-style sign out). */
  readonly signOut?: AuthActionFn;
  /** `acknowledgeStockAlert` from `src/app/actions/stock-alerts.ts`. */
  readonly acknowledgeAlert?: StockAlertActionFn;
}

export interface AccountHubProps {
  /** Signed-in user (`readCurrentUser()`), or null for a guest. */
  user: AccountHubUser | null;
  counts: AccountHubCounts;
  /** Unacknowledged back-in-stock alerts; map `listBackInStock` with `toBackInStockItems`. */
  backInStock: readonly AccountHubBackInStockItem[];
  actions?: AccountHubActions;
  /** Level of the "Your Account" heading. Default 1: the hub is the page heading. */
  headingLevel?: 1 | 2;
  className?: string;
}

/** Shown next to a back-in-stock item whose product is no longer offered (D-T98-4). */
export const NO_LONGER_AVAILABLE_TEXT = "No longer available";

export const GUEST_NOTICE_TEXT =
  "Your guest data is device-bound until you sign in. Clearing cookies or switching device starts fresh.";

const SETTINGS_HREF = "/account/settings";
const SIGN_IN_HREF = "/signin";
const SIGN_UP_HREF = "/signup";

type FormAction = (formData: FormData) => void | Promise<void>;

/**
 * Binds `prevState = null` so a `(prevState, formData)` action can be used as
 * a plain `<form action>` (server references support `.bind`). The returned
 * state is ignored here: sign out redirects, acknowledge revalidates.
 */
function asFormAction(fn: (prev: null, formData: FormData) => Promise<unknown>): FormAction {
  return fn.bind(null, null) as FormAction;
}

function safeHref(href: string, label: string): string | null {
  if (isAllowedInternalHref(href)) return href;
  devWarn(`dropped link "${label}" with disallowed href "${href}".`);
  return null;
}

/**
 * "Hello, <name>" for the signed-in header (D-T87-1): the stored name is
 * cleaned like the site header (`cleanDisplayName`: bidi/format characters
 * dropped, control runs collapsed) and visibly capped at 20 code points
 * (`truncateDisplayName`); when shortened, the full cleaned name stays in the
 * accessible text. A name that cleans to "" reads "Hello".
 */
function Greeting({ displayName }: { displayName: string }) {
  const name = cleanDisplayName(displayName);
  if (name === "") return <>Hello</>;
  const visible = truncateDisplayName(name);
  if (visible === name) return <>{`Hello, ${name}`}</>;
  return (
    <>
      <span aria-hidden="true">{`Hello, ${visible}`}</span>
      <VisuallyHidden>{`Hello, ${name}`}</VisuallyHidden>
    </>
  );
}

/** Decorative user glyph in a light-blue circle (header panels). */
function AvatarIcon() {
  return (
    <span
      aria-hidden="true"
      className="flex size-touch shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent"
    >
      <Icon name="user" size="lg" />
    </span>
  );
}

function SignedInHeader({ user, signOut }: { user: AccountHubUser; signOut?: AuthActionFn }) {
  const settingsHref = safeHref(SETTINGS_HREF, "Login & security");
  return (
    <Card
      data-slot="account-hub-header"
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <AvatarIcon />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="min-w-0 break-words text-h3">
            <Greeting displayName={user.displayName} />
          </p>
          <Text variant="small" tone="secondary" className="min-w-0 break-all">
            {user.email}
          </Text>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {settingsHref !== null ? (
          <Link href={settingsHref} variant="nav" className="gap-2">
            <Icon name="lock" size="sm" />
            Login &amp; security
          </Link>
        ) : null}
        {signOut !== undefined ? (
          <form action={asFormAction(signOut)} className="flex">
            <Button type="submit" variant="secondary">
              Sign out
            </Button>
          </form>
        ) : null}
      </div>
    </Card>
  );
}

function GuestHeader() {
  const signIn = safeHref(SIGN_IN_HREF, "Sign in");
  const signUp = safeHref(SIGN_UP_HREF, "Create account");
  return (
    <Card data-slot="account-hub-header" className="flex flex-col gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <AvatarIcon />
        <p className="min-w-0 break-words text-h3">Hello, shopper</p>
      </div>
      <Notice tone="info">{GUEST_NOTICE_TEXT}</Notice>
      {signIn !== null || signUp !== null ? (
        <div className="flex min-w-0 flex-wrap gap-3">
          {signIn !== null ? (
            <Link href={signIn} variant="button">
              Sign in
            </Link>
          ) : null}
          {signUp !== null ? (
            <Link href={signUp} variant="button" buttonVariant="outline">
              Create account
            </Link>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function BackInStockNotice({
  items,
  acknowledge,
}: {
  items: readonly AccountHubBackInStockItem[];
  acknowledge?: StockAlertActionFn;
}) {
  const formAction = acknowledge !== undefined ? asFormAction(acknowledge) : null;
  return (
    <Notice tone="success" title="Back in stock:">
      <ul className="flex min-w-0 flex-col gap-2">
        {items.map((item, index) => {
          const unavailable = item.available === false;
          const href = unavailable ? null : productHref(item.productSlug);
          if (href === null && !unavailable) {
            devWarn("back-in-stock item has an invalid product slug; rendered without a link.");
          }
          const canAck = formAction !== null && isPostableAlertId(item.alertId);
          return (
            <li
              // Index keys (React keys are never rendered). Opaque server ids such as the alert id may
              // appear in attributes (the hidden input below, R-T87-3); PII (names, emails, addresses,
              // phones, owner keys, session ids, tokens) may not (criterion 4).
              key={index}
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
            >
              {href !== null ? (
                <Link href={href} variant="inline" className="inline-flex min-h-touch items-center font-semibold min-w-0 break-words">
                  {item.productName}
                </Link>
              ) : (
                <span className="min-w-0 break-words">{item.productName}</span>
              )}
              {unavailable ? (
                <Text as="span" variant="small" tone="secondary">
                  {NO_LONGER_AVAILABLE_TEXT}
                </Text>
              ) : null}
              {canAck ? (
                <form action={formAction} className="flex">
                  <input type="hidden" name={STOCK_ALERT_FIELD.alertId} value={item.alertId} />
                  {href !== null ? (
                    <input type="hidden" name={STOCK_ALERT_FIELD.productSlug} value={item.productSlug} />
                  ) : null}
                  <Button type="submit" variant="ghost" size="sm">
                    Acknowledge
                    <VisuallyHidden>{` back-in-stock alert for ${item.productName}`}</VisuallyHidden>
                  </Button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Notice>
  );
}

function HubCard({ card, level }: { card: AccountHubCard; level: HeadingLevel }) {
  return (
    <Link
      href={card.href}
      variant="nav"
      className="h-full w-full gap-3 rounded-lg p-4"
    >
      <span className="flex size-touch shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent">
        <Icon name={card.icon} size="lg" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <Heading level={level} size="h4" className="min-w-0 break-words">
          {card.title}
        </Heading>
        <Text as="span" variant="small" tone="secondary" className="min-w-0 break-words">
          {card.description}
        </Text>
      </span>
    </Link>
  );
}

/**
 * "Your Account" hub (T87). Server-safe and presentational: all data arrives
 * via props, mutations are plain `<form action>` posts that work without JS.
 */
export function AccountHub({
  user,
  counts,
  backInStock,
  actions,
  headingLevel = 1,
  className,
}: AccountHubProps) {
  const cards = buildAccountHubCards(counts);
  const cardLevel = (headingLevel + 1) as HeadingLevel;
  const classes = ["flex min-w-0 flex-col gap-6", className].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      <Heading level={headingLevel} size="h1">
        Your Account
      </Heading>
      {backInStock.length > 0 ? (
        <BackInStockNotice items={backInStock} acknowledge={actions?.acknowledgeAlert} />
      ) : null}
      {user !== null ? <SignedInHeader user={user} signOut={actions?.signOut} /> : <GuestHeader />}
      {cards.length > 0 ? (
        <ul
          aria-label="Account sections"
          className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {cards.map((card) => (
            <Card as="li" key={card.key} padding="none" interactive className="flex">
              <HubCard card={card} level={cardLevel} />
            </Card>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
