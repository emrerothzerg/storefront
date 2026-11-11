import type { JsonLdThing } from "@/lib/seo/json-ld";

export interface JsonLdProps {
  /** One JSON-LD document or several (rendered as one JSON array). */
  readonly data: JsonLdThing | readonly JsonLdThing[];
}

const UNSAFE_CHARACTERS: Readonly<Record<string, string>> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/**
 * JSON-serialises `data` for an inline `<script type="application/ld+json">`.
 * `<`, `>` and `&` (and the JS line separators) become `\uXXXX` escapes, so
 * untrusted text such as a product name containing `</script>` or `<!--`
 * can never end the script element; JSON parsers decode them back.
 */
export function serializeJsonLd(data: JsonLdProps["data"]): string {
  return JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (char) => UNSAFE_CHARACTERS[char] ?? char);
}

/**
 * Server-safe structured data. Renders nothing for an empty array. Build the
 * documents with the typed builders in `@/lib/seo/json-ld`.
 */
function isList(data: JsonLdProps["data"]): data is readonly JsonLdThing[] {
  return Array.isArray(data);
}

export function JsonLd({ data }: JsonLdProps) {
  if (isList(data) && data.length === 0) return null;
  const payload: JsonLdProps["data"] = isList(data) && data.length === 1 && data[0] ? data[0] : data;
  return (
    <script
      type="application/ld+json"
      // Safe: serializeJsonLd escapes every character that could close the tag.
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(payload) }}
    />
  );
}
