import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import { ContactForm, type ContactOrderOption } from "@/components/molecules/ContactForm";
import type { ContactActionFn } from "@/components/molecules/_contracts/contact-actions";
import { isAllowedInternalHref } from "@/content/routes";

export const CONTACT_SECTION_TITLE = "Contact us";
export const CONTACT_SECTION_HEADING_ID = "contact-heading";
export const CONTACT_SECTION_INTRO =
  "We reply within two business days. This demo store stores your message but does not send email.";
export const CONTACT_SECTION_HELP_HEADING = "Looking for something else?";

export interface ContactHelpLink {
  readonly label: string;
  readonly href: string;
}

export const DEFAULT_CONTACT_HELP_LINKS: readonly ContactHelpLink[] = [
  { label: "Help center", href: "/help" },
  { label: "FAQ", href: "/faq" },
  { label: "Your orders", href: "/orders" },
  { label: "Returns", href: "/returns" },
  { label: "Shipping", href: "/shipping" },
];

export interface ContactSectionProps {
  /** Contact server action (`sendContactMessage`). */
  action: ContactActionFn;
  /** The visitor's own orders (the page loads them); the order select shows only when non-empty. */
  orders?: readonly ContactOrderOption[];
  initialTopic?: string;
  initialOrderId?: string;
  productSlug?: string;
  signedInEmail?: string | null;
  /** 1 when the section is the page's main content (`/contact`), else 2 (default). */
  headingLevel?: 1 | 2;
  /** Defaults to "Contact us". */
  title?: string;
  /** Alternative help links; hrefs failing `isAllowedInternalHref` are omitted. */
  helpLinks?: readonly ContactHelpLink[];
  className?: string;
}

/**
 * Server-safe contact block: heading, honest intro copy, `ContactForm`
 * (which shows the reference-number success Notice itself) and an aside of
 * alternative help links. No JavaScript needed: the form posts its action.
 */
export function ContactSection({
  action,
  orders,
  initialTopic,
  initialOrderId,
  productSlug,
  signedInEmail,
  headingLevel = 2,
  title = CONTACT_SECTION_TITLE,
  helpLinks = DEFAULT_CONTACT_HELP_LINKS,
  className,
}: ContactSectionProps) {
  const links = helpLinks.filter((link) => isAllowedInternalHref(link.href));
  const helpHeadingId = `${CONTACT_SECTION_HEADING_ID}-help`;

  return (
    <section
      aria-labelledby={CONTACT_SECTION_HEADING_ID}
      className={["flex min-w-0 flex-col gap-6", className].filter(Boolean).join(" ")}
    >
      <div className="flex max-w-prose flex-col gap-2">
        <Heading level={headingLevel} id={CONTACT_SECTION_HEADING_ID}>
          {title}
        </Heading>
        <Text tone="secondary">{CONTACT_SECTION_INTRO}</Text>
      </div>
      <div className="grid min-w-0 gap-8 lg:grid-cols-3">
        <Card data-slot="contact-form-card" className="max-w-prose lg:col-span-2">
          <ContactForm
            action={action}
            orders={orders}
            initialTopic={initialTopic}
            initialOrderId={initialOrderId}
            productSlug={productSlug}
            signedInEmail={signedInEmail}
          />
        </Card>
        {links.length > 0 ? (
          <Card as="aside" tone="sunken" aria-labelledby={helpHeadingId} className="self-start">
            <Heading level={headingLevel === 1 ? 2 : 3} size="h4" id={helpHeadingId}>
              {CONTACT_SECTION_HELP_HEADING}
            </Heading>
            <ul className="mt-1 flex flex-col">
              {links.map((link) => (
                <li key={`${link.href}-${link.label}`}>
                  <Link href={link.href} variant="nav" className="break-words">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </section>
  );
}
