/**
 * Shared helpers for the six policy and company routes (T102): `/about`,
 * `/shipping`, `/returns`, `/privacy`, `/terms`, `/accessibility`. Each
 * route's `page.tsx` stays a thin renderer of `StaticPage` from
 * `src/content/policies.ts`; metadata, breadcrumb and JSON-LD come from here.
 */

import type { Metadata } from "next";

import { POLICY_PAGES, SAMPLE_POLICY_NOTICE, policyHref, type PolicyPage, type PolicySlug } from "@/content/policies";
import { breadcrumbListJsonLd, type BreadcrumbListJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";

export interface PolicyBreadcrumbItem {
  readonly label: string;
  readonly href?: string;
}

export function getPolicy(slug: PolicySlug): PolicyPage {
  return POLICY_PAGES[slug];
}

/**
 * Meta description: the first content paragraph that is not the sample
 * notice (buildMetadata truncates it to 160 characters).
 */
export function policyDescription(page: PolicyPage): string {
  for (const section of page.sections) {
    for (const paragraph of section.paragraphs) {
      if (paragraph !== SAMPLE_POLICY_NOTICE && paragraph.trim() !== "") return paragraph;
    }
  }
  return page.title;
}

export function policyMetadata(slug: PolicySlug): Metadata {
  const page = getPolicy(slug);
  return buildMetadata({
    title: page.title,
    description: policyDescription(page),
    path: policyHref(slug),
  });
}

export function policyBreadcrumb(page: PolicyPage): PolicyBreadcrumbItem[] {
  return [{ label: "Home", href: "/" }, { label: page.title }];
}

export function policyBreadcrumbJsonLd(page: PolicyPage): BreadcrumbListJsonLd {
  return breadcrumbListJsonLd([
    { name: "Home", path: "/" },
    { name: page.title, path: policyHref(page.slug) },
  ]);
}
