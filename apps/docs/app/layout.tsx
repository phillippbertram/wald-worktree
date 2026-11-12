import { RootProvider } from "fumadocs-ui/provider/next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { asset, basePath, brand, description, siteUrl } from "../lib/site.mjs";
import "./global.css";

const title = `${brand} — Git worktrees, ready for real work`;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: title, template: `%s | ${brand}` },
  description,
  icons: { icon: asset("/wald.svg") },
  openGraph: {
    type: "website",
    siteName: brand,
    title,
    description,
    url: `${basePath}/`,
    images: [{ url: asset("/media/wald-social.jpg"), width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ options: { type: "static", api: asset("/search-index.json") } }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
