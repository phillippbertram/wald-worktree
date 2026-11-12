import { cpSync, rmSync } from "node:fs";

const source = new URL("../../../skills/", import.meta.url);
const target = new URL("../skills/", import.meta.url);
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
