import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { basePath } from "../lib/site.mjs";

export const output = fileURLToPath(new URL("../out/", import.meta.url));

export async function exportedFile(pathname) {
  if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return null;
  const relative = decodeURIComponent(pathname.slice(basePath.length));
  const file = path.resolve(output, `.${relative}`);
  if (path.relative(output, file).startsWith("..")) return null;
  try {
    const info = await stat(file);
    if (info.isFile()) return file;
    if (info.isDirectory()) {
      const index = path.join(file, "index.html");
      if ((await stat(index)).isFile()) return index;
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  return null;
}
