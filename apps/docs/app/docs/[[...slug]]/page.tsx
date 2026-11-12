import defaultComponents from "fumadocs-ui/mdx";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ComponentProps } from "react";
import { Demo } from "../../../components/demo.js";
import { asset, repository } from "../../../lib/site.mjs";
import { source } from "../../../lib/source.js";

type PageProps = { params: Promise<{ slug?: string[] }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: asset(page.url.endsWith("/") ? page.url : `${page.url}/`) },
  };
}

function DocLink({ href, ...props }: ComponentProps<"a">) {
  if (href?.startsWith("../skills/")) {
    return <a href={`${repository}/blob/main/${href.slice(3)}`} {...props} />;
  }
  if (href === "assets/wald-worktrees.png") {
    return <a href={asset("/media/wald-worktrees.webp")} {...props} />;
  }
  const Link = defaultComponents.a;
  return <Link href={href} {...props} />;
}

export default async function DocumentationPage({ params }: PageProps) {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  const { body: Content, toc, title, description } = page.data;
  const name = page.slugs[0];
  return (
    <DocsPage
      toc={toc}
      editOnGithub={{
        owner: "phillippbertram",
        repo: "wald-worktree",
        sha: "main",
        path: `docs/${page.path}`,
      }}
    >
      <DocsTitle>{title}</DocsTitle>
      <DocsDescription>{description}</DocsDescription>
      <DocsBody>
        <Content
          components={{
            ...defaultComponents,
            a: ({ href, ...props }) => {
              const relative =
                href && /^(?![a-z][a-z0-9+.-]*:|[/#.]).+\.mdx?(?:#|$)/i.test(href)
                  ? `./${href}`
                  : href;
              return (
                <DocLink
                  href={relative ? source.resolveHref(relative, page) : undefined}
                  {...props}
                />
              );
            },
          }}
        />
        {name === "getting-started" && <Demo id="create" />}
        {name === "agent-workflows" && <Demo id="parallel" />}
        {name === "finish" && (
          <div className="docs-demos">
            <Demo id="handoff" />
            <Demo id="cleanup" />
          </div>
        )}
      </DocsBody>
    </DocsPage>
  );
}
