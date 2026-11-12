import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expectedVersion = readFileSync(
  new URL("../../../.bun-version", import.meta.url),
  "utf8",
).trim();
const executable = process.env.BUN_BINARY || "bun";
const version = spawnSync(executable, ["--version"], { encoding: "utf8" });
if (version.status !== 0 || version.stdout.trim() !== expectedVersion) {
  console.error(
    `Bun ${expectedVersion} is required for the binary prototype. Install that version or set BUN_BINARY to its executable path.`,
  );
  process.exit(1);
}

const result = spawnSync(
  executable,
  [
    "build",
    "--compile",
    "--minify",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-tsconfig",
    "--no-compile-autoload-package-json",
    "src/cli.ts",
    "--outfile",
    "dist/binary/wald",
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
