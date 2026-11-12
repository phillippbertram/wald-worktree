import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { layoutOptions } from "../../lib/layout.js";
import { source } from "../../lib/source.js";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout {...layoutOptions} links={[]} tree={source.getPageTree()}>
      {children}
    </DocsLayout>
  );
}
