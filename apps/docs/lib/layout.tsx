import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { WaldMark } from "../components/brand.js";
import { repository } from "./site.mjs";

export const layoutOptions: BaseLayoutProps = {
  nav: { title: <WaldMark />, url: "/" },
  githubUrl: repository,
  links: [
    { text: "Docs", url: "/docs" },
    { text: "Get started", url: "/docs/getting-started" },
  ],
};
