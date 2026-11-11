import { absoluteUrl } from "@/lib/seo/site";

// Lone UTF-16 surrogates make encodeURIComponent throw a URIError; replace
// them with U+FFFD so a corrupt product name can never crash the render.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Returns `value` with every unpaired surrogate replaced by U+FFFD. */
export function toWellFormed(value: string): string {
  return value.replace(LONE_SURROGATE, "�");
}

/** Absolute share URL: paths become absolute via `absoluteUrl`, absolute http(s) URLs pass through. */
export function resolveShareUrl(url: string): string {
  return absoluteUrl(url);
}

/**
 * `mailto:` href with an encoded subject and body. Subject is
 * `Check out <title>`, body is `<text ?? title>\n<url>`. Both parts go through
 * `encodeURIComponent`, so `&`, `?`, `#`, `=`, newlines and emoji in product
 * names stay inside their own parameter.
 */
export function buildMailtoHref(title: string, url: string, text?: string): string {
  const subject = toWellFormed(`Check out ${title}`);
  const body = toWellFormed(`${text ?? title}\n${url}`);
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
