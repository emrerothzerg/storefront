import { describe, expect, test } from "bun:test";
import { ICON_NAMES } from "@/components/atoms/Icon/Icon";
import { getFaqEntry } from "./faq";
import {
  HELP_TOPICS,
  HELP_TOPIC_ICONS,
  HELP_TOPIC_SLUGS,
  getHelpTopic,
  helpTopicHref,
  isHelpTopicSlug,
} from "./help-topics";
import { isAllowedInternalHref } from "./routes";

describe("HELP_TOPICS", () => {
  test("has 8 topics, one per slug, in slug order", () => {
    expect(HELP_TOPICS).toHaveLength(8);
    expect(HELP_TOPICS.map((topic) => topic.slug)).toEqual([...HELP_TOPIC_SLUGS]);
  });

  test("every topic has a title, summary and an icon from the atoms Icon set", () => {
    const iconNames: readonly string[] = ICON_NAMES;
    for (const icon of HELP_TOPIC_ICONS) expect(iconNames).toContain(icon);
    for (const topic of HELP_TOPICS) {
      expect(topic.title.trim().length).toBeGreaterThan(0);
      expect(topic.summary.trim().length).toBeGreaterThan(0);
      expect(HELP_TOPIC_ICONS).toContain(topic.icon);
    }
  });

  test("every faqSlugs reference resolves to an FAQ of the same topic, with at least 2 per topic", () => {
    for (const topic of HELP_TOPICS) {
      expect(topic.faqSlugs.length).toBeGreaterThanOrEqual(2);
      expect(new Set(topic.faqSlugs).size).toBe(topic.faqSlugs.length);
      for (const slug of topic.faqSlugs) {
        const entry = getFaqEntry(slug);
        expect(entry, `${topic.slug} -> ${slug}`).toBeDefined();
        expect(entry?.topic).toBe(topic.slug);
      }
    }
  });

  test("topic links are allowed routes", () => {
    expect(isAllowedInternalHref("/help")).toBe(true);
    for (const topic of HELP_TOPICS) {
      const href = helpTopicHref(topic.slug);
      expect(href).toBe(`/help/${topic.slug}`);
      expect(isAllowedInternalHref(href)).toBe(true);
    }
  });
});

describe("getHelpTopic / isHelpTopicSlug", () => {
  test("finds known topics and rejects unknown ones", () => {
    expect(getHelpTopic("shipping")?.title).toBe("Shipping and delivery");
    expect(getHelpTopic("nope")).toBeUndefined();
    expect(getHelpTopic("")).toBeUndefined();
    expect(getHelpTopic("__proto__")).toBeUndefined();
    expect(isHelpTopicSlug("returns")).toBe(true);
    expect(isHelpTopicSlug("Returns")).toBe(false);
  });
});
