import type { Metadata } from "next";

import { signUp } from "@/app/actions/auth";
import {
  SIGN_UP_DESCRIPTION,
  SIGN_UP_PATH,
  SIGN_UP_TITLE,
  loadAuthPage,
  type AuthPageSearchParams,
} from "@/app/_lib/auth-pages";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { Card } from "@/components/atoms/Card";
import { Heading } from "@/components/atoms/Typography";
import { SignUpForm } from "@/components/molecules/SignUpForm";
import { buildMetadata } from "@/lib/seo/metadata";

/** Never indexed (T127 criterion 1/6). */
export const metadata: Metadata = buildMetadata({
  title: SIGN_UP_TITLE,
  description: SIGN_UP_DESCRIPTION,
  path: SIGN_UP_PATH,
  noindex: true,
});

export interface SignUpPageProps {
  readonly searchParams: Promise<AuthPageSearchParams>;
}

/**
 * `/signup`. Signed-in visitors are redirected to the sanitised `next` or
 * `/account`; guests get the form, which receives only the sanitised `next`
 * and renders the "Sign in" cross-link itself.
 */
export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const { next } = await loadAuthPage(await searchParams);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: SIGN_UP_TITLE }]} />
      <Card padding="lg" className="mx-auto flex w-full max-w-md flex-col gap-6">
        <Heading level={1}>{SIGN_UP_TITLE}</Heading>
        <SignUpForm action={signUp} next={next} />
      </Card>
    </div>
  );
}
