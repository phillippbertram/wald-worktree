import { TreePine } from "lucide-react";

export function WaldMark() {
  return (
    <span className="wald-mark">
      <span className="wald-mark-icon">
        <TreePine aria-hidden="true" size={17} strokeWidth={2.35} />
      </span>
      <span>Wald</span>
    </span>
  );
}
