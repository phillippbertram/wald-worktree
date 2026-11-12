import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "../../docs",
  docs: { files: ["**/!(brand).{md,mdx}"] },
});
export default defineConfig();
