import type { Metadata } from "next";

import { getPolicy, policyBreadcrumb, policyBreadcrumbJsonLd, policyMetadata } from "@/app/_lib/policy-page";
import { JsonLd } from "@/components/molecules/JsonLd";
import { StaticPage } from "@/components/templates/StaticPage";

export const metadata: Metadata = policyMetadata("accessibility");

/** `/accessibility` (T102): static content from `src/content/policies.ts`. */
export default function AccessibilityPolicyPage() {
  const page = getPolicy("accessibility");
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
