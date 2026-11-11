import type { Metadata } from "next";

import { signIn } from "@/app/actions/auth";
import {
  SIGN_IN_DESCRIPTION,
  SIGN_IN_PATH,
  SIGN_IN_TITLE,
  loadAuthPage,
  type AuthPageSearchParams,
} from "@/app/_lib/auth-pages";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { Card } from "@/components/atoms/Card";
import { Heading } from "@/components/atoms/Typography";
import { SignInForm } from "@/components/molecules/SignInForm";
import { buildMetadata } from "@/lib/seo/metadata";

/** Never indexed (T127 criterion 1/6). */
export const metadata: Metadata = buildMetadata({
  title: SIGN_IN_TITLE,
  description: SIGN_IN_DESCRIPTION,
  path: SIGN_IN_PATH,
  noindex: true,
});

export interface SignInPageProps {
  readonly searchParams: Promise<AuthPageSearchParams>;
}

/**
 * `/signin`. Signed-in visitors are redirected to the sanitised `next` or
 * `/account`; guests (including a garbage or revoked `sf_auth`) get the form.
 * The form receives only the sanitised `next` and renders the "Create
 * account" cross-link and the password-reset notice itself.
 */
export default async function SignInPage({ searchParams }: SignInPageProps) {
  const { next } = await loadAuthPage(await searchParams);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: SIGN_IN_TITLE }]} />
      <Card padding="lg" className="mx-auto flex w-full max-w-md flex-col gap-6">
        <Heading level={1}>{SIGN_IN_TITLE}</Heading>
        <SignInForm action={signIn} next={next} />
      </Card>
    </div>
  );
}
