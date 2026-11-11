"use client";

import { useEffect } from "react";

import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";

interface ErrorPageProps {
  /** The thrown value. Server errors arrive as `Error` with a `digest`; never shown to the user. */
  error: unknown;
  /** Re-fetches and re-renders the segment (Next 16 preferred recovery). */
  retry: () => void;
  /** Re-renders without re-fetching. */
  reset: () => void;
}

function digestOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "digest" in error) {
    const { digest } = error as { digest: unknown };
    return typeof digest === "string" ? digest : undefined;
  }
  return undefined;
}

export default function ErrorPage({ error, retry }: ErrorPageProps) {
  useEffect(() => {
    // Only the digest is logged: it matches the server log without leaking details.
    console.error("[error boundary] digest:", digestOf(error) ?? "(none)");
  }, [error]);

  return (
    <div className="py-6 sm:py-10">
      <Card as="section" padding="lg" radius="xl" className="flex flex-col items-start gap-4">
        <Heading level={1}>Something went wrong</Heading>
        <Text tone="secondary">
          We could not load this page. Please try again, go back to the catalog, or search the store.
        </Text>
        <div className="flex flex-wrap items-center gap-4">
          <Button type="button" onClick={() => retry()}>
            Try again
          </Button>
          <Link href="/" variant="button" buttonVariant="outline">
            Back to the catalog
          </Link>
          <Link href="/search" variant="button" buttonVariant="outline">
            Search the store
          </Link>
        </div>
      </Card>
    </div>
  );
}
