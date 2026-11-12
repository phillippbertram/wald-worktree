import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { basePath, siteUrl } from "../lib/site.mjs";
import { exportedFile, output } from "./static-files.mjs";

const manifest = JSON.parse(
  await readFile(new URL("../lib/demos.generated.json", import.meta.url), "utf8"),
);

const required = [
  "/index.html",
  "/404.html",
  "/docs/index.html",
  "/docs/getting-started/",
  "/sitemap.xml",
  "/wald.svg",
  "/.nojekyll",
  "/media/wald-social.jpg",
  "/search-index.json",
  ...Object.values(manifest.demos).flatMap((variants) =>
    Object.values(variants).map(({ file }) => `/demos/${file}`),
  ),
];

for (const entry of required) {
  assert(await exportedFile(basePath + entry), `Missing export: ${entry}`);
}

const searchIndex = await readFile(path.join(output, "search-index.json"), "utf8");
assert(JSON.parse(searchIndex), "Invalid search index");
assert(searchIndex.includes("Parallel coding agents"), "Agent guide missing from search index");

const documents = new Map();
for (const file of await readdir(output, { recursive: true })) {
  if (file.endsWith(".html")) {
    const fullPath = path.join(output, file);
    documents.set(fullPath, await readFile(fullPath, "utf8"));
  }
}

const failures = new Set();
for (const [file, html] of documents) {
  const page = path.relative(output, file).replace(/index\.html$/, "");
  for (const [, href] of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    const url = new URL(href.replaceAll("&amp;", "&"), `${siteUrl + basePath}/${page}`);
    if (url.origin !== siteUrl) continue;
    const target = await exportedFile(url.pathname);
    if (!target) {
      failures.add(`${page} → ${href}`);
      continue;
    }
    if (url.hash && documents.has(target)) {
      const id = decodeURIComponent(url.hash.slice(1));
      if (!documents.get(target).includes(`id="${id}"`)) {
        failures.add(`${page} → ${href}`);
      }
    }
  }
}
assert.equal(failures.size, 0, `Broken links or assets:\n${[...failures].join("\n")}`);
console.log(`Checked ${documents.size} exported pages, assets, anchors, and the search index.`);
