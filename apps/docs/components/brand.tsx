import { TreePine } from "lucide-react";
import { brand } from "../lib/site.mjs";

export function WaldMark() {
  return (
    <span className="wald-mark">
      <span className="wald-mark-icon">
        <TreePine aria-hidden="true" size={17} strokeWidth={2.35} />
      </span>
      <span>{brand}</span>
    </span>
  );
}
