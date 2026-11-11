import type { Metadata } from "next";

import { sendContactMessage } from "@/app/actions/contact";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { JsonLd } from "@/components/molecules/JsonLd";
import { ContactSection } from "@/components/organisms/ContactSection";
import { breadcrumbListJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";

import { CONTACT_DESCRIPTION, CONTACT_PATH, CONTACT_TITLE, loadContactPage } from "./_lib/contact-page";

/** Not indexed (it can echo order context); the canonical stays `/contact`. */
export const metadata: Metadata = buildMetadata({
  title: CONTACT_TITLE,
  description: CONTACT_DESCRIPTION,
  path: CONTACT_PATH,
  noindex: true,
});

export interface ContactPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Contact form page. Reads the session read-only (no cookie is ever set
 * during render); the order select lists only the visitor's own orders and
 * is absent for visitors without a session.
 */
export default async function ContactPage({ searchParams }: ContactPageProps) {
  const data = await loadContactPage(await searchParams);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: CONTACT_TITLE }]} />
      <ContactSection
        action={sendContactMessage}
        headingLevel={1}
        title={CONTACT_TITLE}
        orders={data.orders}
        initialTopic={data.initialTopic}
        initialOrderId={data.initialOrderId}
        productSlug={data.productSlug}
        signedInEmail={data.signedInEmail}
      />
      <JsonLd
        data={breadcrumbListJsonLd([
          { name: "Home", path: "/" },
          { name: CONTACT_TITLE, path: CONTACT_PATH },
        ])}
      />
    </div>
  );
}
