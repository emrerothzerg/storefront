import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { ToastProvider } from "@/components/atoms/Toast";
import { JsonLd } from "@/components/molecules/JsonLd";
import { SiteFooter } from "@/components/organisms/SiteFooter";
import { FOOTER_COLUMNS } from "@/content/navigation";
import { organizationJsonLd, webSiteJsonLd } from "@/lib/seo/json-ld";
import { OG_LOCALE } from "@/lib/seo/metadata";
import { SITE_DESCRIPTION, SITE_NAME, THEME_COLOR, getSiteUrl } from "@/lib/seo/site";

import { HeaderShell } from "./_layout/HeaderShell";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl()),
  title: { default: SITE_NAME, template: `%s | ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: { type: "website", siteName: SITE_NAME, locale: OG_LOCALE },
  robots: { index: true, follow: true },
};

/**
 * Light only (Phase 3): a single theme colour, the documented primary raw
 * value from site.ts. No `colorScheme`, no per-media themeColor array and no
 * theme script; globals.css sets `color-scheme: light`.
 */
export const viewport: Viewport = {
  themeColor: THEME_COLOR,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-surface-page text-text-primary">
        {/* ToastProvider is a client boundary; server children still render on the server.
            It renders the single "Notifications" toast viewport after the page. */}
        <ToastProvider>
          {/* Reads the session/auth cookies, so every route renders dynamically per request.
              No Suspense around it and no loading.tsx (soft-404 decision, STATE.md). */}
          <HeaderShell />
          <main id="main" tabIndex={-1} className="flex-1 mx-auto w-full max-w-7xl px-4 py-8">
            {children}
          </main>
          <SiteFooter storeName={SITE_NAME} columns={FOOTER_COLUMNS} />
        </ToastProvider>
        <JsonLd data={[organizationJsonLd(), webSiteJsonLd()]} />
      </body>
    </html>
  );
}
