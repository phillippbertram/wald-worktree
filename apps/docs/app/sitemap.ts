import type { MetadataRoute } from "next";
import { asset, siteUrl } from "../lib/site.mjs";
import { source } from "../lib/source.js";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl + asset("/") },
    ...source.getPages().map(({ url }) => ({
      url: siteUrl + asset(url.endsWith("/") ? url : `${url}/`),
    })),
  ];
}
