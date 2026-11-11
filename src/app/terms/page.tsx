import type { Metadata } from "next";

import { getPolicy, policyBreadcrumb, policyBreadcrumbJsonLd, policyMetadata } from "@/app/_lib/policy-page";
import { JsonLd } from "@/components/molecules/JsonLd";
import { StaticPage } from "@/components/templates/StaticPage";

export const metadata: Metadata = policyMetadata("terms");

/** `/terms` (T102): static content from `src/content/policies.ts`. */
export default function TermsPolicyPage() {
  const page = getPolicy("terms");
  return (
    <>
      <StaticPage
        title={page.title}
        breadcrumb={policyBreadcrumb(page)}
        sections={page.sections}
        lastUpdated={page.lastUpdated}
        sampleNotice={page.sampleNotice}
      />
      <JsonLd data={policyBreadcrumbJsonLd(page)} />
    </>
  );
}
