import { createMDX } from "fumadocs-mdx/next";
import { basePath } from "./lib/site.mjs";

export default createMDX()({
  basePath,
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  devIndicators: false,
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".js", ".ts", ".tsx"],
    };
    return config;
  },
});
