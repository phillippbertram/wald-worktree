import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { basePath } from "../lib/site.mjs";
import { exportedFile, output } from "./static-files.mjs";

const contentTypes = {
  ".cast": "application/x-ndjson",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};

const port = Number(process.env.WALD_DOCS_PORT ?? 4137);
createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const file = await exportedFile(url.pathname);
    if (
      file?.endsWith("/index.html") &&
      !url.pathname.endsWith("/") &&
      !url.pathname.endsWith(".html")
    ) {
      response.writeHead(308, { location: `${url.pathname}/${url.search}` }).end();
      return;
    }
    const target = file ?? path.join(output, "404.html");
    response.writeHead(file ? 200 : 404, {
      "Content-Type": contentTypes[path.extname(target)] ?? "application/octet-stream",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(target);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  } catch {
    response.writeHead(400).end();
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Wald docs at http://127.0.0.1:${port}${basePath}/`);
});
