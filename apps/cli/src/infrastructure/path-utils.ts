import path from "node:path";

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

export function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  return path.resolve(parent) === path.resolve(candidate) || isPathInside(parent, candidate);
}

export function humanizeRepositoryName(repository: string): string {
  const withoutTrailingSlash = repository.replace(/[\\/]+$/u, "");
  const lastPart = withoutTrailingSlash.split(/[\\/:]/u).at(-1) ?? "workspace";
  const name = lastPart.replace(/\.git$/u, "").trim();
  return name || "workspace";
}
